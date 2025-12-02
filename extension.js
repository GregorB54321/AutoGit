const vscode = require('vscode');
const { exec } = require('child_process');
const path = require('path');
const { promisify } = require('util');

const execAsync = promisify(exec);

let isEnabled = false;
let statusBarItem;
let pendingTimeout;
let workspacePath;
let fileSystemWatcher;
let changeTracker = new Set();
let lastCheckTime = 0;


// ToDo: push to default remote repo? (false if no repo given, else true), try to login...

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
    console.log('Auto Git with Copilot extension is activating...');
    
    try {
        // Get workspace
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders || workspaceFolders.length === 0) {
            console.log('Auto Git: No workspace folder found');
            vscode.window.showWarningMessage('Auto Git: No workspace folder found');
            return;
        }

        workspacePath = workspaceFolders[0].uri.fsPath;
        
        // [FIX] Try to set workspacePath to the active editor's folder if available
        if (vscode.window.activeTextEditor) {
            const activeFolder = vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri);
            if (activeFolder) {
                workspacePath = activeFolder.uri.fsPath;
            }
        }
        
        console.log('Auto Git: Workspace initialized:', workspacePath);

        // [FIX] Initial check: Is this a git repo? If not, don't error out immediately, just warn log.
        // We wait for file events to find the real repo.
        execAsync('git rev-parse --git-dir', { cwd: workspacePath })
            .then(() => console.log('Auto Git: Initial path is a valid git repo'))
            .catch(() => console.log('Auto Git: Initial path is NOT a git repo (yet). Waiting for file activity.'));

        // Create status bar item
        statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
        statusBarItem.command = 'autoGitCopilot.toggle';
        updateStatusBar();
        statusBarItem.show();
        context.subscriptions.push(statusBarItem);
        console.log('Auto Git: Status bar item created');

        // Get initial configuration
        const config = vscode.workspace.getConfiguration('autoGitCopilot');
        isEnabled = config.get('enabled', false);
        console.log('Auto Git: Initial enabled state:', isEnabled);

        // Register commands
        const toggleCommand = vscode.commands.registerCommand('autoGitCopilot.toggle', () => {
            try {
                isEnabled = !isEnabled;
                const config = vscode.workspace.getConfiguration('autoGitCopilot');
                config.update('enabled', isEnabled, vscode.ConfigurationTarget.Workspace);
                updateStatusBar();
                
                // Start or stop file monitoring based on enabled state
                if (isEnabled) {
                    startFileMonitoring();
                } else {
                    stopFileMonitoring();
                }
                
                vscode.window.showInformationMessage(`Auto Git ${isEnabled ? 'enabled' : 'disabled'}`);
                console.log(`Auto Git toggled: ${isEnabled ? 'enabled' : 'disabled'}`);
            } catch (error) {
                console.error('Error in toggle command:', error);
                vscode.window.showErrorMessage(`Auto Git toggle failed: ${error.message}`);
            }
        });

        const commitNowCommand = vscode.commands.registerCommand('autoGitCopilot.commitNow', () => {
            try {
                if (pendingTimeout) {
                    clearTimeout(pendingTimeout);
                    pendingTimeout = null;
                }
                vscode.window.showInformationMessage('Auto Git: Manual commit triggered');
                performGitOperations();
                console.log('Auto Git: Manual commit triggered');
            } catch (error) {
                console.error('Error in commit now command:', error);
                vscode.window.showErrorMessage(`Auto Git commit failed: ${error.message}`);
            }
        });

        // Add test command for debugging
        const testCommand = vscode.commands.registerCommand('autoGitCopilot.test', () => {
            try {
                vscode.window.showInformationMessage('Auto Git: Test command executed!');
                console.log('Auto Git: Test command executed successfully');
                console.log('Auto Git: Current enabled state:', isEnabled);
                console.log('Auto Git: Workspace path:', workspacePath);
                console.log('Auto Git: File system watcher active:', !!fileSystemWatcher);
                console.log('Auto Git: Changes tracked:', changeTracker.size);
            } catch (error) {
                console.error('Error in test command:', error);
            }
        });

        context.subscriptions.push(toggleCommand, commitNowCommand, testCommand);
        console.log('Auto Git: Commands registered successfully');

        // ALTERNATIVE APPROACH: Use multiple file change detection methods
        setupFileChangeDetection(context);

        // Register configuration change listener
        try {
            const configListener = vscode.workspace.onDidChangeConfiguration((e) => {
                if (e.affectsConfiguration('autoGitCopilot.enabled')) {
                    const config = vscode.workspace.getConfiguration('autoGitCopilot');
                    const newEnabled = config.get('enabled', false);
                    if (newEnabled !== isEnabled) {
                        isEnabled = newEnabled;
                        updateStatusBar();
                        
                        if (isEnabled) {
                            startFileMonitoring();
                        } else {
                            stopFileMonitoring();
                        }
                        
                        console.log(`Auto Git: Configuration changed, enabled: ${isEnabled}`);
                    }
                }
            });
            context.subscriptions.push(configListener);
            console.log('Auto Git: Configuration listener registered');
        } catch (configError) {
            console.error('Auto Git: Failed to register config listener:', configError);
        }

        console.log('Auto Git extension activation completed successfully');
        vscode.window.showInformationMessage('Auto Git with Copilot loaded successfully!');
        
        // Ensure status bar is up to date at the end of activation
        updateStatusBar();
        
    } catch (error) {
        console.error('Auto Git extension activation failed:', error);
        vscode.window.showErrorMessage(`Auto Git extension failed to load: ${error.message}`);
    }
}

function setupFileChangeDetection(context) {
    console.log('Auto Git: Setting up alternative file change detection...');
    
    // Method 1: File System Watcher (watches for any file changes in workspace)
    try {
        // Watch all files except those in exclude patterns
        const pattern = new vscode.RelativePattern(workspacePath, '**/*');
        fileSystemWatcher = vscode.workspace.createFileSystemWatcher(pattern);
        
        // Handle file changes
        fileSystemWatcher.onDidChange((uri) => {
            handleFileChange(uri, 'changed');
        });
        
        // Handle file creation
        fileSystemWatcher.onDidCreate((uri) => {
            handleFileChange(uri, 'created');
        });
        
        // Handle file deletion
        fileSystemWatcher.onDidDelete((uri) => {
            handleFileChange(uri, 'deleted');
        });
        
        context.subscriptions.push(fileSystemWatcher);
        console.log('Auto Git: File system watcher created successfully');
    } catch (fsWatcherError) {
        console.error('Auto Git: Failed to create file system watcher:', fsWatcherError);
    }
    
    // Method 2: Text Document Save Detection (detects when files are saved)
    try {
        // [CHANGE] Use onDidSaveTextDocument instead of onDidChangeTextDocument
        // to avoid triggering on every keystroke. Only trigger on save.
        const saveListener = vscode.workspace.onDidSaveTextDocument((document) => {
            if (document.uri.scheme === 'file') {
                handleFileChange(document.uri, 'saved');
            }
        });
        
        context.subscriptions.push(saveListener);
        console.log('Auto Git: Save listener created successfully');
    } catch (saveError) {
        console.error('Auto Git: Failed to create save listener:', saveError);
    }
    
    // Method 3: Periodic Git Status Check (fallback)
    const periodicCheck = setInterval(() => {
        if (isEnabled && changeTracker.size > 0) {
            const now = Date.now();
            // Check if enough time has passed since last activity
            if (now - lastCheckTime > 5000) { // 5 seconds of inactivity
                console.log('Auto Git: Periodic check triggered git operations');
                scheduleGitOperations();
                changeTracker.clear();
            }
        }
    }, 10000); // Check every 10 seconds
    
    // Clean up interval on deactivation
    context.subscriptions.push({
        dispose: () => clearInterval(periodicCheck)
    });
    
    console.log('Auto Git: Alternative file change detection setup complete');
}

const fs = require('fs');

async function handleFileChange(uri, changeType) {
    if (!isEnabled) return;

    // [FIX] Ignore .git folder immediately to prevent loops and unnecessary processing
    if (uri.fsPath.includes(`${path.sep}.git${path.sep}`) || uri.fsPath.endsWith(`${path.sep}.git`)) {
        return;
    }
    
    console.debug(`Auto Git [DEBUG]: Handling file change for ${uri.fsPath}`);

    // [FIX] Update workspacePath to the real git root of the file
    const fileDir = path.dirname(uri.fsPath);
    let newWorkspacePath = null;

    // Strategy 1: Ask Git directly (Most reliable source of truth)
    try {
        console.debug(`Auto Git [DEBUG]: Asking git for root of ${fileDir}`);
        const { stdout } = await execAsync('git rev-parse --show-toplevel', { cwd: fileDir });
        const gitRoot = stdout.trim();
        if (gitRoot) {
            console.debug(`Auto Git [DEBUG]: Git reported root as ${gitRoot}`);
            newWorkspacePath = gitRoot;
        }
    } catch (error) {
        console.debug(`Auto Git [DEBUG]: Git detection failed for ${fileDir}:`, error.message);
    }

    // Strategy 2: Manual .git folder search (Fallback)
    if (!newWorkspacePath) {
        try {
            let currentDir = fileDir;
            const rootDir = path.parse(currentDir).root;
            console.debug(`Auto Git [DEBUG]: Starting manual search from ${currentDir}`);
            
            while (currentDir !== rootDir) {
                const gitPath = path.join(currentDir, '.git');
                if (fs.existsSync(gitPath)) {
                    console.debug(`Auto Git [DEBUG]: Found .git at ${gitPath}`);
                    newWorkspacePath = currentDir;
                    break;
                }
                const parentDir = path.dirname(currentDir);
                if (parentDir === currentDir) break; // Safety break
                currentDir = parentDir;
            }
        } catch (e) {
            console.debug('Auto Git [DEBUG]: Error checking .git folder:', e);
        }
    }

    // Apply the new workspace path
    if (newWorkspacePath) {
        if (newWorkspacePath !== workspacePath) {
            console.log(`Auto Git: Switching workspace context from ${workspacePath} to ${newWorkspacePath}`);
            workspacePath = newWorkspacePath;
            changeTracker.clear();
            
            // Re-enable if it was disabled, because we found a valid repo now!
            if (!isEnabled) {
                 // Note: We don't auto-enable here to respect user choice, 
                 // but we could update status bar to show it's ready.
            }
            // Force status bar update to reflect we are in a valid repo now
            updateStatusBar(); 
        }
    } else {
        console.debug(`Auto Git [DEBUG]: No git root found for ${uri.fsPath}. Ignoring file.`);
        // [CRITICAL FIX] If the file is not in a git repo, DO NOT schedule operations.
        // This prevents the extension from trying to run git commands in the root workspace folder
        // which might not be a git repo, causing the "Not a git repository" error.
        
        if (changeType === 'saved') {
            vscode.window.showWarningMessage(`Auto Git: File '${path.basename(uri.fsPath)}' is not in a git repository and will not be committed.`);
        }
        return;
    }

    // Check if file should be excluded
    const config = vscode.workspace.getConfiguration('autoGitCopilot');
    const excludePatterns = config.get('excludePatterns', []);
    
    // [FIX] relativePath calculation was wrong because workspacePath changes dynamically now.
    // We should check exclusion based on the filename or path relative to the git root.
    const relativePath = path.relative(workspacePath, uri.fsPath);
    const repoName = path.basename(workspacePath);
    
    const shouldExclude = excludePatterns.some(pattern => {
        try {
            // [FIX] Improved regex matching to handle simple wildcards better
            // If pattern is just "*.log", we want to match "file.log" anywhere
            let regexPattern;
            if (pattern.startsWith('*') && !pattern.includes('/')) {
                 // Simple extension match like "*.log" -> match end of string
                 regexPattern = pattern.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$';
            } else {
                 // Standard glob-like match
                 regexPattern = pattern.replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*');
            }
            
            const regex = new RegExp(regexPattern);
            // Check relative path, filename, AND repo name (to allow excluding whole repos)
            return regex.test(relativePath) || regex.test(path.basename(uri.fsPath)) || regex.test(repoName);
        } catch (regexError) {
            console.warn(`Auto Git: Invalid pattern ${pattern}:`, regexError);
            return false;
        }
    });

    if (shouldExclude) {
        console.log(`Auto Git: Excluding file ${relativePath} (${changeType})`);
        if (changeType === 'saved') {
            vscode.window.showWarningMessage(`Auto Git: File '${path.basename(uri.fsPath)}' is excluded by pattern and will not be committed.`);
        }
        return;
    }

    console.log(`Auto Git: File ${changeType}: ${relativePath}`);
    
    // Track the change
    changeTracker.add(relativePath);
    lastCheckTime = Date.now();
    
    // Schedule git operations
    scheduleGitOperations();
}

function scheduleGitOperations() {
    // Debounce git operations
    if (pendingTimeout) {
        clearTimeout(pendingTimeout);
    }

    const config = vscode.workspace.getConfiguration('autoGitCopilot');
    const delay = config.get('delayMs', 3000);
    
    if (statusBarItem) {
        statusBarItem.text = `$(sync~spin) Auto Git: Pending...`;
    }
    
    pendingTimeout = setTimeout(() => {
        performGitOperations();
        pendingTimeout = null;
        changeTracker.clear();
    }, delay);
}

function startFileMonitoring() {
    console.log('Auto Git: Starting file monitoring');
    changeTracker.clear();
    lastCheckTime = Date.now();
}

function stopFileMonitoring() {
    console.log('Auto Git: Stopping file monitoring');
    if (pendingTimeout) {
        clearTimeout(pendingTimeout);
        pendingTimeout = null;
    }
    changeTracker.clear();
    updateStatusBar();
}

function updateStatusBar() {
    if (!statusBarItem) return;
    
    console.debug(`Auto Git [DEBUG]: Updating status bar. Enabled: ${isEnabled}`);

    if (isEnabled) {
        statusBarItem.text = `$(git-branch) Auto Git: ON`;
        statusBarItem.tooltip = 'Auto Git is enabled. Click to disable.';
        statusBarItem.backgroundColor = undefined;
    } else {
        statusBarItem.text = `$(git-branch) Auto Git: OFF`;
        statusBarItem.tooltip = 'Auto Git is disabled. Click to enable.';
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    }
}

async function performGitOperations() {
    if (!workspacePath) {
        vscode.window.showErrorMessage('Auto Git: No workspace path');
        return;
    }

    try {
        if (statusBarItem) {
            statusBarItem.text = `$(sync~spin) Auto Git: Working...`;
        }
        
        console.log('Auto Git: Starting git operations...');
        
        // Check if we're in a git repository
        try {
            await execAsync('git rev-parse --git-dir', { cwd: workspacePath });
            console.log('Auto Git: Confirmed git repository');
        } catch (error) {
            console.error('Auto Git: Not a git repository at', workspacePath, ':', error);
            
            // [CHANGE] Do not disable extension globally, just skip this operation
            // isEnabled = false;
            // updateStatusBar();
            // vscode.window.showErrorMessage(`Auto Git: Disabled. Not a git repository at ${workspacePath}`);
            
            console.log(`Auto Git: Skipping operations because ${workspacePath} is not a git repo.`);
            return;
        }

        // ============================================================
        // [START] CHANGE: Always switch to branch "autocommit"
        // ============================================================
        try {
            // Get current branch
            const { stdout: currentBranch } = await execAsync('git branch --show-current', { cwd: workspacePath });
            
            if (currentBranch.trim() !== 'autocommit') {
                console.log('Auto Git: Switching to autocommit branch...');
                // Try checkout to 'autocommit'. 
                // If error (e.g. does not exist), create it with -b
                await execAsync('git checkout autocommit 2>/dev/null || git checkout -b autocommit', { cwd: workspacePath });
                console.log('Auto Git: Switched to autocommit branch');
            }
        } catch (branchError) {
            console.error('Auto Git: Failed to switch branch:', branchError);
            vscode.window.showErrorMessage(`Auto Git Error: Could not switch to branch 'autocommit': ${branchError.message}`);
            updateStatusBar();
            return; // Abort if branch switch fails
        }
        // ============================================================
        // [END] CHANGE
        // ============================================================




        // Get git status
        const { stdout: statusOutput } = await execAsync('git status --porcelain', { cwd: workspacePath });
        const hasChanges = statusOutput.trim().length > 0;
        
        if (!hasChanges) {
            console.log('Auto Git: No changes to commit');
            updateStatusBar();
            return;
        }

        console.log('Auto Git: Changes detected, proceeding with commit');

        // Stage files based on configuration
        const config = vscode.workspace.getConfiguration('autoGitCopilot');
        // [CHANGE] Default to false to prevent adding untracked files automatically
        const includeUntracked = config.get('includeUntracked', false);
        
        if (includeUntracked) {
            await execAsync('git add .', { cwd: workspacePath });
            console.log('Auto Git: Staged all files including untracked');
        } else {
            // Only stage modified files (not untracked)
            await execAsync('git add -u', { cwd: workspacePath });
            console.log('Auto Git: Staged only tracked files');
        }

        // Generate commit message using Copilot
        const commitMessage = await generateCommitMessage(statusOutput);
        console.log(`Auto Git: Generated commit message: "${commitMessage}"`);
        
        // Commit changes with proper escaping
        const escapedMessage = commitMessage.replace(/"/g, '\\"').replace(/'/g, "\\'").replace(/`/g, '\\`');
        await execAsync(`git commit -m "${escapedMessage}"`, { cwd: workspacePath });
        console.log('Auto Git: Changes committed successfully');
        
        // Push changes (DISABLED)
        // await execAsync('git push', { cwd: workspacePath });
        // console.log('Auto Git: Changes pushed successfully');
        
        vscode.window.showInformationMessage(`Auto Git: Committed: "${commitMessage}"`);
        updateStatusBar();
        
    } catch (error) {
        console.error('Auto Git error:', error);
        let errorMessage = error.message;
        
        // Provide more helpful error messages
        if (errorMessage.includes('nothing to commit')) {
            console.log('Auto Git: Nothing to commit (already up to date)');
            updateStatusBar();
            } else if (errorMessage.includes('Insufficient permission') || errorMessage.includes('Access is denied')) {
                errorMessage = `FileSystem Error: Missing write permissions in .git folder at ${workspacePath}/.git. Please check permissions (e.g. using chown/chmod).`;
        } else if (errorMessage.includes('Permission denied') || errorMessage.includes('authentication')) {
            errorMessage = 'Git authentication failed. Check your SSH keys or credentials.';
        } else if (errorMessage.includes('remote rejected')) {
            errorMessage = 'Push rejected by remote. You may need to pull first.';
        } else if (errorMessage.includes('non-zero exit code')) {
            errorMessage = 'Git operation failed. Check repository status.';
        }
        
        vscode.window.showErrorMessage(`Auto Git error: ${errorMessage}`);
        updateStatusBar();
    }
}

async function generateCommitMessage(statusOutput) {
    try {
        // Parse git status output
        const lines = statusOutput.trim().split('\n').filter(line => line.trim());
        const changedFiles = lines.map(line => {
            const status = line.substring(0, 2);
            // [FIX] Use substring(2).trim() instead of substring(3) to be more robust
            // This handles cases where whitespace might be different or missing,
            // and prevents cutting off the first character of the filename.
            const filename = line.substring(2).trim();
            return {
                path: filename,
                status: getFileStatusFromCode(status)
            };
        });

        if (changedFiles.length === 0) {
            return 'Auto-commit: Update files';
        }

        // [CHANGE] Fetch git diff to provide better context for the AI
        let diffOutput = '';
        try {
            // Files are already staged at this point, so we use --cached to see what will be committed
            const { stdout } = await execAsync('git diff --cached', { cwd: workspacePath });
            diffOutput = stdout || '';
            
            // Truncate diff if it's too large (approx 20KB) to avoid token limits
            if (diffOutput.length > 20000) {
                diffOutput = diffOutput.substring(0, 20000) + '\n...(Diff truncated)...';
            }
        } catch (diffError) {
            console.warn('Auto Git: Failed to fetch git diff:', diffError);
        }

        // Create context for Copilot
        const config = vscode.workspace.getConfiguration('autoGitCopilot');
        let promptTemplate = config.get('commitMessagePrompt');
        
        const fileSummary = changedFiles.map(f => `${f.status}: ${f.path}`).join('\n');
        // Combine summary and diff
        const fileChanges = diffOutput ? `${fileSummary}\n\nDIFF:\n${diffOutput}` : fileSummary;

        if (!promptTemplate) {
            promptTemplate = `
            Create a Git commit message that follows best practices.

            The message should consist of a subject line and an optional but recommended body.

            FORMAT RULES:
            - The subject line MUST be imperative (e.g. ‘Fix bug’, ‘Add feature’).
            - The subject line MUST be limited to 50 characters.
            - The body MUST explain WHY this change is necessary and HOW it solves the problem.
            - The body MUST be wrapped at 72 characters per line.

            CODE DESCRIPTION:
            {file_changes}
            `;
        }

        let context = promptTemplate;
        if (context.includes('{file_changes}')) {
            context = context.replace('{file_changes}', fileChanges);
        } else {
            context = `${context}\n\nCODE DESCRIPTION:\n${fileChanges}`;
        }

        console.log('Auto Git: Attempting to generate AI commit message...');

        // Try to use Copilot Chat API
        try {
            if (vscode.lm && typeof vscode.lm.selectChatModels === 'function') {
                const models = await vscode.lm.selectChatModels({
                    vendor: 'copilot',
                    family: 'gpt-4'
                });

                if (models && models.length > 0) {
                    console.log('Auto Git: Copilot model found, generating message...');
                    const model = models[0];
                    const messages = [
                        vscode.LanguageModelChatMessage.User(context)
                    ];

                    const response = await model.sendRequest(messages, {}, new vscode.CancellationTokenSource().token);
                    
                    let commitMessage = '';
                    for await (const fragment of response.text) {
                        commitMessage += fragment;
                    }

                    // Clean up the response
                    commitMessage = commitMessage.trim();
                    
                    // Remove quotes if present
                    if ((commitMessage.startsWith('"') && commitMessage.endsWith('"')) ||
                        (commitMessage.startsWith("'") && commitMessage.endsWith("'"))) {
                        commitMessage = commitMessage.slice(1, -1);
                    }

                    // Remove any remaining quotes or backticks
                    commitMessage = commitMessage.replace(/["`']/g, '');

                    // Ensure it's not too long
                    const config = vscode.workspace.getConfiguration('autoGitCopilot');
                    const maxLength = config.get('maxCommitMessageLength', 72);
                    if (commitMessage.length > maxLength) {
                        commitMessage = commitMessage.substring(0, maxLength - 3) + '...';
                    }

                    if (commitMessage && commitMessage.length > 0) {
                        console.log('Auto Git: AI commit message generated successfully');
                        return commitMessage;
                    }
                } else {
                    console.log('Auto Git: No Copilot models available');
                }
            } else {
                console.log('Auto Git: Copilot Language Model API not available');
            }
        } catch (copilotError) {
            console.warn('Auto Git: Copilot API error:', copilotError.message);
        }
    } catch (error) {
        console.warn('Auto Git: Could not generate AI commit message:', error.message);
    }

    // Fallback to simple commit message
    console.log('Auto Git: Using fallback commit message');
    return generateFallbackCommitMessage(statusOutput);
}

function generateFallbackCommitMessage(statusOutput) {
    const lines = statusOutput.trim().split('\n').filter(line => line.trim());
    
    let added = 0, modified = 0, deleted = 0;
    
    lines.forEach(line => {
        const status = line.substring(0, 2);
        if (status.includes('A') || status.includes('?')) added++;
        else if (status.includes('M')) modified++;
        else if (status.includes('D')) deleted++;
    });

    const parts = [];
    if (added > 0) parts.push(`${added} added`);
    if (modified > 0) parts.push(`${modified} modified`);
    if (deleted > 0) parts.push(`${deleted} deleted`);

    if (parts.length === 0) {
        return 'Auto-commit: Update files';
    }

    const fileCount = lines.length;
    return `Auto-commit: ${parts.join(', ')} file${fileCount === 1 ? '' : 's'}`;
}

function getFileStatusFromCode(statusCode) {
    // Git porcelain status codes
    if (statusCode.includes('A')) return 'Added';
    if (statusCode.includes('M')) return 'Modified';
    if (statusCode.includes('D')) return 'Deleted';
    if (statusCode.includes('R')) return 'Renamed';
    if (statusCode.includes('C')) return 'Copied';
    if (statusCode.includes('?')) return 'Untracked';
    return 'Changed';
}

function deactivate() {
    console.log('Auto Git extension deactivating...');
    
    if (pendingTimeout) {
        clearTimeout(pendingTimeout);
        pendingTimeout = null;
    }
    
    if (fileSystemWatcher) {
        fileSystemWatcher.dispose();
        fileSystemWatcher = null;
    }
    
    changeTracker.clear();
    console.log('Auto Git extension deactivated');
}

module.exports = {
    activate,
    deactivate
};


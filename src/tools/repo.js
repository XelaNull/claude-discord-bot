const { execFileSync, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const config = require('../utils/config');
const { getWorkspace, checkWorkspaceQuota } = require('../utils/workspace');
const { analyzeLog, renderForLLM } = require('../utils/log-analyzer');
const { getRepoDir, validatePath } = require('../utils/paths');

// Allowlist for the `shell` tool — only the leading command is validated.
// Piped/chained commands after |, &&, ||, ; are allowed freely.
// Edit this array to add or remove allowed commands.
const SHELL_ALLOWLIST = [
  // -- Filesystem & navigation --
  'ls', 'find', 'tree', 'cat', 'head', 'tail', 'wc', 'du', 'df', 'file',
  'stat', 'touch', 'mkdir', 'cp', 'mv', 'rm', 'ln', 'chmod', 'basename', 'dirname',
  'realpath', 'readlink',

  // -- Text processing --
  'grep', 'egrep', 'fgrep', 'sed', 'awk', 'sort', 'uniq', 'cut', 'tr', 'tee',
  'diff', 'patch', 'xargs', 'comm', 'paste', 'fold', 'fmt', 'column', 'expand',
  'unexpand', 'nl', 'rev', 'strings',

  // -- Search --
  'which', 'whereis', 'locate', 'type',

  // -- Archive & compression --
  'tar', 'gzip', 'gunzip', 'zip', 'unzip', 'bzip2', 'xz',

  // -- Networking (read-only) --
  'curl', 'wget', 'ping', 'dig', 'host', 'nslookup',

  // -- Version control --
  'git',

  // -- Node.js / JavaScript --
  'node', 'npm', 'npx', 'yarn', 'pnpm', 'tsc', 'eslint', 'prettier', 'jest', 'vitest', 'mocha',

  // -- Python --
  'python', 'python3', 'pip', 'pip3', 'pytest', 'pylint', 'black', 'mypy', 'ruff', 'uv',

  // -- Build tools --
  'make', 'cmake', 'cargo', 'go', 'dotnet', 'gradle', 'mvn', 'ant',

  // -- Shells / scripting --
  'bash', 'sh', 'env', 'echo', 'printf', 'true', 'false', 'test', 'expr',
  'date', 'sleep', 'timeout',

  // -- System info --
  'uname', 'whoami', 'id', 'hostname', 'pwd', 'printenv',
];

// Extract the leading command from a shell input string.
// Handles: "npm test", "  npm test", "FOO=bar npm test", "/usr/bin/node script.js"
function extractLeadingCommand(input) {
  const trimmed = input.trim();

  // Skip env var assignments at the start (e.g., "FOO=bar npm test")
  const parts = trimmed.split(/\s+/);
  let cmdPart = null;
  for (const part of parts) {
    if (part.includes('=') && !part.startsWith('-')) continue; // skip VAR=val
    cmdPart = part;
    break;
  }

  if (!cmdPart) return null;

  // Strip path prefix (e.g., "/usr/bin/node" → "node", "./script.sh" → "script.sh")
  const basename = cmdPart.split('/').pop();
  return basename || null;
}

const tools = [
  {
    name: 'repo_clone',
    description: 'Clone a GitHub repository to local scratch space for analysis. If already cloned, pulls latest changes.',
    input_schema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository in owner/repo format' },
        branch: { type: 'string', description: 'Branch to clone (default: default branch)' }
      },
      required: ['repo']
    },
    handler: async (args, context) => {
      const repoDir = getRepoDir(args.repo);
      fs.mkdirSync(config.scratchDir, { recursive: true });

      if (fs.existsSync(repoDir)) {
        // Already cloned — pull latest (Phase 1 fix: timeout on git pull)
        try {
          execFileSync('git', ['pull'], {
            cwd: repoDir,
            timeout: 60000,
            stdio: 'pipe'
          });
          return JSON.stringify({ status: 'updated', path: repoDir });
        } catch (err) {
          return JSON.stringify({ status: 'pull_failed', error: err.message, path: repoDir });
        }
      }

      // Phase 1 fix: execFileSync instead of execSync (no shell injection)
      const cloneArgs = ['clone', '--depth', '1'];
      if (args.branch) cloneArgs.push('--branch', args.branch);

      // Use PAT for auth if available
      const [owner, repo] = args.repo.split('/');
      let url = `https://github.com/${owner}/${repo}.git`;
      if (context && context.token) {
        url = `https://x-access-token:${context.token}@github.com/${owner}/${repo}.git`;
      }
      cloneArgs.push(url, repoDir);

      execFileSync('git', cloneArgs, { timeout: 120000, stdio: 'pipe' });

      return JSON.stringify({ status: 'cloned', path: repoDir });
    }
  },

  {
    name: 'repo_list',
    description: 'List files in a cloned repository directory.',
    input_schema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository in owner/repo format' },
        path: { type: 'string', description: 'Subdirectory path (default: root)' },
        recursive: { type: 'boolean', description: 'List recursively (default: false)' }
      },
      required: ['repo']
    },
    handler: async (args) => {
      const repoDir = getRepoDir(args.repo);

      if (!fs.existsSync(repoDir)) {
        throw new Error('Repository not cloned. Use repo_clone first.');
      }

      const targetDir = args.path ? validatePath(repoDir, args.path) : repoDir;

      if (args.recursive) {
        const files = [];
        function walk(dir, prefix) {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.name === '.git') continue;
            const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (entry.isDirectory()) {
              walk(path.join(dir, entry.name), rel);
            } else {
              files.push(rel);
            }
          }
        }
        walk(targetDir, '');
        return JSON.stringify(files);
      }

      const entries = fs.readdirSync(targetDir, { withFileTypes: true });
      const result = entries
        .filter(e => e.name !== '.git')
        .map(e => ({
          name: e.name,
          type: e.isDirectory() ? 'dir' : 'file'
        }));

      return JSON.stringify(result, null, 2);
    }
  },

  {
    name: 'repo_read',
    description: 'Read the contents of a file from a cloned repository.',
    input_schema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository in owner/repo format' },
        path: { type: 'string', description: 'File path relative to repo root' },
        start_line: { type: 'integer', description: 'Start line (1-based, default: 1)' },
        end_line: { type: 'integer', description: 'End line (inclusive, default: end of file)' }
      },
      required: ['repo', 'path']
    },
    handler: async (args) => {
      const repoDir = getRepoDir(args.repo);
      const filePath = validatePath(repoDir, args.path);

      if (!fs.existsSync(filePath)) {
        throw new Error(`File not found: ${args.path}`);
      }

      let content = fs.readFileSync(filePath, 'utf8');

      if (args.start_line || args.end_line) {
        const lines = content.split('\n');
        const start = (args.start_line || 1) - 1;
        const end = args.end_line || lines.length;
        content = lines.slice(start, end).join('\n');
      }

      // Truncate very large files
      if (content.length > 100000) {
        content = content.substring(0, 100000) + '\n\n[... truncated (file too large) ...]';
      }

      return content;
    }
  },

  // === Phase 8: Codebase Analyzer ===

  {
    name: 'repo_analyze',
    description: 'Analyze a cloned repository to detect package manager, framework, language, test runner, CI config, and entry points.',
    input_schema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository in owner/repo format' }
      },
      required: ['repo']
    },
    handler: async (args) => {
      const repoDir = getRepoDir(args.repo);
      if (!fs.existsSync(repoDir)) {
        throw new Error('Repository not cloned. Use repo_clone first.');
      }

      const result = {
        languages: [],
        package_manager: null,
        framework: null,
        test_runner: null,
        ci: [],
        entry_points: [],
        has_readme: false,
        has_license: false,
        file_count: 0,
        structure: []
      };

      const rootFiles = fs.readdirSync(repoDir);
      result.structure = rootFiles.filter(f => f !== '.git');

      // Detect package manager & language
      if (rootFiles.includes('package.json')) {
        result.package_manager = rootFiles.includes('yarn.lock') ? 'yarn'
          : rootFiles.includes('pnpm-lock.yaml') ? 'pnpm' : 'npm';
        result.languages.push('JavaScript/TypeScript');

        try {
          const pkg = JSON.parse(fs.readFileSync(path.join(repoDir, 'package.json'), 'utf8'));
          result.entry_points.push(pkg.main || 'index.js');
          if (pkg.scripts?.start) result.entry_points.push(`npm start: ${pkg.scripts.start}`);

          // Detect framework
          const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
          if (allDeps.next) result.framework = 'Next.js';
          else if (allDeps.react) result.framework = 'React';
          else if (allDeps.vue) result.framework = 'Vue';
          else if (allDeps.express) result.framework = 'Express';
          else if (allDeps.fastify) result.framework = 'Fastify';
          else if (allDeps.nest || allDeps['@nestjs/core']) result.framework = 'NestJS';

          // Detect test runner
          if (allDeps.jest) result.test_runner = 'Jest';
          else if (allDeps.vitest) result.test_runner = 'Vitest';
          else if (allDeps.mocha) result.test_runner = 'Mocha';
        } catch (_) {}
      }
      if (rootFiles.includes('requirements.txt') || rootFiles.includes('setup.py') || rootFiles.includes('pyproject.toml')) {
        result.languages.push('Python');
        result.package_manager = result.package_manager || 'pip';
        if (rootFiles.includes('pyproject.toml')) {
          try {
            const content = fs.readFileSync(path.join(repoDir, 'pyproject.toml'), 'utf8');
            if (content.includes('pytest')) result.test_runner = result.test_runner || 'pytest';
            if (content.includes('poetry')) result.package_manager = 'poetry';
          } catch (_) {}
        }
      }
      if (rootFiles.includes('go.mod')) {
        result.languages.push('Go');
        result.package_manager = result.package_manager || 'go modules';
      }
      if (rootFiles.includes('Cargo.toml')) {
        result.languages.push('Rust');
        result.package_manager = result.package_manager || 'cargo';
      }
      if (rootFiles.includes('pom.xml') || rootFiles.includes('build.gradle')) {
        result.languages.push('Java');
        result.package_manager = rootFiles.includes('pom.xml') ? 'maven' : 'gradle';
      }
      if (rootFiles.find(f => f.endsWith('.csproj') || f.endsWith('.sln'))) {
        result.languages.push('C#');
        result.package_manager = result.package_manager || 'dotnet';
      }

      // Detect CI
      if (rootFiles.includes('.github')) {
        try {
          const workflows = path.join(repoDir, '.github', 'workflows');
          if (fs.existsSync(workflows)) {
            result.ci.push('GitHub Actions');
          }
        } catch (_) {}
      }
      if (rootFiles.includes('.gitlab-ci.yml')) result.ci.push('GitLab CI');
      if (rootFiles.includes('Jenkinsfile')) result.ci.push('Jenkins');
      if (rootFiles.includes('.circleci')) result.ci.push('CircleCI');
      if (rootFiles.includes('.travis.yml')) result.ci.push('Travis CI');

      // Misc
      result.has_readme = rootFiles.some(f => f.toLowerCase().startsWith('readme'));
      result.has_license = rootFiles.some(f => f.toLowerCase().startsWith('license'));

      // Count files
      let count = 0;
      function countFiles(dir) {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const e of entries) {
          if (e.name === '.git' || e.name === 'node_modules' || e.name === 'vendor') continue;
          if (e.isDirectory()) countFiles(path.join(dir, e.name));
          else count++;
        }
      }
      countFiles(repoDir);
      result.file_count = count;

      return JSON.stringify(result, null, 2);
    }
  },

  // === Phase 8: Error Parser ===

  {
    name: 'parse_error',
    description: 'Parse a stack trace or error message to extract file paths, line numbers, error type, and error message. Supports JS, Python, Java, Go, Rust, C#.',
    input_schema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository in owner/repo format (to cross-reference file paths)' },
        error_text: { type: 'string', description: 'The full error output or stack trace' }
      },
      required: ['error_text']
    },
    handler: async (args) => {
      const errorText = args.error_text;
      const result = {
        error_type: null,
        error_message: null,
        frames: [],
        relevant_files: []
      };

      // Extract error type and message
      const errorLine = errorText.match(/^(\w+(?:Error|Exception|Panic)?):\s*(.+)$/m);
      if (errorLine) {
        result.error_type = errorLine[1];
        result.error_message = errorLine[2];
      }

      // JS/Node stack traces: at functionName (file:line:col) or at file:line:col
      const jsFrames = errorText.matchAll(/at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?/g);
      for (const m of jsFrames) {
        result.frames.push({
          function: m[1] || null,
          file: m[2],
          line: parseInt(m[3]),
          column: parseInt(m[4])
        });
      }

      // Python: File "path", line N, in function
      const pyFrames = errorText.matchAll(/File "(.+?)", line (\d+)(?:, in (.+))?/g);
      for (const m of pyFrames) {
        result.frames.push({
          file: m[1],
          line: parseInt(m[2]),
          function: m[3] || null,
          column: null
        });
      }

      // Go: file.go:line
      const goFrames = errorText.matchAll(/\t(.+?\.go):(\d+)/g);
      for (const m of goFrames) {
        result.frames.push({ file: m[1], line: parseInt(m[2]), function: null, column: null });
      }

      // Java/C#: at package.Class.method(File.java:line)
      const javaFrames = errorText.matchAll(/at\s+(.+?)\((\w+\.\w+):(\d+)\)/g);
      for (const m of javaFrames) {
        result.frames.push({
          function: m[1],
          file: m[2],
          line: parseInt(m[3]),
          column: null
        });
      }

      // Rust: file.rs:line:col
      const rustFrames = errorText.matchAll(/-->\s+(.+?\.rs):(\d+):(\d+)/g);
      for (const m of rustFrames) {
        result.frames.push({
          file: m[1],
          line: parseInt(m[2]),
          column: parseInt(m[3]),
          function: null
        });
      }

      // Cross-reference with cloned repo if available
      if (args.repo) {
        const repoDir = getRepoDir(args.repo);
        if (fs.existsSync(repoDir)) {
          for (const frame of result.frames) {
            const candidate = path.join(repoDir, frame.file);
            if (fs.existsSync(candidate)) {
              result.relevant_files.push({
                path: frame.file,
                line: frame.line,
                exists: true
              });
            }
          }
          // Deduplicate
          const seen = new Set();
          result.relevant_files = result.relevant_files.filter(f => {
            const key = `${f.path}:${f.line}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });
        }
      }

      return JSON.stringify(result, null, 2);
    }
  },

  // === Shell — arbitrary command execution in per-user workspace ===

  {
    name: 'shell',
    description:
      'Execute an allowed shell command in the user\'s workspace directory. ' +
      'The leading command must be in the allowlist (common dev tools: git, node, npm, python, make, grep, etc). ' +
      'Pipes and chaining (|, &&) are supported. Use for running tests, building projects, or analysis tasks.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to execute' },
        repo: { type: 'string', description: 'Repository (owner/repo) — command runs in this workspace' },
        timeout: { type: 'number', description: 'Timeout in seconds (default: 60, max: 300)' }
      },
      required: ['command', 'repo']
    },
    handler: async (args, context) => {
      if (!context || !context.userId) {
        throw new Error('User context is required for shell execution.');
      }

      const [owner, repo] = args.repo.split('/');
      if (!owner || !repo) throw new Error('Invalid repo format. Expected "owner/repo".');

      const cwd = getWorkspace(context.userId, owner, repo);
      if (!fs.existsSync(cwd)) {
        throw new Error('Workspace not found. Use repo_clone first to set up the workspace.');
      }

      // Check quota BEFORE execution
      try {
        checkWorkspaceQuota(context.userId, owner, repo);
      } catch (quotaErr) {
        throw new Error(`Cannot execute: ${quotaErr.message}`);
      }

      // Validate leading command against allowlist
      const leadingCmd = extractLeadingCommand(args.command);
      if (!leadingCmd) {
        throw new Error('Could not parse a command from the input.');
      }
      if (!SHELL_ALLOWLIST.includes(leadingCmd)) {
        throw new Error(
          `Command "${leadingCmd}" is not in the shell allowlist. ` +
          `Allowed: ${SHELL_ALLOWLIST.join(', ')}`
        );
      }

      const timeoutSec = Math.min(args.timeout || 60, 300);
      const timeoutMs = timeoutSec * 1000;

      let stdout = '';
      let stderr = '';
      let exitCode = 0;

      try {
        stdout = execSync(args.command, {
          cwd,
          shell: true,
          timeout: timeoutMs,
          encoding: 'utf8',
          stdio: 'pipe',
          maxBuffer: 5 * 1024 * 1024,
          env: { ...process.env, HOME: cwd }
        });
      } catch (err) {
        exitCode = err.status || 1;
        stdout = err.stdout || '';
        stderr = err.stderr || '';
      }

      // Scrub PATs from output
      let output = (stdout + (stderr ? '\n--- stderr ---\n' + stderr : '')).trim();
      output = output.replace(/ghp_[A-Za-z0-9_]{36,}/g, '[REDACTED]');
      output = output.replace(/ghs_[A-Za-z0-9_]{36,}/g, '[REDACTED]');
      output = output.replace(/github_pat_[A-Za-z0-9_]{22,}/g, '[REDACTED]');

      // Truncate large output
      if (output.length > 50000) {
        output = output.substring(0, 50000) + '\n\n[... truncated ...]';
      }

      // Check quota AFTER execution and append warning if needed
      try {
        const { sizeBytes, limitBytes } = checkWorkspaceQuota(context.userId, owner, repo);
        const usagePercent = (sizeBytes / limitBytes * 100).toFixed(0);
        if (sizeBytes > limitBytes * 0.85) {
          const sizeMB = (sizeBytes / (1024 * 1024)).toFixed(1);
          output += `\n\n⚠️ WARNING: Workspace is at ${sizeMB}MB / ${config.maxWorkspaceSizeMB}MB quota (${usagePercent}%). Clean up before running more commands.`;
        }
      } catch (_) {
        // Over quota after execution — warn but don't fail
        output += `\n\n⚠️ ${_.message}`;
      }

      if (!output) output = '(no output)';

      return exitCode === 0
        ? output
        : `Command exited with code ${exitCode}:\n${output}`;
    }
  },

  // === Log Analyzer — streaming parser for large log files ===

  {
    name: 'analyze_log',
    description:
      'Analyze a downloaded log file for errors related to a specific mod. ' +
      'Uses streaming parsing — handles files up to 50MB efficiently with minimal memory. ' +
      'Returns a structured summary with deduplicated errors, LUA stack traces, and mod events. ' +
      'Use github_analyze_issue first to download log files, then call this with the file path.',
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the log file (from github_analyze_issue manifest)' },
        mod_name: { type: 'string', description: 'Mod name to filter for (e.g., "UsedPlus", "FS25_UsedPlus")' },
        context_before: { type: 'integer', description: 'Lines of context before each error (default: 3)' },
        context_after: { type: 'integer', description: 'Lines of context after each error (default: 5)' }
      },
      required: ['file_path', 'mod_name']
    },
    handler: async (args) => {
      // Validate path exists and is under scratch or workspaces
      const resolvedPath = path.resolve(args.file_path);
      const scratchResolved = path.resolve(config.scratchDir);
      const workspaceResolved = path.resolve(config.workspaceDir);

      if (!resolvedPath.startsWith(scratchResolved) && !resolvedPath.startsWith(workspaceResolved)) {
        throw new Error('Log file must be in scratch or workspace directory (path traversal blocked).');
      }

      const result = await analyzeLog(resolvedPath, args.mod_name, {
        contextBefore: args.context_before,
        contextAfter: args.context_after
      });

      // Render for LLM consumption
      const summary = renderForLLM(result);

      // Also include raw counts for the tool result metadata
      const metadata = {
        totalLines: result.totalLines,
        fileSizeMB: (result.fileSizeBytes / 1024 / 1024).toFixed(1),
        uniqueErrors: result.errors.size,
        totalErrorOccurrences: Array.from(result.errors.values()).reduce((s, e) => s + e.count, 0),
        uniqueWarnings: result.warnings.size,
        uniqueStacks: result.luaStacks.size,
        modMentions: result.modMentions,
        modsLoaded: result.modsLoaded.length
      };

      return JSON.stringify({ summary, metadata }, null, 2);
    }
  }
];

module.exports = { tools };

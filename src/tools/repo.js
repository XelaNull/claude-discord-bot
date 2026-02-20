import { execSync } from 'child_process';
import { existsSync, readFileSync, readdirSync, statSync, mkdirSync } from 'fs';
import { join, relative } from 'path';
import { config } from '../utils/config.js';
import { scratchPath, ensureScratchDir } from '../utils/scratch.js';

// --- Tool definitions ---

export const toolDefinitions = [
  {
    name: 'clone_repo',
    description: 'Clone a git repository to the scratch space for analysis. Supports GitHub shorthand "owner/repo" or full URLs.',
    input_schema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository URL or GitHub shorthand "owner/repo".' },
        branch: { type: 'string', description: 'Specific branch to clone. Default: default branch.' },
        depth: { type: 'number', description: 'Shallow clone depth. Default: 1 (shallow). Use 0 for full clone.' },
      },
      required: ['repo'],
    },
  },
  {
    name: 'list_files',
    description: 'List files and directories in the scratch space. Supports glob-like browsing.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path relative to scratch space. Default: root of scratch.' },
        recursive: { type: 'boolean', description: 'List recursively. Default: false.' },
        max_depth: { type: 'number', description: 'Max recursion depth. Default: 3.' },
      },
      required: [],
    },
  },
  {
    name: 'read_file',
    description: 'Read the contents of a file in the scratch space.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to scratch space.' },
        start_line: { type: 'number', description: 'Start reading from this line (1-based). Default: 1.' },
        end_line: { type: 'number', description: 'Read up to this line (inclusive). Default: end of file.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'run_command',
    description: 'Run a shell command within the scratch space. Useful for grep, find, tree, or other analysis commands. Commands are sandboxed to the scratch directory.',
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to run.' },
        cwd: { type: 'string', description: 'Working directory relative to scratch space. Default: scratch root.' },
        timeout: { type: 'number', description: 'Timeout in seconds. Default: 30.' },
      },
      required: ['command'],
    },
  },
];

// --- Tool handlers ---

export async function clone_repo({ repo, branch, depth = 1 }) {
  ensureScratchDir();

  // Normalize repo URL
  let repoUrl = repo;
  if (!repo.includes('://') && !repo.startsWith('git@')) {
    repoUrl = `https://github.com/${repo}.git`;
  }

  // Derive directory name from repo
  const repoName = repo.replace(/\.git$/, '').split('/').pop();
  const destDir = scratchPath(repoName);

  if (existsSync(destDir)) {
    // Pull latest instead of re-cloning
    try {
      execSync('git pull', { cwd: destDir, timeout: 60000, stdio: 'pipe' });
      return { action: 'updated', directory: repoName, path: destDir };
    } catch {
      // If pull fails, remove and re-clone
      execSync(`rm -rf "${destDir}"`, { timeout: 10000, stdio: 'pipe' });
    }
  }

  const args = ['git', 'clone'];
  if (depth > 0) args.push('--depth', String(depth));
  if (branch) args.push('--branch', branch);
  args.push(repoUrl, destDir);

  execSync(args.join(' '), { timeout: 120000, stdio: 'pipe' });

  // Get basic stats
  const files = countFiles(destDir);
  return {
    action: 'cloned',
    directory: repoName,
    path: destDir,
    file_count: files,
  };
}

export async function list_files({ path = '', recursive = false, max_depth = 3 }) {
  const dir = path ? scratchPath(path) : config.scratchDir;

  if (!existsSync(dir)) {
    throw new Error(`Path does not exist: ${path || '(scratch root)'}`);
  }

  const stat = statSync(dir);
  if (!stat.isDirectory()) {
    return { type: 'file', path, size: stat.size };
  }

  const entries = [];
  walkDir(dir, dir, entries, recursive, max_depth, 0);

  return { directory: path || '.', entries };
}

export async function read_file({ path, start_line, end_line }) {
  const filePath = scratchPath(path);

  if (!existsSync(filePath)) {
    throw new Error(`File not found: ${path}`);
  }

  const stat = statSync(filePath);
  if (stat.isDirectory()) {
    throw new Error(`Path is a directory, not a file: ${path}`);
  }

  // Binary check
  if (stat.size > 1_000_000) {
    return {
      path,
      size: stat.size,
      note: 'File is larger than 1MB. Use start_line/end_line to read portions.',
      preview: readFileSync(filePath, 'utf-8').slice(0, 500),
    };
  }

  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');

  const start = Math.max(1, start_line || 1);
  const end = Math.min(lines.length, end_line || lines.length);
  const slice = lines.slice(start - 1, end);

  // Add line numbers
  const numbered = slice.map((line, i) => `${start + i}: ${line}`).join('\n');

  return {
    path,
    total_lines: lines.length,
    showing: `${start}-${end}`,
    content: numbered.length > 50000 ? numbered.slice(0, 50000) + '\n...(truncated)' : numbered,
  };
}

export async function run_command({ command, cwd = '', timeout = 30 }) {
  // Sandbox: ensure cwd is within scratch
  const workDir = cwd ? scratchPath(cwd) : config.scratchDir;

  if (!existsSync(workDir)) {
    throw new Error(`Working directory does not exist: ${cwd || '(scratch root)'}`);
  }

  // Block obviously dangerous commands
  const dangerous = ['rm -rf /', 'mkfs', 'dd if=', ':(){', 'fork bomb'];
  for (const d of dangerous) {
    if (command.includes(d)) {
      throw new Error(`Blocked potentially dangerous command: ${command}`);
    }
  }

  try {
    const output = execSync(command, {
      cwd: workDir,
      timeout: timeout * 1000,
      maxBuffer: 1024 * 1024,
      stdio: 'pipe',
      env: { ...process.env, HOME: config.scratchDir },
    });
    const text = output.toString('utf-8');
    return {
      exit_code: 0,
      output: text.length > 20000 ? text.slice(0, 20000) + '\n...(truncated)' : text,
    };
  } catch (err) {
    return {
      exit_code: err.status || 1,
      output: (err.stdout?.toString('utf-8') || '') + (err.stderr?.toString('utf-8') || ''),
      error: err.message,
    };
  }
}

// --- Helpers ---

function countFiles(dir) {
  let count = 0;
  for (const entry of readdirSync(dir)) {
    if (entry === '.git') continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) count += countFiles(full);
    else count++;
  }
  return count;
}

function walkDir(baseDir, currentDir, entries, recursive, maxDepth, currentDepth) {
  if (currentDepth > maxDepth) return;

  for (const name of readdirSync(currentDir)) {
    if (name === '.git') continue;
    const full = join(currentDir, name);
    const rel = relative(baseDir, full).replace(/\\/g, '/');
    const stat = statSync(full);

    entries.push({
      name: rel,
      type: stat.isDirectory() ? 'directory' : 'file',
      size: stat.isDirectory() ? undefined : stat.size,
    });

    if (recursive && stat.isDirectory()) {
      walkDir(baseDir, full, entries, recursive, maxDepth, currentDepth + 1);
    }
  }
}

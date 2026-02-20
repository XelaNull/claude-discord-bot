import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { execSync } from 'child_process';
import { config } from '../utils/config.js';

// --- Tool definitions ---

export const toolDefinitions = [
  {
    name: 'self_read_source',
    description: 'Read one of the bot\'s own source files. Use this to understand current behavior before modifying.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the bot source root (e.g. "src/tools/github.js").' },
      },
      required: ['path'],
    },
  },
  {
    name: 'self_list_source',
    description: 'List the bot\'s own source files.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory relative to bot source root. Default: root.' },
      },
      required: [],
    },
  },
  {
    name: 'self_modify',
    description: 'Modify one of the bot\'s own source files. Use with caution — incorrect modifications could break the bot. The change is applied immediately to disk but requires a restart to take effect.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to bot source root.' },
        old_string: { type: 'string', description: 'The exact string to replace. Must match uniquely.' },
        new_string: { type: 'string', description: 'The replacement string.' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'self_write_source',
    description: 'Write a new source file or completely overwrite an existing one in the bot\'s source tree.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to bot source root.' },
        content: { type: 'string', description: 'Full file content.' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'self_restart',
    description: 'Trigger a bot restart. In Docker, this exits the process and the container auto-restarts. Optionally commits changes to git first.',
    input_schema: {
      type: 'object',
      properties: {
        commit_message: { type: 'string', description: 'If provided, commits all changes with this message before restarting.' },
        push: { type: 'boolean', description: 'Push to remote after committing. Default: false.' },
      },
      required: [],
    },
  },
];

// --- Helpers ---

function resolveSelfPath(relPath) {
  const resolved = join(config.botSourceDir, relPath).replace(/\\/g, '/');
  const normalizedBase = config.botSourceDir.replace(/\\/g, '/');
  if (!resolved.startsWith(normalizedBase)) {
    throw new Error(`Path traversal detected: ${relPath}`);
  }
  return resolved;
}

// --- Tool handlers ---

export async function self_read_source({ path }) {
  const filePath = resolveSelfPath(path);

  if (!existsSync(filePath)) {
    throw new Error(`Source file not found: ${path}`);
  }

  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');

  return {
    path,
    total_lines: lines.length,
    content: lines.map((line, i) => `${i + 1}: ${line}`).join('\n'),
  };
}

export async function self_list_source({ path = '' } = {}) {
  const dir = path ? resolveSelfPath(path) : config.botSourceDir;

  if (!existsSync(dir)) {
    throw new Error(`Directory not found: ${path || '(root)'}`);
  }

  const entries = [];
  walkSource(dir, dir, entries, 3, 0);
  return { directory: path || '.', entries };
}

export async function self_modify({ path, old_string, new_string }) {
  const filePath = resolveSelfPath(path);

  if (!existsSync(filePath)) {
    throw new Error(`Source file not found: ${path}`);
  }

  const content = readFileSync(filePath, 'utf-8');

  if (!content.includes(old_string)) {
    throw new Error(`old_string not found in ${path}`);
  }

  const count = content.split(old_string).length - 1;
  if (count > 1) {
    throw new Error(`old_string appears ${count} times. Provide a more specific match.`);
  }

  const newContent = content.replace(old_string, new_string);
  writeFileSync(filePath, newContent);

  return {
    path,
    action: 'modified',
    note: 'Change saved to disk. Use self_restart to apply.',
  };
}

export async function self_write_source({ path, content }) {
  const filePath = resolveSelfPath(path);

  const { mkdirSync } = await import('fs');
  const { dirname } = await import('path');
  mkdirSync(dirname(filePath), { recursive: true });

  writeFileSync(filePath, content);

  return {
    path,
    action: 'written',
    size: Buffer.byteLength(content),
    note: 'File saved. Use self_restart to apply if this affects runtime.',
  };
}

export async function self_restart({ commit_message, push = false } = {}) {
  const results = { actions: [] };

  if (commit_message) {
    try {
      execSync('git add -A', { cwd: config.botSourceDir, stdio: 'pipe' });
      execSync(`git commit -m "${commit_message.replace(/"/g, '\\"')}"`, {
        cwd: config.botSourceDir,
        stdio: 'pipe',
      });
      results.actions.push('committed');

      if (push) {
        execSync('git push', { cwd: config.botSourceDir, timeout: 30000, stdio: 'pipe' });
        results.actions.push('pushed');
      }
    } catch (err) {
      results.git_error = err.message;
    }
  }

  results.actions.push('restarting');
  results.note = 'Process will exit now. Docker will auto-restart the container.';

  // Give time for the response to be sent, then exit
  setTimeout(() => {
    console.log('[self-restart] Exiting process for restart...');
    process.exit(0);
  }, 2000);

  return results;
}

// --- Helpers ---

function walkSource(baseDir, currentDir, entries, maxDepth, depth) {
  if (depth > maxDepth) return;

  for (const name of readdirSync(currentDir)) {
    if (name === 'node_modules' || name === '.git' || name === '.env') continue;
    const full = join(currentDir, name);
    const rel = relative(baseDir, full).replace(/\\/g, '/');
    const stat = statSync(full);

    entries.push({
      name: rel,
      type: stat.isDirectory() ? 'directory' : 'file',
      size: stat.isDirectory() ? undefined : stat.size,
    });

    if (stat.isDirectory()) {
      walkSource(baseDir, full, entries, maxDepth, depth + 1);
    }
  }
}

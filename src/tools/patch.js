import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { scratchPath } from '../utils/scratch.js';

// --- Tool definitions ---

export const toolDefinitions = [
  {
    name: 'edit_file',
    description: 'Edit a file in the scratch space by replacing a specific string with new content. The old_string must match exactly (including whitespace/indentation).',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to scratch space.' },
        old_string: { type: 'string', description: 'The exact string to find and replace. Must be unique in the file.' },
        new_string: { type: 'string', description: 'The replacement string.' },
        replace_all: { type: 'boolean', description: 'Replace all occurrences. Default: false.' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  {
    name: 'write_file',
    description: 'Write or overwrite a file in the scratch space with the given content.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to scratch space.' },
        content: { type: 'string', description: 'The full file content to write.' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'apply_diff',
    description: 'Apply a unified diff/patch to a file in the scratch space.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to scratch space to patch.' },
        diff: { type: 'string', description: 'The unified diff content to apply.' },
      },
      required: ['path', 'diff'],
    },
  },
];

// --- Tool handlers ---

export async function edit_file({ path, old_string, new_string, replace_all = false }) {
  const filePath = scratchPath(path);

  if (!existsSync(filePath)) {
    throw new Error(`File not found: ${path}`);
  }

  let content = readFileSync(filePath, 'utf-8');

  if (!content.includes(old_string)) {
    // Try to help by showing nearby content
    const lines = content.split('\n');
    const preview = lines.slice(0, 20).join('\n');
    throw new Error(`old_string not found in file. First 20 lines:\n${preview}`);
  }

  if (!replace_all) {
    // Ensure old_string is unique
    const count = content.split(old_string).length - 1;
    if (count > 1) {
      throw new Error(`old_string appears ${count} times in the file. Use replace_all: true or provide a more specific string.`);
    }
  }

  const newContent = replace_all
    ? content.replaceAll(old_string, new_string)
    : content.replace(old_string, new_string);

  writeFileSync(filePath, newContent);

  return {
    path,
    action: replace_all ? 'replaced_all' : 'replaced',
    changes: replace_all ? content.split(old_string).length - 1 : 1,
  };
}

export async function write_file({ path, content }) {
  const filePath = scratchPath(path);

  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);

  return {
    path,
    action: 'written',
    size: Buffer.byteLength(content),
  };
}

export async function apply_diff({ path, diff }) {
  const filePath = scratchPath(path);

  if (!existsSync(filePath)) {
    throw new Error(`File not found: ${path}`);
  }

  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');

  // Parse unified diff
  const hunks = parseDiff(diff);
  if (hunks.length === 0) {
    throw new Error('Could not parse diff. Ensure it is in unified diff format.');
  }

  // Apply hunks in reverse order (so line numbers stay valid)
  const sortedHunks = hunks.sort((a, b) => b.oldStart - a.oldStart);

  for (const hunk of sortedHunks) {
    const { oldStart, removals, additions } = hunk;
    const startIdx = oldStart - 1; // Convert to 0-based

    // Verify context matches
    let lineIdx = startIdx;
    for (const line of removals) {
      if (lineIdx >= lines.length || lines[lineIdx] !== line) {
        throw new Error(`Diff context mismatch at line ${lineIdx + 1}. Expected: "${line}", Got: "${lines[lineIdx] || '(end of file)'}"`);
      }
      lineIdx++;
    }

    // Apply
    lines.splice(startIdx, removals.length, ...additions);
  }

  const newContent = lines.join('\n');
  writeFileSync(filePath, newContent);

  return {
    path,
    action: 'patched',
    hunks_applied: hunks.length,
  };
}

// --- Helpers ---

function parseDiff(diff) {
  const hunks = [];
  const lines = diff.split('\n');

  let i = 0;
  while (i < lines.length) {
    // Find hunk header
    const match = lines[i].match(/^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/);
    if (match) {
      const oldStart = parseInt(match[1], 10);
      const removals = [];
      const additions = [];

      i++;
      while (i < lines.length && !lines[i].startsWith('@@') && !lines[i].startsWith('diff ')) {
        if (lines[i].startsWith('-')) {
          removals.push(lines[i].slice(1));
        } else if (lines[i].startsWith('+')) {
          additions.push(lines[i].slice(1));
        } else if (lines[i].startsWith(' ')) {
          // Context line - include in both
          removals.push(lines[i].slice(1));
          additions.push(lines[i].slice(1));
        }
        i++;
      }

      hunks.push({ oldStart, removals, additions });
    } else {
      i++;
    }
  }

  return hunks;
}

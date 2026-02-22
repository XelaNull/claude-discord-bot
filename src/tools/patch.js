const fs = require('fs');
const path = require('path');
const { getRepoDir, validatePath } = require('../utils/paths');

const tools = [
  {
    name: 'file_edit',
    description: 'Edit a file by replacing a specific string with a new string. The old_string must match exactly and be unique in the file.',
    input_schema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository in owner/repo format' },
        path: { type: 'string', description: 'File path relative to repo root' },
        old_string: { type: 'string', description: 'Exact string to find and replace (must be unique in the file)' },
        new_string: { type: 'string', description: 'Replacement string' }
      },
      required: ['repo', 'path', 'old_string', 'new_string']
    },
    handler: async (args) => {
      const repoDir = getRepoDir(args.repo);
      const filePath = validatePath(repoDir, args.path);

      if (!fs.existsSync(filePath)) {
        throw new Error(`File not found: ${args.path}`);
      }

      let content = fs.readFileSync(filePath, 'utf8');
      const count = content.split(args.old_string).length - 1;

      if (count === 0) {
        throw new Error('old_string not found in file. Make sure it matches exactly including whitespace and indentation.');
      }
      if (count > 1) {
        throw new Error(`old_string found ${count} times. It must be unique. Include more surrounding context to make it unique.`);
      }

      content = content.replace(args.old_string, args.new_string);
      fs.writeFileSync(filePath, content);

      return `File edited successfully: ${args.path}`;
    }
  },

  {
    name: 'file_write',
    description: 'Create or overwrite a file with the given content. Creates parent directories as needed.',
    input_schema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository in owner/repo format' },
        path: { type: 'string', description: 'File path relative to repo root' },
        content: { type: 'string', description: 'File content to write' }
      },
      required: ['repo', 'path', 'content']
    },
    handler: async (args) => {
      const repoDir = getRepoDir(args.repo);
      const filePath = validatePath(repoDir, args.path);

      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, args.content);

      return `File written: ${args.path} (${args.content.length} bytes)`;
    }
  },

  {
    name: 'file_patch',
    description: 'Apply a unified diff patch to a file. Handles standard unified diff format including "No newline at end of file" markers.',
    input_schema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository in owner/repo format' },
        path: { type: 'string', description: 'File path relative to repo root' },
        diff: { type: 'string', description: 'Unified diff content to apply' }
      },
      required: ['repo', 'path', 'diff']
    },
    // Phase 1 fix: handle "\ No newline at end of file" and missing context lines
    handler: async (args) => {
      const repoDir = getRepoDir(args.repo);
      const filePath = validatePath(repoDir, args.path);

      if (!fs.existsSync(filePath)) {
        throw new Error(`File not found: ${args.path}`);
      }

      const original = fs.readFileSync(filePath, 'utf8');
      const lines = original.split('\n');
      const diffLines = args.diff.split('\n');

      const result = [];
      let lineIdx = 0;
      let trailingNewline = original.endsWith('\n');

      for (let i = 0; i < diffLines.length; i++) {
        const line = diffLines[i];

        // Skip diff headers
        if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('diff ')) continue;
        // Phase 1 fix: handle "no newline at end of file" marker
        if (line === '\\ No newline at end of file') {
          trailingNewline = false;
          continue;
        }

        // Hunk header
        if (line.startsWith('@@')) {
          const match = line.match(/@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/);
          if (match) {
            const startLine = parseInt(match[1]) - 1;
            // Copy lines before this hunk
            while (lineIdx < startLine) {
              result.push(lines[lineIdx++]);
            }
          }
          continue;
        }

        if (line.startsWith('-')) {
          lineIdx++; // skip removed line
        } else if (line.startsWith('+')) {
          result.push(line.substring(1)); // add new line
        } else {
          // Context line (starts with space or is empty)
          if (lineIdx < lines.length) {
            result.push(lines[lineIdx++]);
          }
        }
      }

      // Copy remaining lines after last hunk
      while (lineIdx < lines.length) {
        result.push(lines[lineIdx++]);
      }

      let output = result.join('\n');
      if (trailingNewline && !output.endsWith('\n')) {
        output += '\n';
      }

      fs.writeFileSync(filePath, output);

      return `Diff applied to ${args.path}`;
    }
  }
];

module.exports = { tools };

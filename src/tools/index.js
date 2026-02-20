/**
 * Tool registry — maps tool names to their definitions and handlers.
 * This is the single source of truth for all available tools.
 */

import * as github from './github.js';
import * as search from './search.js';
import * as repo from './repo.js';
import * as patch from './patch.js';
import * as self from './self.js';

// Collect all tool definitions
export const allToolDefinitions = [
  ...github.toolDefinitions,
  ...search.toolDefinitions,
  ...repo.toolDefinitions,
  ...patch.toolDefinitions,
  ...self.toolDefinitions,
];

// Map tool names to handler functions
const handlers = {
  // GitHub
  github_list_issues: github.github_list_issues,
  github_get_issue: github.github_get_issue,
  github_comment_issue: github.github_comment_issue,
  github_download_issue_files: github.github_download_issue_files,
  github_get_file: github.github_get_file,

  // Search
  web_search: search.web_search,
  web_fetch: search.web_fetch,

  // Repo
  clone_repo: repo.clone_repo,
  list_files: repo.list_files,
  read_file: repo.read_file,
  run_command: repo.run_command,

  // Patch
  edit_file: patch.edit_file,
  write_file: patch.write_file,
  apply_diff: patch.apply_diff,

  // Self-modification
  self_read_source: self.self_read_source,
  self_list_source: self.self_list_source,
  self_modify: self.self_modify,
  self_write_source: self.self_write_source,
  self_restart: self.self_restart,
};

/**
 * Execute a tool by name with the given input.
 * Returns the result as a JSON-serializable object.
 */
export async function executeTool(name, input) {
  const handler = handlers[name];
  if (!handler) {
    throw new Error(`Unknown tool: ${name}`);
  }

  console.log(`[tool] Executing: ${name}`, JSON.stringify(input).slice(0, 200));
  const start = Date.now();

  try {
    const result = await handler(input);
    const elapsed = Date.now() - start;
    console.log(`[tool] ${name} completed in ${elapsed}ms`);
    return result;
  } catch (err) {
    console.error(`[tool] ${name} failed:`, err.message);
    throw err;
  }
}

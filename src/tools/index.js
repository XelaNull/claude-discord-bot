const githubTools = require('./github');
const repoTools = require('./repo');
const patchTools = require('./patch');
const selfTools = require('./self');
const gitTools = require('./git');
const webTools = require('./web');

const allTools = [
  ...githubTools.tools,
  ...repoTools.tools,
  ...patchTools.tools,
  ...selfTools.tools,
  ...gitTools.tools,
  ...webTools.tools
];

// Build lookup map
const toolMap = new Map();
for (const tool of allTools) {
  toolMap.set(tool.name, tool);
}

// Tools that require a GitHub PAT
const PAT_REQUIRED_TOOLS = new Set([
  ...githubTools.tools.map(t => t.name),
  ...gitTools.tools.filter(t => ['git_commit', 'git_push'].includes(t.name)).map(t => t.name)
]);

function getToolDefinitions() {
  return allTools.map(({ name, description, input_schema }) => ({
    name, description, input_schema
  }));
}

async function executeTool(name, args, context) {
  const tool = toolMap.get(name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);

  if (PAT_REQUIRED_TOOLS.has(name) && !context.token) {
    throw new Error(
      'This tool requires a GitHub Personal Access Token. ' +
      'DM me your PAT (starts with ghp_ or github_pat_) to register it.'
    );
  }

  return await tool.handler(args, context);
}

function getToolNames() {
  return allTools.map(t => t.name);
}

module.exports = { getToolDefinitions, executeTool, getToolNames, PAT_REQUIRED_TOOLS };

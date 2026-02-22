const path = require('path');

const config = {
  // Required
  discordToken: process.env.DISCORD_TOKEN,
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  tokenEncryptionSecret: process.env.TOKEN_ENCRYPTION_SECRET,

  // Claude
  claudeModel: process.env.CLAUDE_MODEL || 'claude-sonnet-4-20250514',
  classifierModel: process.env.CLASSIFIER_MODEL || 'claude-haiku-4-5-20251001',
  haikuFirstEnabled: process.env.HAIKU_FIRST_ENABLED !== 'false',  // default ON
  haikuFirstModel: process.env.HAIKU_FIRST_MODEL || process.env.CLASSIFIER_MODEL || 'claude-haiku-4-5-20251001',
  maxToolIterations: parseInt(process.env.MAX_TOOL_ITERATIONS) || 25,

  // Directories
  scratchDir: path.resolve(process.env.SCRATCH_DIR || './scratch'),
  workspaceDir: path.resolve(process.env.WORKSPACE_DIR || './workspaces'),
  dataDir: path.resolve(process.env.DATA_DIR || './data'),

  // Workspace limits
  maxWorkspaceSizeMB: parseInt(process.env.MAX_WORKSPACE_SIZE_MB) || 1024,
  workspaceTTLDays: parseInt(process.env.WORKSPACE_TTL_DAYS) || 7,

  // Conversation
  maxConversationMessages: parseInt(process.env.MAX_CONVERSATION_MESSAGES) || 50,

  // Thread lifecycle
  threadInactivityMs: parseInt(process.env.THREAD_INACTIVITY_MS) || 15 * 60 * 1000,

  // Conversation logging
  maxLogSizeMB: parseInt(process.env.MAX_LOG_SIZE_MB) || 10,
  logFlushIntervalMs: parseInt(process.env.LOG_FLUSH_INTERVAL_MS) || 2000,

  // Access control
  ownerId: process.env.OWNER_ID || null,
};

// Validation
if (!config.discordToken) throw new Error('DISCORD_TOKEN is required');
if (!config.anthropicApiKey) {
  console.warn('WARNING: ANTHROPIC_API_KEY not set. Will attempt Claude CLI (Max subscription) as fallback.');
}
if (!config.tokenEncryptionSecret) {
  console.warn('WARNING: TOKEN_ENCRYPTION_SECRET not set. PAT storage will be disabled.');
}

if (config.ownerId) {
  console.log(`Access control enabled — owner: ${config.ownerId}`);
} else {
  console.log('Access control disabled — all users allowed');
}

module.exports = config;

const { execFileSync } = require('child_process');
const path = require('path');
const config = require('../utils/config');

const BOT_DIR = path.resolve(__dirname, '../..');

const tools = [
  {
    name: 'bot_manage',
    description: 'Manage the bot: pull latest code, restart, or show current configuration.',
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['update', 'restart', 'config'],
          description: 'Action: "update" pulls latest code, "restart" restarts the process, "config" shows current settings (redacted)'
        },
        reason: { type: 'string', description: 'Reason for restart (only for action=restart)' }
      },
      required: ['action']
    },
    handler: async (args, context) => {
      switch (args.action) {
        case 'update': {
          // Phase 1 fix: execFileSync instead of execSync, with timeout
          const result = execFileSync('git', ['pull'], {
            cwd: BOT_DIR,
            timeout: 60000,
            encoding: 'utf8',
            stdio: 'pipe'
          });
          return `Update result:\n${result}`;
        }

        case 'restart': {
          // Phase 1 fix: proper drain — sets flag, bot.js handles the actual exit
          // after the Discord API response is delivered
          console.log(`Restart requested: ${args.reason || 'no reason given'}`);
          context._requestRestart = true;
          return `Bot will restart after this response is delivered. Reason: ${args.reason || 'none'}`;
        }

        case 'config': {
          return JSON.stringify({
            claudeModel: config.claudeModel,
            maxToolIterations: config.maxToolIterations,
            scratchDir: config.scratchDir,
            workspaceDir: config.workspaceDir,
            dataDir: config.dataDir,
            maxWorkspaceSizeMB: config.maxWorkspaceSizeMB,
            workspaceTTLDays: config.workspaceTTLDays,
            maxConversationMessages: config.maxConversationMessages,
            threadInactivityMs: config.threadInactivityMs,
            hasEncryptionSecret: !!config.tokenEncryptionSecret,
            hasDiscordToken: !!config.discordToken,
            hasAnthropicKey: !!config.anthropicApiKey
          }, null, 2);
        }

        default:
          throw new Error(`Unknown action: "${args.action}". Use "update", "restart", or "config".`);
      }
    }
  }
];

module.exports = { tools };

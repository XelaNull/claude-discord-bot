import { config } from './utils/config.js';
import { createBot } from './bot.js';
import { ensureScratchDir } from './utils/scratch.js';

console.log('[startup] Claude Discord Bot starting...');
console.log(`[startup] Model: ${config.model}`);
console.log(`[startup] Prefix: "${config.botPrefix}"`);
console.log(`[startup] Scratch dir: ${config.scratchDir}`);

// Ensure scratch space exists
ensureScratchDir();

// Create and start the bot
const client = createBot();

client.login(config.discordToken).catch(err => {
  console.error('[startup] Failed to login:', err.message);
  process.exit(1);
});

// Graceful shutdown
function shutdown(signal) {
  console.log(`[shutdown] Received ${signal}, shutting down...`);
  client.destroy();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Uncaught error handling — log and exit (Docker will restart)
process.on('uncaughtException', (err) => {
  console.error('[fatal] Uncaught exception:', err);
  client.destroy();
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('[fatal] Unhandled rejection:', reason);
  client.destroy();
  process.exit(1);
});

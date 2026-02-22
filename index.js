require('dotenv').config();
const net = require('net');
const fs = require('fs');
const config = require('./src/utils/config');
const { startBot } = require('./src/bot');

// --- Single-instance guard (TCP port lock) ---
// Works across local and Docker: probe the port first — if anything responds,
// another instance is running. Then bind to claim the lock.
// Docker exposes the port to the host, so local ↔ container conflicts are caught.
const LOCK_PORT = parseInt(process.env.LOCK_PORT) || 47100;

function acquireLock() {
  return new Promise((resolve) => {
    // Step 1: Probe — try to connect to the port
    const probe = net.createConnection({ port: LOCK_PORT, host: '127.0.0.1' });

    probe.once('connect', () => {
      // Something is already listening — another instance is running
      probe.destroy();
      console.error(`\n  *** Another CodeBot instance is already running (port ${LOCK_PORT} responded). Exiting. ***\n`);
      process.exit(1);
    });

    probe.once('error', () => {
      // Nothing listening — safe to claim the port
      probe.destroy();

      const lockServer = net.createServer();
      lockServer.once('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          console.error(`\n  *** Another CodeBot instance is already running (port ${LOCK_PORT} in use). Exiting. ***\n`);
          process.exit(1);
        }
        console.error('Lock server error:', err.message);
        process.exit(1);
      });

      lockServer.listen(LOCK_PORT, '0.0.0.0', () => {
        console.log(`[lock] Instance lock acquired on port ${LOCK_PORT}`);
        resolve();
      });
    });

    // Don't let the probe hang forever
    probe.setTimeout(2000, () => {
      probe.destroy();
    });
  });
}

acquireLock().then(() => {
  fs.mkdirSync(config.dataDir, { recursive: true });
  startBot();
});

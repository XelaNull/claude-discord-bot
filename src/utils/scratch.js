const fs = require('fs');
const path = require('path');
const config = require('./config');

function ensureScratchDir() {
  fs.mkdirSync(config.scratchDir, { recursive: true });
  return config.scratchDir;
}

function getScratchPath(...parts) {
  const resolved = path.resolve(config.scratchDir, ...parts);
  if (!resolved.startsWith(path.resolve(config.scratchDir))) {
    throw new Error('Path traversal detected');
  }
  return resolved;
}

module.exports = { ensureScratchDir, getScratchPath };

const path = require('path');
const config = require('./config');

function getRepoDir(repoStr) {
  const [owner, repo] = repoStr.split('/');
  if (!owner || !repo) throw new Error('Invalid repo format. Expected "owner/repo".');
  return path.join(config.scratchDir, `${owner}--${repo}`);
}

function validatePath(basePath, requestedPath) {
  const resolved = path.resolve(basePath, requestedPath);
  if (!resolved.startsWith(path.resolve(basePath))) {
    throw new Error('Path traversal detected');
  }
  return resolved;
}

module.exports = { getRepoDir, validatePath };

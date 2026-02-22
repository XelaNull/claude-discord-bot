const fs = require('fs');
const path = require('path');
const config = require('./config');

/**
 * Per-user workspace isolation.
 *
 * Directory layout:
 *   {workspaceDir}/users/{userId}/{owner}--{repo}/
 */

// ── helpers ──────────────────────────────────────────────────────────

function userBase(userId) {
  return path.join(config.workspaceDir, 'users', userId);
}

function repoDir(userId, owner, repo) {
  return path.join(userBase(userId), `${owner}--${repo}`);
}

/** Recursively sum the size of every file under `dir`. */
function dirSizeBytes(dir) {
  let total = 0;
  if (!fs.existsSync(dir)) return total;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += dirSizeBytes(full);
    } else if (entry.isFile()) {
      try {
        total += fs.statSync(full).size;
      } catch (_) {
        // file may have been removed between readdir and stat
      }
    }
  }
  return total;
}

// ── exports ──────────────────────────────────────────────────────────

/**
 * Return (and create if needed) the workspace directory for a repo clone.
 * Path: {workspaceDir}/users/{userId}/{owner}--{repo}/
 */
function getWorkspace(userId, owner, repo) {
  const dir = repoDir(userId, owner, repo);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * List every cloned repo workspace for a given user.
 * Returns [{ owner, repo, path, sizeBytes, lastAccessed }].
 */
function listUserWorkspaces(userId) {
  const base = userBase(userId);
  if (!fs.existsSync(base)) return [];

  const entries = fs.readdirSync(base, { withFileTypes: true });
  const workspaces = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const parts = entry.name.split('--');
    if (parts.length < 2) continue; // skip malformed entries

    const owner = parts[0];
    const repo = parts.slice(1).join('--'); // handle repos with -- in the name
    const wsPath = path.join(base, entry.name);

    let lastAccessed;
    try {
      lastAccessed = fs.statSync(wsPath).atimeMs;
    } catch (_) {
      lastAccessed = 0;
    }

    workspaces.push({
      owner,
      repo,
      path: wsPath,
      sizeBytes: dirSizeBytes(wsPath),
      lastAccessed,
    });
  }

  return workspaces;
}

/**
 * Delete a specific repo workspace for a user (rm -rf equivalent).
 */
function cleanUserWorkspace(userId, owner, repo) {
  const dir = repoDir(userId, owner, repo);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Remove workspaces that haven't been accessed in `config.workspaceTTLDays` days.
 * Iterates all users and all their workspaces.
 */
function cleanExpiredWorkspaces() {
  const usersRoot = path.join(config.workspaceDir, 'users');
  if (!fs.existsSync(usersRoot)) return;

  const ttlMs = config.workspaceTTLDays * 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - ttlMs;

  const userDirs = fs.readdirSync(usersRoot, { withFileTypes: true });
  for (const userEntry of userDirs) {
    if (!userEntry.isDirectory()) continue;

    const userPath = path.join(usersRoot, userEntry.name);
    const repoDirs = fs.readdirSync(userPath, { withFileTypes: true });

    for (const repoEntry of repoDirs) {
      if (!repoEntry.isDirectory()) continue;

      const wsPath = path.join(userPath, repoEntry.name);
      try {
        const stat = fs.statSync(wsPath);
        if (stat.atimeMs < cutoff) {
          fs.rmSync(wsPath, { recursive: true, force: true });
        }
      } catch (_) {
        // stat failed — directory may have been removed concurrently
      }
    }

    // Clean up empty user directories
    try {
      const remaining = fs.readdirSync(userPath);
      if (remaining.length === 0) {
        fs.rmSync(userPath, { recursive: true, force: true });
      }
    } catch (_) {}
  }
}

/**
 * Resolve a subpath within a user's repo workspace.
 * Throws if the resolved path escapes the workspace (path traversal guard).
 */
function getWorkspacePath(userId, owner, repo, ...subpath) {
  const wsDir = repoDir(userId, owner, repo);
  const resolved = path.resolve(wsDir, ...subpath);

  // Guard: resolved path must stay within this user's workspace directory
  const wsNormalized = path.resolve(wsDir) + path.sep;
  if (resolved !== path.resolve(wsDir) && !resolved.startsWith(wsNormalized)) {
    throw new Error('Path traversal detected');
  }

  return resolved;
}

/**
 * Total bytes used across all workspaces for a given user.
 */
function getDiskUsage(userId) {
  const base = userBase(userId);
  return dirSizeBytes(base);
}

/**
 * Check if a user's repo workspace exceeds the configured quota.
 * Throws if over quota. Returns { sizeBytes, limitBytes } otherwise.
 */
function checkWorkspaceQuota(userId, owner, repo) {
  const wsDir = repoDir(userId, owner, repo);
  const sizeBytes = dirSizeBytes(wsDir);
  const limitBytes = config.maxWorkspaceSizeMB * 1024 * 1024;
  if (sizeBytes > limitBytes) {
    const sizeMB = (sizeBytes / (1024 * 1024)).toFixed(1);
    throw new Error(
      `Workspace quota exceeded: ${sizeMB}MB / ${config.maxWorkspaceSizeMB}MB limit. ` +
      `Clean up files or use "clean workspace ${owner}/${repo}".`
    );
  }
  return { sizeBytes, limitBytes };
}

module.exports = {
  getWorkspace,
  listUserWorkspaces,
  cleanUserWorkspace,
  cleanExpiredWorkspaces,
  getWorkspacePath,
  getDiskUsage,
  checkWorkspaceQuota,
};

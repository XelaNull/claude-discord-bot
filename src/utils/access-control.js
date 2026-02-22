const fs = require('fs');
const path = require('path');
const config = require('./config');

const ACCESS_FILE = path.join(config.dataDir, 'access.json');
const AUDIT_FILE = path.join(config.dataDir, 'audit.log');

// ── In-memory cache ─────────────────────────────────────────────────────
let accessData = null;
let saveTimer = null;

/**
 * Load access data from disk (once). Returns in-memory cache on subsequent calls.
 */
function loadAccess() {
  if (accessData !== null) return accessData;

  try {
    if (fs.existsSync(ACCESS_FILE)) {
      accessData = JSON.parse(fs.readFileSync(ACCESS_FILE, 'utf8'));
    } else {
      accessData = { users: {} };
    }
  } catch (err) {
    console.error('Failed to load access control data, starting fresh:', err.message);
    accessData = { users: {} };
  }

  return accessData;
}

/**
 * Debounced write — waits 1 second after the last change before flushing to disk.
 */
function scheduleSave() {
  if (saveTimer) {
    clearTimeout(saveTimer);
  }

  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(path.dirname(ACCESS_FILE), { recursive: true });
      fs.writeFileSync(ACCESS_FILE, JSON.stringify(accessData, null, 2));
    } catch (err) {
      console.error('Failed to save access control data:', err.message);
    }
  }, 1000);
}

/**
 * Audit logging — appends to shared audit.log (same file as token-store.js).
 */
function auditLog(action, userId, extra = '') {
  const entry = `${new Date().toISOString()} ${action} user=${userId}${extra ? ' ' + extra : ''}\n`;
  try {
    fs.mkdirSync(path.dirname(AUDIT_FILE), { recursive: true });
    fs.appendFileSync(AUDIT_FILE, entry);
  } catch (_) {}
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Check if a user is the bot owner.
 */
function isOwner(userId) {
  return config.ownerId !== null && userId === config.ownerId;
}

/**
 * Check if a user is allowed to use the bot.
 * - If OWNER_ID is not set, everyone is allowed (backward compat).
 * - Owner is always allowed.
 * - Otherwise checks access.json for an active grant.
 */
function isAllowed(userId) {
  if (!config.ownerId) return true;
  if (userId === config.ownerId) return true;

  const data = loadAccess();
  const entry = data.users[userId];
  return !!(entry && entry.active);
}

/**
 * Grant access to a user.
 */
function grantAccess(userId, grantedBy, displayName) {
  const data = loadAccess();

  data.users[userId] = {
    displayName: displayName || userId,
    grantedBy,
    grantedAt: new Date().toISOString(),
    active: true
  };

  scheduleSave();
  auditLog('GRANT_ACCESS', userId, `by=${grantedBy}`);
  console.log(`[access] Granted access to ${displayName || userId} (${userId}) by ${grantedBy}`);
}

/**
 * Revoke access from a user. Preserves history (sets active: false).
 */
function revokeAccess(userId, revokedBy) {
  const data = loadAccess();
  const entry = data.users[userId];

  if (entry) {
    entry.active = false;
    entry.revokedBy = revokedBy;
    entry.revokedAt = new Date().toISOString();
  } else {
    data.users[userId] = {
      displayName: userId,
      grantedBy: null,
      grantedAt: null,
      active: false,
      revokedBy,
      revokedAt: new Date().toISOString()
    };
  }

  scheduleSave();
  auditLog('REVOKE_ACCESS', userId, `by=${revokedBy}`);
  console.log(`[access] Revoked access from ${userId} by ${revokedBy}`);
}

/**
 * List all active allowed users.
 * Returns array of { userId, displayName, grantedBy, grantedAt }.
 */
function listAllowed() {
  const data = loadAccess();
  const result = [];

  for (const [userId, entry] of Object.entries(data.users)) {
    if (entry.active) {
      result.push({
        userId,
        displayName: entry.displayName,
        grantedBy: entry.grantedBy,
        grantedAt: entry.grantedAt
      });
    }
  }

  return result;
}

/**
 * Returns the denial message for unauthorized users.
 */
function denyMessage() {
  return 'You don\'t have access to this bot. Ask the bot owner to grant you access.';
}

module.exports = { isOwner, isAllowed, grantAccess, revokeAccess, listAllowed, denyMessage };

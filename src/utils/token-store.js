const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('./config');

const TOKENS_FILE = path.join(config.dataDir, 'tokens.enc.json');
const AUDIT_FILE = path.join(config.dataDir, 'audit.log');

// Per-user key derivation using PBKDF2 (Phase 1 security hardening)
function deriveKey(userId) {
  const salt = `claude-bot:${userId}`;
  return crypto.pbkdf2Sync(config.tokenEncryptionSecret, salt, 100000, 32, 'sha256');
}

function encrypt(text, userId) {
  const key = deriveKey(userId);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');
  return `${iv.toString('hex')}:${tag}:${encrypted}`;
}

function decrypt(data, userId) {
  const [ivHex, tagHex, encrypted] = data.split(':');
  const key = deriveKey(userId);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

// Audit logging (Phase 1 security hardening — timestamp + userId, never the token)
function auditLog(action, userId) {
  const entry = `${new Date().toISOString()} ${action} user=${userId}\n`;
  try {
    fs.mkdirSync(path.dirname(AUDIT_FILE), { recursive: true });
    fs.appendFileSync(AUDIT_FILE, entry);
  } catch (_) {}
}

function loadTokens() {
  try {
    if (fs.existsSync(TOKENS_FILE)) {
      return JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
    }
  } catch (_) {}
  return {};
}

function saveTokens(tokens) {
  fs.mkdirSync(path.dirname(TOKENS_FILE), { recursive: true });
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2));
}

function storeToken(userId, token) {
  if (!config.tokenEncryptionSecret) {
    throw new Error('TOKEN_ENCRYPTION_SECRET not configured. Cannot store PAT securely.');
  }
  const tokens = loadTokens();
  tokens[userId] = encrypt(token, userId);
  saveTokens(tokens);
  auditLog('STORE_TOKEN', userId);
}

function getToken(userId) {
  if (!config.tokenEncryptionSecret) return null;
  const tokens = loadTokens();
  if (!tokens[userId]) return null;
  try {
    return decrypt(tokens[userId], userId);
  } catch (err) {
    console.error(`Failed to decrypt token for user ${userId}:`, err.message);
    return null;
  }
}

function removeToken(userId) {
  const tokens = loadTokens();
  if (tokens[userId]) {
    delete tokens[userId];
    saveTokens(tokens);
    auditLog('REMOVE_TOKEN', userId);
  }
}

function hasToken(userId) {
  const tokens = loadTokens();
  return !!tokens[userId];
}

module.exports = { storeToken, getToken, removeToken, hasToken };

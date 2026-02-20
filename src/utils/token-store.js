import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const STORE_FILE = join(process.env.BOT_SOURCE_DIR || '.', 'data', 'tokens.enc.json');

// Derive encryption key from a secret. If no secret is configured,
// generate one and warn — tokens won't survive across fresh deployments.
let encryptionKey;
let generatedSecret = false;

function getKey() {
  if (encryptionKey) return encryptionKey;

  let secret = process.env.TOKEN_ENCRYPTION_SECRET;
  if (!secret) {
    secret = randomBytes(32).toString('hex');
    generatedSecret = true;
    console.warn('[token-store] WARNING: No TOKEN_ENCRYPTION_SECRET configured. Using random key — stored tokens will be lost on restart.');
  }

  encryptionKey = scryptSync(secret, 'claude-discord-bot-salt', 32);
  return encryptionKey;
}

function encrypt(text) {
  const iv = randomBytes(16);
  const cipher = createCipheriv(ALGORITHM, getKey(), iv);
  let encrypted = cipher.update(text, 'utf-8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag().toString('hex');
  return `${iv.toString('hex')}:${tag}:${encrypted}`;
}

function decrypt(data) {
  const [ivHex, tagHex, encrypted] = data.split(':');
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const decipher = createDecipheriv(ALGORITHM, getKey(), iv);
  decipher.setAuthTag(tag);
  let decrypted = decipher.update(encrypted, 'hex', 'utf-8');
  decrypted += decipher.final('utf-8');
  return decrypted;
}

function loadStore() {
  if (!existsSync(STORE_FILE)) return {};
  try {
    return JSON.parse(readFileSync(STORE_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function saveStore(store) {
  mkdirSync(dirname(STORE_FILE), { recursive: true });
  writeFileSync(STORE_FILE, JSON.stringify(store, null, 2));
}

/**
 * Store a GitHub PAT for a Discord user (encrypted at rest).
 */
export function storeToken(discordUserId, githubToken) {
  const store = loadStore();
  store[discordUserId] = encrypt(githubToken);
  saveStore(store);
}

/**
 * Retrieve a GitHub PAT for a Discord user.
 * Returns null if no token is stored.
 */
export function getToken(discordUserId) {
  const store = loadStore();
  const encrypted = store[discordUserId];
  if (!encrypted) return null;

  try {
    return decrypt(encrypted);
  } catch {
    // Decryption failed — key changed or data corrupted
    console.warn(`[token-store] Failed to decrypt token for user ${discordUserId}`);
    return null;
  }
}

/**
 * Remove a stored token for a Discord user.
 */
export function removeToken(discordUserId) {
  const store = loadStore();
  if (!store[discordUserId]) return false;
  delete store[discordUserId];
  saveStore(store);
  return true;
}

/**
 * Check if a user has a stored token (without decrypting).
 */
export function hasToken(discordUserId) {
  const store = loadStore();
  return !!store[discordUserId];
}

/**
 * Whether the encryption key was auto-generated (tokens won't persist).
 */
export function isEphemeralKey() {
  getKey(); // ensure initialized
  return generatedSecret;
}

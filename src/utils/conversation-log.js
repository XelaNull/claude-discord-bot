const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');

// ============================================================
//  JSONL Conversation Logger
//  Append-only, per-channel, buffered writes with rotation
// ============================================================

const LOG_DIR = path.join(config.dataDir, 'logs');

// Per-channel in-memory buffers: channelId → string[]
const buffers = new Map();

// Per-channel flush timers: channelId → setTimeout ID
const flushTimers = new Map();

// ── Sensitive data patterns ──────────────────────────────────

const PAT_PATTERNS = [
  /ghp_[A-Za-z0-9_]{36,}/g,
  /ghs_[A-Za-z0-9_]{36,}/g,
  /github_pat_[A-Za-z0-9_]{22,}/g,
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/g,
  /token=[A-Za-z0-9\-._~+/]+/gi,
];

// Tool input fields that may contain large content — truncate to 200 chars
const LARGE_CONTENT_FIELDS = new Set([
  'content', 'code', 'diff', 'body', 'patch', 'error_text',
  'file_content', 'new_content', 'old_content'
]);

// ── Helpers ──────────────────────────────────────────────────

/**
 * Generate an 8-char hex session ID for threading log events.
 */
function generateSessionId() {
  return crypto.randomBytes(4).toString('hex');
}

/**
 * Deep-clone an object and redact sensitive strings.
 */
function sanitize(obj) {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') return redactString(obj);
  if (Array.isArray(obj)) return obj.map(sanitize);
  if (typeof obj === 'object') {
    const out = {};
    for (const [key, val] of Object.entries(obj)) {
      out[key] = sanitize(val);
    }
    return out;
  }
  return obj;
}

function redactString(str) {
  let result = str;
  for (const pattern of PAT_PATTERNS) {
    // Reset lastIndex for global regexes
    pattern.lastIndex = 0;
    result = result.replace(pattern, '[REDACTED]');
  }
  return result;
}

/**
 * Truncate large content fields in tool input objects.
 */
function truncateToolInput(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const out = { ...obj };
  for (const key of Object.keys(out)) {
    if (LARGE_CONTENT_FIELDS.has(key) && typeof out[key] === 'string' && out[key].length > 200) {
      out[key] = out[key].substring(0, 200) + `... [${out[key].length} chars total]`;
    }
  }
  return out;
}

// ── Core logging ─────────────────────────────────────────────

/**
 * Append a log entry to the buffer for a given channel.
 */
function log(channelId, entry) {
  if (!channelId) return;

  const full = {
    ts: new Date().toISOString(),
    ...entry
  };

  const sanitized = sanitize(full);
  const line = JSON.stringify(sanitized);

  if (!buffers.has(channelId)) {
    buffers.set(channelId, []);
  }
  buffers.get(channelId).push(line);

  _scheduleFlush(channelId);
}

function _scheduleFlush(channelId) {
  if (flushTimers.has(channelId)) return; // already scheduled

  const timerId = setTimeout(() => {
    flushTimers.delete(channelId);
    _flush(channelId);
  }, config.logFlushIntervalMs);

  if (timerId.unref) timerId.unref();
  flushTimers.set(channelId, timerId);
}

function _flush(channelId) {
  const lines = buffers.get(channelId);
  if (!lines || lines.length === 0) return;

  // Clear the buffer
  buffers.delete(channelId);

  const filePath = path.join(LOG_DIR, `${channelId}.jsonl`);

  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });

    // Check rotation before writing
    _rotateIfNeeded(filePath);

    fs.appendFileSync(filePath, lines.join('\n') + '\n');
  } catch (err) {
    console.error(`[conversation-log] Failed to write log for ${channelId}:`, err.message);
  }
}

function _rotateIfNeeded(filePath) {
  try {
    if (!fs.existsSync(filePath)) return;
    const stat = fs.statSync(filePath);
    const limitBytes = config.maxLogSizeMB * 1024 * 1024;
    if (stat.size >= limitBytes) {
      const rotated = filePath.replace(/\.jsonl$/, `.${Date.now()}.jsonl`);
      fs.renameSync(filePath, rotated);
      console.log(`[conversation-log] Rotated ${filePath} → ${path.basename(rotated)}`);
    }
  } catch (err) {
    console.error(`[conversation-log] Rotation check failed:`, err.message);
  }
}

/**
 * Synchronously flush ALL buffers. Called on process exit.
 */
function _flushAll() {
  for (const [channelId, timerId] of flushTimers) {
    clearTimeout(timerId);
    flushTimers.delete(channelId);
  }
  for (const channelId of buffers.keys()) {
    _flush(channelId);
  }
}

// Flush on shutdown
process.on('exit', _flushAll);
process.on('SIGINT', () => { _flushAll(); process.exit(0); });
process.on('SIGTERM', () => { _flushAll(); process.exit(0); });

// ── Event-specific log functions ─────────────────────────────

function logUserMessage(channelId, fields) {
  log(channelId, { event: 'user_message', ...fields });
}

function logIntentClassification(channelId, fields) {
  log(channelId, { event: 'intent_classification', ...fields });
}

function logApiCall(channelId, fields) {
  log(channelId, { event: 'claude_api_call', ...fields });
}

function logToolCall(channelId, fields) {
  // Truncate large tool inputs before logging
  if (fields.toolInput) {
    fields = { ...fields, toolInput: truncateToolInput(fields.toolInput) };
  }
  log(channelId, { event: 'tool_call', ...fields });
}

function logResponse(channelId, fields) {
  log(channelId, { event: 'claude_response', ...fields });
}

function logError(channelId, fields) {
  // Truncate stack trace to 500 chars
  if (fields.stack && fields.stack.length > 500) {
    fields = { ...fields, stack: fields.stack.substring(0, 500) + '...' };
  }
  log(channelId, { event: 'error', ...fields });
}

function logThreadLifecycle(channelId, fields) {
  log(channelId, { event: 'thread_lifecycle', ...fields });
}

module.exports = {
  generateSessionId,
  logUserMessage,
  logIntentClassification,
  logApiCall,
  logToolCall,
  logResponse,
  logError,
  logThreadLifecycle,
};

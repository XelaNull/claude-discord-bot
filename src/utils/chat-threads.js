const fs = require('fs');
const path = require('path');
const { EmbedBuilder } = require('discord.js');
const config = require('./config');
const { logThreadLifecycle, generateSessionId } = require('./conversation-log');

const THREADS_FILE = path.join(config.dataDir, 'chat-threads.json');

// ── In-memory cache ─────────────────────────────────────────────────────
let threads = null;
let saveTimer = null;

// In-memory map of threadId → setTimeout ID for inactivity timers
const inactivityTimers = new Map();

// ── Persistence ─────────────────────────────────────────────────────────

function loadChatThreads() {
  if (threads !== null) return threads;

  try {
    if (fs.existsSync(THREADS_FILE)) {
      threads = JSON.parse(fs.readFileSync(THREADS_FILE, 'utf8'));
    } else {
      threads = {};
    }
  } catch (err) {
    console.error('Failed to load chat threads, starting fresh:', err.message);
    threads = {};
  }

  // Migrate older entries that lack new fields
  for (const [, meta] of Object.entries(threads)) {
    if (meta.lastActivity === undefined) meta.lastActivity = meta.createdAt || Date.now();
    if (meta.totalInputTokens === undefined) meta.totalInputTokens = 0;
    if (meta.totalOutputTokens === undefined) meta.totalOutputTokens = 0;
    if (meta.totalCost === undefined) meta.totalCost = 0;
    if (meta.messageCount === undefined) meta.messageCount = 999; // don't auto-rename old threads
    if (meta.renamed === undefined) meta.renamed = true;
  }

  return threads;
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);

  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(path.dirname(THREADS_FILE), { recursive: true });
      fs.writeFileSync(THREADS_FILE, JSON.stringify(threads, null, 2));
    } catch (err) {
      console.error('Failed to save chat threads:', err.message);
    }
  }, 1000);
}

// ── Thread registry ─────────────────────────────────────────────────────

function addChatThread(threadId, metadata) {
  const data = loadChatThreads();
  const now = Date.now();
  data[threadId] = {
    channelId: metadata.channelId,
    createdBy: metadata.createdBy,
    createdAt: now,
    lastActivity: now,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCost: 0,
    messageCount: 0,
    renamed: false
  };
  scheduleSave();
}

function removeChatThread(threadId) {
  const data = loadChatThreads();
  // Clear any running inactivity timer
  if (inactivityTimers.has(threadId)) {
    clearTimeout(inactivityTimers.get(threadId));
    inactivityTimers.delete(threadId);
  }
  delete data[threadId];
  scheduleSave();
}

function isChatThread(threadId) {
  const data = loadChatThreads();
  return threadId in data;
}

function getChatThreadsByUser(userId) {
  const data = loadChatThreads();
  return Object.entries(data)
    .filter(([, meta]) => meta.createdBy === userId)
    .map(([threadId]) => threadId);
}

// ── Token tracking ──────────────────────────────────────────────────────

function trackThreadTokens(threadId, inputTokens, outputTokens, cost) {
  const data = loadChatThreads();
  const meta = data[threadId];
  if (!meta) return;

  meta.totalInputTokens += inputTokens;
  meta.totalOutputTokens += outputTokens;
  meta.totalCost += cost;
  scheduleSave();
}

function getThreadTokens(threadId) {
  const data = loadChatThreads();
  const meta = data[threadId];
  if (!meta) {
    return { totalInputTokens: 0, totalOutputTokens: 0, totalCost: 0 };
  }
  return {
    totalInputTokens: meta.totalInputTokens,
    totalOutputTokens: meta.totalOutputTokens,
    totalCost: meta.totalCost
  };
}

// ── Inactivity timers ───────────────────────────────────────────────────

function touchThread(threadId) {
  const data = loadChatThreads();
  const meta = data[threadId];
  if (!meta) return;

  meta.lastActivity = Date.now();
  scheduleSave();

  // Reset inactivity timer
  _setInactivityTimer(threadId);
}

function _setInactivityTimer(threadId, delayMs) {
  // Clear existing timer
  if (inactivityTimers.has(threadId)) {
    clearTimeout(inactivityTimers.get(threadId));
  }

  const delay = delayMs !== undefined ? delayMs : config.threadInactivityMs;

  const timerId = setTimeout(async () => {
    inactivityTimers.delete(threadId);
    // _cachedClient is set during startInactivityTimers
    if (_cachedClient) {
      await closeThread(threadId, _cachedClient, 'inactivity');
    }
  }, delay);

  // Prevent the timer from keeping the process alive
  if (timerId.unref) timerId.unref();

  inactivityTimers.set(threadId, timerId);
}

// Cached Discord client reference — set once during startInactivityTimers
let _cachedClient = null;

/**
 * On startup, iterate all registered threads. For each:
 * - If lastActivity + threadInactivityMs < now → close immediately
 * - Otherwise → set a timer for the remaining time
 */
async function startInactivityTimers(client) {
  _cachedClient = client;
  const data = loadChatThreads();
  const threadIds = Object.keys(data);
  if (threadIds.length === 0) return;

  const now = Date.now();
  let pruned = 0;

  for (const threadId of threadIds) {
    const meta = data[threadId];
    const elapsed = now - (meta.lastActivity || meta.createdAt || now);
    const remaining = config.threadInactivityMs - elapsed;

    if (remaining <= 0) {
      // Already expired — close immediately
      await closeThread(threadId, client, 'inactivity');
      pruned++;
    } else {
      // Verify the thread still exists before setting a timer
      try {
        const channel = await client.channels.fetch(threadId);
        if (!channel || channel.archived) {
          delete data[threadId];
          pruned++;
          continue;
        }
        _setInactivityTimer(threadId, remaining);
      } catch (_) {
        // Thread not found — prune it
        delete data[threadId];
        pruned++;
      }
    }
  }

  if (pruned > 0) {
    console.log(`[chat-threads] Pruned/closed ${pruned} stale thread(s) on startup`);
    scheduleSave();
  }

  console.log(`[chat-threads] Tracking ${Object.keys(data).length} active thread(s)`);
}

/**
 * Close a thread: send a goodbye embed, archive it, and remove from registry.
 */
async function closeThread(threadId, client, reason) {
  const data = loadChatThreads();
  const meta = data[threadId];

  // Log thread closure
  logThreadLifecycle(threadId, {
    sessionId: generateSessionId(),
    userId: meta?.createdBy,
    action: 'closed',
    threadId,
    reason,
    totalTokens: meta ? (meta.totalInputTokens + meta.totalOutputTokens) : 0,
    totalCost: meta?.totalCost || 0
  });

  try {
    const thread = await client.channels.fetch(threadId);
    if (thread && !thread.archived) {
      // Build closing embed
      const description = reason === 'inactivity'
        ? 'This thread has been closed due to 15 minutes of inactivity.'
        : 'This thread has been closed.';

      const tokenInfo = meta
        ? `\n\n📊 **Thread totals:** ${_formatTokenCount(meta.totalInputTokens + meta.totalOutputTokens)} tokens ($${meta.totalCost.toFixed(4)})`
        : '';

      await thread.send({
        embeds: [new EmbedBuilder()
          .setColor(0xfee75c)
          .setTitle('Thread Closed')
          .setDescription(description + tokenInfo)
        ]
      });

      // Archive the thread
      try {
        await thread.setArchived(true);
      } catch (archiveErr) {
        // No ManageThreads permission — inform gracefully
        await thread.send("I can't archive this thread — a moderator can close it manually.").catch(() => {});
      }
    }
  } catch (err) {
    // Thread not found or not accessible — that's fine, just clean up
    console.log(`[chat-threads] Could not close thread ${threadId}: ${err.message}`);
  }

  // Remove from registry
  removeChatThread(threadId);
}

/**
 * Format a token count for display: 456 → "456", 1234 → "1.2K", 12345 → "12.3K"
 */
function _formatTokenCount(count) {
  if (count < 1000) return String(count);
  return (count / 1000).toFixed(1) + 'K';
}

// ── Auto-rename helpers ──────────────────────────────────────────────

function incrementMessageCount(threadId) {
  const data = loadChatThreads();
  const meta = data[threadId];
  if (!meta) return 0;
  meta.messageCount = (meta.messageCount || 0) + 1;
  scheduleSave();
  return meta.messageCount;
}

function markRenamed(threadId) {
  const data = loadChatThreads();
  const meta = data[threadId];
  if (!meta) return;
  meta.renamed = true;
  scheduleSave();
}

function shouldAutoRename(threadId) {
  const data = loadChatThreads();
  const meta = data[threadId];
  if (!meta) return false;
  return !meta.renamed && meta.messageCount <= 2;
}

module.exports = {
  loadChatThreads,
  addChatThread,
  removeChatThread,
  isChatThread,
  getChatThreadsByUser,
  touchThread,
  trackThreadTokens,
  getThreadTokens,
  startInactivityTimers,
  closeThread,
  _formatTokenCount,
  incrementMessageCount,
  markRenamed,
  shouldAutoRename
};

const fs = require('fs');
const path = require('path');
const config = require('./config');

const CONV_DIR = path.join(config.dataDir, 'conversations');
const MAX_FILE_SIZE = 200 * 1024; // 200KB rotation threshold

// channelId -> [{ role, content }]
const conversations = new Map();
let loaded = new Set();

function ensureConvDir() {
  fs.mkdirSync(CONV_DIR, { recursive: true });
}

function convFile(channelId) {
  return path.join(CONV_DIR, `${channelId}.json`);
}

function loadFromDisk(channelId) {
  if (loaded.has(channelId)) return;
  loaded.add(channelId);

  try {
    const file = convFile(channelId);
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(data)) {
        conversations.set(channelId, data);
      }
    }
  } catch (err) {
    console.error(`Failed to load conversation ${channelId}:`, err.message);
  }
}

let _saveTimers = new Map();
function scheduleSave(channelId) {
  if (_saveTimers.has(channelId)) return;
  _saveTimers.set(channelId, setTimeout(() => {
    _saveTimers.delete(channelId);
    try {
      ensureConvDir();
      const file = convFile(channelId);
      const history = conversations.get(channelId) || [];
      const content = JSON.stringify(history, null, 2);

      // Rotate if file would exceed size limit
      if (content.length > MAX_FILE_SIZE) {
        const half = Math.floor(history.length / 2);
        const trimmed = history.slice(half);
        conversations.set(channelId, trimmed);
        fs.writeFileSync(file, JSON.stringify(trimmed, null, 2));
      } else {
        fs.writeFileSync(file, content);
      }
    } catch (err) {
      console.error(`Failed to save conversation ${channelId}:`, err.message);
    }
  }, 2000));
}

function getHistory(channelId) {
  loadFromDisk(channelId);
  if (!conversations.has(channelId)) {
    conversations.set(channelId, []);
  }
  return conversations.get(channelId);
}

function addMessage(channelId, role, content) {
  const history = getHistory(channelId);
  history.push({ role, content });
  while (history.length > config.maxConversationMessages) {
    history.shift();
  }
  scheduleSave(channelId);
}

function clearHistory(channelId) {
  conversations.delete(channelId);
  try {
    const file = convFile(channelId);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch (_) {}
}

function getConversationMessages(channelId) {
  return getHistory(channelId).slice();
}

function getSummary(channelId, maxMessages) {
  const history = getHistory(channelId);
  const recent = history.slice(-(maxMessages || 10));
  return recent.map(m => `${m.role}: ${typeof m.content === 'string' ? m.content.substring(0, 200) : '[tool data]'}`).join('\n');
}

module.exports = { addMessage, clearHistory, getConversationMessages, getSummary };

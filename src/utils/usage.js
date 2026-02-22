const fs = require('fs');
const path = require('path');
const { EmbedBuilder } = require('discord.js');
const config = require('./config');

const USAGE_FILE = path.join(config.dataDir, 'usage.json');
const DEBOUNCE_MS = 1000;

// ─── Pricing ($ per million tokens) ─────────────────────────────────────────
// Updated for current Anthropic API pricing
const MODEL_PRICING = {
  'claude-sonnet-4-6':          { input: 3.00,  output: 15.00 },
  'claude-sonnet-4-20250514':   { input: 3.00,  output: 15.00 },
  'claude-sonnet-3-5-20241022': { input: 3.00,  output: 15.00 },
  'claude-sonnet-3-5-20240620': { input: 3.00,  output: 15.00 },
  'claude-opus-4-6':            { input: 15.00, output: 75.00 },
  'claude-opus-4-20250514':     { input: 15.00, output: 75.00 },
  'claude-haiku-4-5-20251001':  { input: 0.80,  output: 4.00  },
  'claude-haiku-3-5-20241022':  { input: 0.80,  output: 4.00  },
};

/**
 * Calculate cost in USD for a given model and token counts.
 */
function calculateCost(model, inputTokens, outputTokens) {
  // Find pricing — try exact match first, then prefix match
  let pricing = MODEL_PRICING[model];
  if (!pricing) {
    const key = Object.keys(MODEL_PRICING).find(k => model.startsWith(k.split('-20')[0]));
    if (key) pricing = MODEL_PRICING[key];
  }
  if (!pricing) {
    // Default to Sonnet pricing as fallback
    pricing = { input: 3.00, output: 15.00 };
  }
  return (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;
}

/** @type {Object.<string, UserStats> | null} */
let _data = null;
let _writeTimeout = null;

// ─── Persistence ────────────────────────────────────────────────────────────

function _load() {
  if (_data !== null) return;
  try {
    if (fs.existsSync(USAGE_FILE)) {
      _data = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8'));
      return;
    }
  } catch (err) {
    console.error('Failed to load usage data, starting fresh:', err.message);
  }
  _data = {};
}

function _save() {
  try {
    fs.mkdirSync(path.dirname(USAGE_FILE), { recursive: true });
    fs.writeFileSync(USAGE_FILE, JSON.stringify(_data, null, 2));
  } catch (err) {
    console.error('Failed to save usage data:', err.message);
  }
}

/**
 * Schedule a debounced write — multiple mutations within DEBOUNCE_MS collapse
 * into a single disk write.
 */
function _scheduleSave() {
  if (_writeTimeout) return; // already scheduled
  _writeTimeout = setTimeout(() => {
    _writeTimeout = null;
    _save();
  }, DEBOUNCE_MS);
}

/**
 * Flush pending writes immediately. Called on process exit so we never lose
 * data that's still sitting in the debounce window.
 */
function _flushSync() {
  if (_writeTimeout) {
    clearTimeout(_writeTimeout);
    _writeTimeout = null;
    _save();
  }
}

// Flush on clean shutdown signals and synchronous exit.
process.on('exit', _flushSync);
process.on('SIGINT', () => { _flushSync(); process.exit(0); });
process.on('SIGTERM', () => { _flushSync(); process.exit(0); });

// ─── Helpers ────────────────────────────────────────────────────────────────

function _ensure(userId) {
  _load();
  if (!_data[userId]) {
    _data[userId] = {
      apiCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCost: 0,
      prsCreated: 0,
      issuesFixed: 0,
      firstSeen: new Date().toISOString(),
      lastActive: new Date().toISOString()
    };
  }
  // Migrate older entries that don't have estimatedCost
  if (_data[userId].estimatedCost === undefined) {
    _data[userId].estimatedCost = 0;
  }
  return _data[userId];
}

function _touch(userId) {
  const entry = _ensure(userId);
  entry.lastActive = new Date().toISOString();
  return entry;
}

// ─── Public API — Tracking ──────────────────────────────────────────────────

/**
 * Increment API call count for a user.
 * @param {string} userId
 */
function trackApiCall(userId) {
  const entry = _touch(userId);
  entry.apiCalls += 1;
  _scheduleSave();
}

/**
 * Add token usage for a user.
 * @param {string} userId
 * @param {number} inputTokens
 * @param {number} outputTokens
 * @param {string} [model] - Model name for cost calculation
 */
function trackTokens(userId, inputTokens, outputTokens, model) {
  const entry = _touch(userId);
  entry.inputTokens += inputTokens;
  entry.outputTokens += outputTokens;
  if (model) {
    entry.estimatedCost += calculateCost(model, inputTokens, outputTokens);
  }
  _scheduleSave();
}

/**
 * Increment PR created count for a user.
 * @param {string} userId
 */
function trackPR(userId) {
  const entry = _touch(userId);
  entry.prsCreated += 1;
  _scheduleSave();
}

/**
 * Increment issues fixed count for a user.
 * @param {string} userId
 */
function trackIssueFix(userId) {
  const entry = _touch(userId);
  entry.issuesFixed += 1;
  _scheduleSave();
}

// ─── Public API — Queries ───────────────────────────────────────────────────

/**
 * Return stats for a single user, or a zeroed-out object if they have none.
 * @param {string} userId
 * @returns {UserStats}
 */
function getUsageStats(userId) {
  _load();
  return _data[userId] || {
    apiCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    estimatedCost: 0,
    prsCreated: 0,
    issuesFixed: 0,
    firstSeen: null,
    lastActive: null
  };
}

/**
 * Return aggregate stats across every tracked user.
 * @returns {{ users: number } & UserStats}
 */
function getGlobalStats() {
  _load();

  const global = {
    users: 0,
    apiCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    estimatedCost: 0,
    prsCreated: 0,
    issuesFixed: 0,
    firstSeen: null,
    lastActive: null
  };

  for (const userId of Object.keys(_data)) {
    const u = _data[userId];
    global.users += 1;
    global.apiCalls += u.apiCalls;
    global.inputTokens += u.inputTokens;
    global.outputTokens += u.outputTokens;
    global.estimatedCost += u.estimatedCost || 0;
    global.prsCreated += u.prsCreated;
    global.issuesFixed += u.issuesFixed;

    if (!global.firstSeen || (u.firstSeen && u.firstSeen < global.firstSeen)) {
      global.firstSeen = u.firstSeen;
    }
    if (!global.lastActive || (u.lastActive && u.lastActive > global.lastActive)) {
      global.lastActive = u.lastActive;
    }
  }

  return global;
}

// ─── Public API — Formatting ────────────────────────────────────────────────

/**
 * Format a number with comma separators (e.g. 1234567 → "1,234,567").
 */
function _fmt(n) {
  return Number(n).toLocaleString('en-US');
}

/**
 * Build a Discord embed displaying usage statistics.
 * Works with both per-user and global stats objects.
 * @param {object} stats - Output from getUsageStats() or getGlobalStats().
 * @param {object} [options]
 * @param {string} [options.title] - Override embed title.
 * @returns {EmbedBuilder}
 */
function formatUsageEmbed(stats, options = {}) {
  const isGlobal = 'users' in stats;
  const title = options.title || (isGlobal ? 'Global Usage Statistics' : 'Your Usage Statistics');

  const totalTokens = stats.inputTokens + stats.outputTokens;
  const cost = stats.estimatedCost || 0;

  const lines = [];

  // Model info
  lines.push(`**Model:** \`${config.claudeModel}\``);
  lines.push('');

  if (isGlobal) {
    lines.push(`**Users tracked:** ${_fmt(stats.users)}`);
  }
  lines.push(`**API calls:** ${_fmt(stats.apiCalls)}`);
  lines.push(`**Tokens used:** ${_fmt(totalTokens)} (${_fmt(stats.inputTokens)} in / ${_fmt(stats.outputTokens)} out)`);
  lines.push(`**Estimated cost:** $${cost.toFixed(4)}`);
  lines.push('');
  lines.push(`**PRs created:** ${_fmt(stats.prsCreated)}`);
  lines.push(`**Issues fixed:** ${_fmt(stats.issuesFixed)}`);

  if (stats.firstSeen) {
    const firstDate = new Date(stats.firstSeen).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    lines.push(`**First seen:** ${firstDate}`);
  }
  if (stats.lastActive) {
    const lastDate = new Date(stats.lastActive).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
    lines.push(`**Last active:** ${lastDate}`);
  }

  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(title)
    .setDescription(lines.join('\n'))
    .setTimestamp();
}

module.exports = {
  trackApiCall,
  trackTokens,
  trackPR,
  trackIssueFix,
  getUsageStats,
  getGlobalStats,
  formatUsageEmbed,
  calculateCost
};

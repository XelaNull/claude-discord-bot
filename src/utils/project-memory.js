const fs = require('fs');
const path = require('path');
const config = require('./config');

const MEMORY_FILE = path.join(config.dataDir, 'project-memory.json');
const MAX_KEY_FINDINGS = 20;

// ── In-memory cache ─────────────────────────────────────────────────────
let memory = null;
let saveTimer = null;

/**
 * Load memory from disk (once). Returns the in-memory cache on subsequent calls.
 */
function loadMemory() {
  if (memory !== null) return memory;

  try {
    if (fs.existsSync(MEMORY_FILE)) {
      memory = JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
    } else {
      memory = {};
    }
  } catch (err) {
    console.error('Failed to load project memory, starting fresh:', err.message);
    memory = {};
  }

  return memory;
}

/**
 * Debounced write — waits 1 second after the last change before flushing to disk.
 * Timer resets if another change arrives within the window.
 */
function scheduleSave() {
  if (saveTimer) {
    clearTimeout(saveTimer);
  }

  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(path.dirname(MEMORY_FILE), { recursive: true });
      fs.writeFileSync(MEMORY_FILE, JSON.stringify(memory, null, 2));
    } catch (err) {
      console.error('Failed to save project memory:', err.message);
    }
  }, 1000);
}

/**
 * Composite key for the user+repo pair.
 * @param {string} userId
 * @param {string} repo - 'owner/repo' format
 * @returns {string}
 */
function memoryKey(userId, repo) {
  return `${userId}:${repo}`;
}

/**
 * Default shape for a fresh memory entry.
 */
function defaultEntry() {
  return {
    issuesWorkedOn: [],
    keyFindings: [],
    lastAccessed: Date.now(),
  };
}

/**
 * Get the memory object for a user+repo pair.
 * Returns a copy merged with defaults so callers always see every expected key.
 *
 * @param {string} userId
 * @param {string} repo
 * @returns {Object}
 */
function getMemory(userId, repo) {
  const data = loadMemory();
  const key = memoryKey(userId, repo);
  return { ...defaultEntry(), ...(data[key] || {}) };
}

/**
 * Add or update a key in the memory for a user+repo pair.
 *
 * Special handling:
 * - 'issuesWorkedOn': appends to the array (deduplicates)
 * - 'keyFindings':    appends to the array (capped at MAX_KEY_FINDINGS, oldest dropped)
 * - anything else:    set directly
 *
 * @param {string} userId
 * @param {string} repo
 * @param {string} key
 * @param {*}      value
 */
function addMemoryEntry(userId, repo, key, value) {
  const data = loadMemory();
  const mKey = memoryKey(userId, repo);

  if (!data[mKey]) {
    data[mKey] = defaultEntry();
  }

  const entry = data[mKey];

  if (key === 'issuesWorkedOn') {
    if (!Array.isArray(entry.issuesWorkedOn)) {
      entry.issuesWorkedOn = [];
    }
    if (!entry.issuesWorkedOn.includes(value)) {
      entry.issuesWorkedOn.push(value);
    }
  } else if (key === 'keyFindings') {
    if (!Array.isArray(entry.keyFindings)) {
      entry.keyFindings = [];
    }
    // Avoid exact duplicates
    if (!entry.keyFindings.includes(value)) {
      entry.keyFindings.push(value);
      // Evict oldest entries when over the cap
      while (entry.keyFindings.length > MAX_KEY_FINDINGS) {
        entry.keyFindings.shift();
      }
    }
  } else {
    entry[key] = value;
  }

  entry.lastAccessed = Date.now();
  scheduleSave();
}

/**
 * Build a formatted string summary of the memory for a user+repo pair,
 * suitable for injection into the system prompt.
 *
 * @param {string} userId
 * @param {string} repo
 * @returns {string|null} Summary string, or null if no memory exists
 */
function getMemorySummary(userId, repo) {
  const data = loadMemory();
  const key = memoryKey(userId, repo);
  const entry = data[key];

  if (!entry) return null;

  const lines = [`Repository: ${repo}`];

  if (entry.issuesWorkedOn && entry.issuesWorkedOn.length > 0) {
    lines.push(`Issues previously worked on: ${entry.issuesWorkedOn.map(n => `#${n}`).join(', ')}`);
  }

  if (entry.keyFindings && entry.keyFindings.length > 0) {
    lines.push(`Key findings about this codebase:`);
    for (const finding of entry.keyFindings) {
      lines.push(`  - ${finding}`);
    }
  }

  if (entry.lastAccessed) {
    const ago = Date.now() - entry.lastAccessed;
    const hours = Math.floor(ago / (1000 * 60 * 60));
    if (hours < 1) {
      lines.push(`Last accessed: less than an hour ago`);
    } else if (hours < 24) {
      lines.push(`Last accessed: ${hours} hour${hours === 1 ? '' : 's'} ago`);
    } else {
      const days = Math.floor(hours / 24);
      lines.push(`Last accessed: ${days} day${days === 1 ? '' : 's'} ago`);
    }
  }

  // Only return a summary if there is meaningful content beyond just the repo name
  if (lines.length <= 1) return null;

  return lines.join('\n');
}

/**
 * Clear all memory for a specific user+repo pair.
 *
 * @param {string} userId
 * @param {string} repo
 */
function clearMemory(userId, repo) {
  const data = loadMemory();
  const key = memoryKey(userId, repo);

  if (data[key]) {
    delete data[key];
    scheduleSave();
  }
}

module.exports = { getMemory, addMemoryEntry, getMemorySummary, clearMemory };

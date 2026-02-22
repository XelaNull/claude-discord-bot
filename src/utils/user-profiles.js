const fs = require('fs');
const path = require('path');
const config = require('./config');

const PROFILES_FILE = path.join(config.dataDir, 'user-profiles.json');

const DEFAULT_PROFILE = {
  defaultRepo: null,
  gitName: null,
  gitEmail: null,
  branchPrefix: 'fix',
};

// ── In-memory cache ─────────────────────────────────────────────────────
let profiles = null;
let saveTimer = null;

/**
 * Load profiles from disk (once). Returns the in-memory cache on subsequent calls.
 */
function loadProfiles() {
  if (profiles !== null) return profiles;

  try {
    if (fs.existsSync(PROFILES_FILE)) {
      profiles = JSON.parse(fs.readFileSync(PROFILES_FILE, 'utf8'));
    } else {
      profiles = {};
    }
  } catch (err) {
    console.error('Failed to load user profiles, starting fresh:', err.message);
    profiles = {};
  }

  return profiles;
}

/**
 * Debounced write — waits 1 second after the last change before flushing to disk.
 * If another change arrives within that window the timer resets.
 */
function scheduleSave() {
  if (saveTimer) {
    clearTimeout(saveTimer);
  }

  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(path.dirname(PROFILES_FILE), { recursive: true });
      fs.writeFileSync(PROFILES_FILE, JSON.stringify(profiles, null, 2));
    } catch (err) {
      console.error('Failed to save user profiles:', err.message);
    }
  }, 1000);
}

/**
 * Get a user's profile. Returns a copy merged with defaults so callers
 * always see every expected key.
 *
 * @param {string} userId
 * @returns {Object} profile
 */
function getProfile(userId) {
  const data = loadProfiles();
  return { ...DEFAULT_PROFILE, ...(data[userId] || {}) };
}

/**
 * Set a single key on a user's profile.
 *
 * @param {string} userId
 * @param {string} key   - One of the profile keys (e.g. 'defaultRepo')
 * @param {*}      value
 */
function setProfile(userId, key, value) {
  const data = loadProfiles();

  if (!data[userId]) {
    data[userId] = { ...DEFAULT_PROFILE };
  }

  data[userId][key] = value;
  scheduleSave();
}

/**
 * Get all profiles (returns the full map, keyed by userId).
 *
 * @returns {Object}
 */
function getAllProfiles() {
  return { ...loadProfiles() };
}

module.exports = { getProfile, setProfile, getAllProfiles };

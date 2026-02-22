const { getToken } = require('./token-store');
const { getOctokit } = require('../tools/github');

// In-memory cache: userId -> { data: { name, email, login }, timestamp }
const cache = new Map();
const TTL = 60 * 60 * 1000; // 1 hour

/**
 * Fetch GitHub identity (name, email, login) for a Discord user.
 * Uses their stored PAT to call the GitHub API, with 1-hour caching.
 *
 * @param {string} discordUserId - Discord user ID
 * @returns {Promise<{ name: string, email: string, login: string }>}
 */
async function getGitIdentity(discordUserId) {
  // Check cache
  const cached = cache.get(discordUserId);
  if (cached && Date.now() - cached.timestamp < TTL) {
    return cached.data;
  }

  // Get PAT from encrypted token store
  const token = getToken(discordUserId);
  if (!token) {
    throw new Error(
      'No GitHub token found. DM me your PAT (starts with ghp_ or github_pat_) to register it.'
    );
  }

  // Fetch profile from GitHub API
  const octokit = getOctokit(token);
  const { data: user } = await octokit.users.getAuthenticated();

  // Build identity with fallbacks:
  //   name  -> login if no display name set
  //   email -> GitHub noreply address if no public email
  const identity = {
    name: user.name || user.login,
    email: user.email || `${user.id}+${user.login}@users.noreply.github.com`,
    login: user.login
  };

  // Cache the result
  cache.set(discordUserId, { data: identity, timestamp: Date.now() });

  return identity;
}

module.exports = { getGitIdentity };

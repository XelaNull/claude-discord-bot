import { Octokit } from '@octokit/rest';
import { config } from '../utils/config.js';
import { getToken } from '../utils/token-store.js';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { scratchPath } from '../utils/scratch.js';

// Cache Octokit instances per token to avoid re-creating them
const octokitCache = new Map();

/**
 * Get an Octokit instance for the given context.
 * Priority: user's personal PAT > bot's default token.
 * Returns { octokit, source } where source describes whose token is being used.
 */
function getOctokit(context = {}) {
  // Try user's personal token first
  let token = null;
  let source = 'none';

  if (context.discordUserId) {
    const userToken = getToken(context.discordUserId);
    if (userToken) {
      token = userToken;
      source = 'personal';
    }
  }

  // Fall back to bot's default token
  if (!token && config.githubToken) {
    token = config.githubToken;
    source = 'bot-default';
  }

  if (!token) {
    throw new Error(
      'No GitHub token available. Either configure GITHUB_TOKEN in the bot, ' +
      'or DM me with `!claude token set ghp_YOUR_TOKEN` to register your personal access token.'
    );
  }

  // Cache by token (first 8 chars as key to avoid storing full token in memory as a map key)
  const cacheKey = token.slice(0, 8) + token.slice(-4);
  if (!octokitCache.has(cacheKey)) {
    octokitCache.set(cacheKey, new Octokit({ auth: token }));
  }

  return { octokit: octokitCache.get(cacheKey), source, token };
}

/**
 * Resolve which token to use for a fetch request (file downloads).
 */
function getAuthToken(context = {}) {
  if (context.discordUserId) {
    const userToken = getToken(context.discordUserId);
    if (userToken) return userToken;
  }
  return config.githubToken || null;
}

function parseRepo(repoStr) {
  const repo = repoStr || config.defaultRepo;
  if (!repo || !repo.includes('/')) {
    throw new Error(`Invalid repo format: "${repo}". Expected "owner/repo".`);
  }
  const [owner, name] = repo.split('/');
  return { owner, repo: name };
}

// --- Tool definitions ---

export const toolDefinitions = [
  {
    name: 'github_list_issues',
    description: 'List issues from a GitHub repository. Returns issue numbers, titles, labels, and state.',
    input_schema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository in "owner/repo" format. Uses default repo if omitted.' },
        state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Filter by state. Default: open.' },
        labels: { type: 'string', description: 'Comma-separated list of label names to filter by.' },
        per_page: { type: 'number', description: 'Results per page (max 100). Default: 20.' },
        page: { type: 'number', description: 'Page number. Default: 1.' },
      },
      required: [],
    },
  },
  {
    name: 'github_get_issue',
    description: 'Get a specific GitHub issue with its full body and comments.',
    input_schema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository in "owner/repo" format. Uses default repo if omitted.' },
        issue_number: { type: 'number', description: 'The issue number to fetch.' },
      },
      required: ['issue_number'],
    },
  },
  {
    name: 'github_comment_issue',
    description: 'Post a comment on a GitHub issue. The comment will be posted using the requesting user\'s GitHub identity if they have registered a personal access token.',
    input_schema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository in "owner/repo" format. Uses default repo if omitted.' },
        issue_number: { type: 'number', description: 'The issue number to comment on.' },
        body: { type: 'string', description: 'The comment body (supports GitHub Markdown).' },
      },
      required: ['issue_number', 'body'],
    },
  },
  {
    name: 'github_download_issue_files',
    description: 'Download file attachments from a GitHub issue to the scratch space. Extracts URLs from issue body and comments.',
    input_schema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository in "owner/repo" format. Uses default repo if omitted.' },
        issue_number: { type: 'number', description: 'The issue number to download files from.' },
      },
      required: ['issue_number'],
    },
  },
  {
    name: 'github_get_file',
    description: 'Download a specific file from a GitHub repository.',
    input_schema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository in "owner/repo" format. Uses default repo if omitted.' },
        path: { type: 'string', description: 'File path within the repository.' },
        ref: { type: 'string', description: 'Branch, tag, or commit SHA. Default: default branch.' },
      },
      required: ['path'],
    },
  },
];

// --- Tool handlers ---
// All handlers accept (input, context) where context = { discordUserId }

export async function github_list_issues({ repo, state = 'open', labels, per_page = 20, page = 1 }, context) {
  const { owner, repo: repoName } = parseRepo(repo);
  const { octokit: ok, source } = getOctokit(context);

  const params = { owner, repo: repoName, state, per_page: Math.min(per_page, 100), page };
  if (labels) params.labels = labels;

  const { data } = await ok.issues.listForRepo(params);

  return {
    auth_source: source,
    issues: data.map(issue => ({
      number: issue.number,
      title: issue.title,
      state: issue.state,
      labels: issue.labels.map(l => (typeof l === 'string' ? l : l.name)),
      author: issue.user?.login,
      created_at: issue.created_at,
      comments: issue.comments,
      is_pull_request: !!issue.pull_request,
    })),
  };
}

export async function github_get_issue({ repo, issue_number }, context) {
  const { owner, repo: repoName } = parseRepo(repo);
  const { octokit: ok, source } = getOctokit(context);

  const [{ data: issue }, { data: comments }] = await Promise.all([
    ok.issues.get({ owner, repo: repoName, issue_number }),
    ok.issues.listComments({ owner, repo: repoName, issue_number, per_page: 100 }),
  ]);

  return {
    auth_source: source,
    number: issue.number,
    title: issue.title,
    state: issue.state,
    author: issue.user?.login,
    created_at: issue.created_at,
    labels: issue.labels.map(l => (typeof l === 'string' ? l : l.name)),
    body: issue.body || '(empty)',
    comments: comments.map(c => ({
      author: c.user?.login,
      created_at: c.created_at,
      body: c.body,
    })),
  };
}

export async function github_comment_issue({ repo, issue_number, body }, context) {
  const { owner, repo: repoName } = parseRepo(repo);
  const { octokit: ok, source } = getOctokit(context);

  // Look up who will be posting this comment
  let actingAs = 'bot-default-account';
  try {
    const { data: user } = await ok.users.getAuthenticated();
    actingAs = user.login;
  } catch {
    // Non-critical — just won't show the username
  }

  const { data } = await ok.issues.createComment({
    owner, repo: repoName, issue_number, body,
  });

  return {
    id: data.id,
    url: data.html_url,
    created_at: data.created_at,
    posted_as: actingAs,
    auth_source: source,
  };
}

export async function github_download_issue_files({ repo, issue_number }, context) {
  const { owner, repo: repoName } = parseRepo(repo);
  const { octokit: ok } = getOctokit(context);
  const authToken = getAuthToken(context);

  const [{ data: issue }, { data: comments }] = await Promise.all([
    ok.issues.get({ owner, repo: repoName, issue_number }),
    ok.issues.listComments({ owner, repo: repoName, issue_number, per_page: 100 }),
  ]);

  // Extract file URLs from GitHub's markdown attachment format
  const urlPattern = /https:\/\/(?:github\.com\/.*?\/files\/|user-images\.githubusercontent\.com\/|github\.com\/user-attachments\/)[^\s)]+/g;

  const allText = [issue.body || '', ...comments.map(c => c.body || '')].join('\n');
  const urls = [...new Set(allText.match(urlPattern) || [])];

  if (urls.length === 0) {
    return { message: 'No downloadable file attachments found in this issue.', files: [] };
  }

  const destDir = scratchPath(`issue-${issue_number}-files`);
  mkdirSync(destDir, { recursive: true });

  const downloaded = [];
  for (const url of urls) {
    try {
      const filename = decodeURIComponent(url.split('/').pop().split('?')[0]);
      const resp = await fetch(url, {
        headers: authToken ? { Authorization: `token ${authToken}` } : {},
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const buffer = Buffer.from(await resp.arrayBuffer());
      const dest = join(destDir, filename);
      writeFileSync(dest, buffer);
      downloaded.push({ filename, size: buffer.length, path: dest });
    } catch (err) {
      downloaded.push({ url, error: err.message });
    }
  }

  return { directory: destDir, files: downloaded };
}

export async function github_get_file({ repo, path, ref }, context) {
  const { owner, repo: repoName } = parseRepo(repo);
  const { octokit: ok, source } = getOctokit(context);

  const params = { owner, repo: repoName, path };
  if (ref) params.ref = ref;

  const { data } = await ok.repos.getContent(params);

  if (Array.isArray(data)) {
    return { type: 'directory', auth_source: source, entries: data.map(e => ({ name: e.name, type: e.type, size: e.size })) };
  }

  if (data.encoding === 'base64' && data.content) {
    const content = Buffer.from(data.content, 'base64').toString('utf-8');

    // Also save to scratch space
    const dest = scratchPath('github-files', path);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, content);

    return {
      type: 'file',
      auth_source: source,
      path: data.path,
      size: data.size,
      content: content.length > 50000 ? content.slice(0, 50000) + '\n...(truncated)' : content,
      saved_to: dest,
    };
  }

  return { type: 'file', auth_source: source, path: data.path, size: data.size, note: 'Binary file — content not displayed.' };
}

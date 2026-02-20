import { Octokit } from '@octokit/rest';
import { config } from '../utils/config.js';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { scratchPath } from '../utils/scratch.js';

let octokit = null;

function getOctokit() {
  if (!octokit) {
    if (!config.githubToken) {
      throw new Error('GITHUB_TOKEN is not configured. Cannot access GitHub API.');
    }
    octokit = new Octokit({ auth: config.githubToken });
  }
  return octokit;
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
    description: 'Post a comment on a GitHub issue.',
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

export async function github_list_issues({ repo, state = 'open', labels, per_page = 20, page = 1 }) {
  const { owner, repo: repoName } = parseRepo(repo);
  const ok = getOctokit();

  const params = { owner, repo: repoName, state, per_page: Math.min(per_page, 100), page };
  if (labels) params.labels = labels;

  const { data } = await ok.issues.listForRepo(params);

  return data.map(issue => ({
    number: issue.number,
    title: issue.title,
    state: issue.state,
    labels: issue.labels.map(l => (typeof l === 'string' ? l : l.name)),
    author: issue.user?.login,
    created_at: issue.created_at,
    comments: issue.comments,
    is_pull_request: !!issue.pull_request,
  }));
}

export async function github_get_issue({ repo, issue_number }) {
  const { owner, repo: repoName } = parseRepo(repo);
  const ok = getOctokit();

  const [{ data: issue }, { data: comments }] = await Promise.all([
    ok.issues.get({ owner, repo: repoName, issue_number }),
    ok.issues.listComments({ owner, repo: repoName, issue_number, per_page: 100 }),
  ]);

  return {
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

export async function github_comment_issue({ repo, issue_number, body }) {
  const { owner, repo: repoName } = parseRepo(repo);
  const ok = getOctokit();

  const { data } = await ok.issues.createComment({
    owner, repo: repoName, issue_number, body,
  });

  return { id: data.id, url: data.html_url, created_at: data.created_at };
}

export async function github_download_issue_files({ repo, issue_number }) {
  const { owner, repo: repoName } = parseRepo(repo);
  const ok = getOctokit();

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
        headers: config.githubToken ? { Authorization: `token ${config.githubToken}` } : {},
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

export async function github_get_file({ repo, path, ref }) {
  const { owner, repo: repoName } = parseRepo(repo);
  const ok = getOctokit();

  const params = { owner, repo: repoName, path };
  if (ref) params.ref = ref;

  const { data } = await ok.repos.getContent(params);

  if (Array.isArray(data)) {
    return { type: 'directory', entries: data.map(e => ({ name: e.name, type: e.type, size: e.size })) };
  }

  if (data.encoding === 'base64' && data.content) {
    const content = Buffer.from(data.content, 'base64').toString('utf-8');

    // Also save to scratch space
    const dest = scratchPath('github-files', path);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, content);

    return {
      type: 'file',
      path: data.path,
      size: data.size,
      content: content.length > 50000 ? content.slice(0, 50000) + '\n...(truncated)' : content,
      saved_to: dest,
    };
  }

  return { type: 'file', path: data.path, size: data.size, note: 'Binary file — content not displayed.' };
}

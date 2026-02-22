const { Octokit } = require('@octokit/rest');
const { createHash } = require('crypto');
const { preprocessIssue } = require('../utils/issue-preprocessor');

// Cache Octokit instances by SHA256 hash of token (Phase 1 fix: no collision risk)
const octokitCache = new Map();

function getOctokit(token) {
  const key = createHash('sha256').update(token).digest('hex');
  if (!octokitCache.has(key)) {
    octokitCache.set(key, new Octokit({ auth: token }));
  }
  return octokitCache.get(key);
}

function parseRepo(repoStr) {
  const parts = repoStr.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Invalid repo format: "${repoStr}". Expected "owner/repo".`);
  }
  return { owner: parts[0], repo: parts[1] };
}

const tools = [
  {
    name: 'github_get_issue',
    description:
      'Get details of a GitHub issue including title, body, labels, and a compact comment summary (author, date, length, preview). ' +
      'Use github_get_issue_comments to fetch full comment bodies selectively.',
    input_schema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository in owner/repo format' },
        issue_number: { type: 'integer', description: 'Issue number' }
      },
      required: ['repo', 'issue_number']
    },
    handler: async (args, context) => {
      const octokit = getOctokit(context.token);
      const { owner, repo } = parseRepo(args.repo);

      const issue = await octokit.issues.get({ owner, repo, issue_number: args.issue_number });

      // Fetch comment summaries — paginate to get all (100 per page)
      const commentSummaries = [];
      let page = 1;
      while (true) {
        const batch = await octokit.issues.listComments({
          owner, repo, issue_number: args.issue_number, per_page: 100, page
        });
        for (const c of batch.data) {
          commentSummaries.push({
            index: commentSummaries.length + 1,
            id: c.id,
            author: c.user.login,
            created_at: c.created_at,
            length: (c.body || '').length,
            preview: (c.body || '').substring(0, 120).replace(/\n/g, ' ')
          });
        }
        if (batch.data.length < 100) break;
        page++;
      }

      return JSON.stringify({
        number: issue.data.number,
        title: issue.data.title,
        state: issue.data.state,
        body: issue.data.body,
        labels: issue.data.labels.map(l => l.name),
        assignees: issue.data.assignees.map(a => a.login),
        created_at: issue.data.created_at,
        updated_at: issue.data.updated_at,
        comment_count: issue.data.comments,
        comments: commentSummaries
      }, null, 2);
    }
  },

  {
    name: 'github_get_issue_comments',
    description:
      'Fetch the full body of specific comments on a GitHub issue. ' +
      'Use github_get_issue first to see the comment summary, then fetch the ones you need by index or range.',
    input_schema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository in owner/repo format' },
        issue_number: { type: 'integer', description: 'Issue number' },
        indices: {
          type: 'array',
          items: { type: 'integer' },
          description: 'Comment indices to fetch (1-based, from the summary). Example: [3, 5, 12]'
        },
        from: { type: 'integer', description: 'Fetch a range starting at this index (1-based, inclusive). Use with "to".' },
        to: { type: 'integer', description: 'Fetch a range ending at this index (1-based, inclusive). Use with "from".' }
      },
      required: ['repo', 'issue_number']
    },
    handler: async (args, context) => {
      const octokit = getOctokit(context.token);
      const { owner, repo } = parseRepo(args.repo);

      // Fetch all comments (paginated)
      const allComments = [];
      let page = 1;
      while (true) {
        const batch = await octokit.issues.listComments({
          owner, repo, issue_number: args.issue_number, per_page: 100, page
        });
        allComments.push(...batch.data);
        if (batch.data.length < 100) break;
        page++;
      }

      // Determine which indices to return
      let indices = [];
      if (args.indices && args.indices.length > 0) {
        indices = args.indices;
      } else if (args.from || args.to) {
        const from = args.from || 1;
        const to = args.to || allComments.length;
        for (let i = from; i <= to; i++) indices.push(i);
      } else {
        // Default: return all (but this tool is meant for selective use)
        for (let i = 1; i <= allComments.length; i++) indices.push(i);
      }

      const results = [];
      for (const idx of indices) {
        if (idx < 1 || idx > allComments.length) {
          results.push({ index: idx, error: `No comment at index ${idx} (total: ${allComments.length})` });
          continue;
        }
        const c = allComments[idx - 1];
        results.push({
          index: idx,
          id: c.id,
          author: c.user.login,
          created_at: c.created_at,
          body: c.body
        });
      }

      return JSON.stringify(results, null, 2);
    }
  },

  {
    name: 'github_create_issue_comment',
    description: 'Post a comment on a GitHub issue.',
    input_schema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository in owner/repo format' },
        issue_number: { type: 'integer', description: 'Issue number' },
        body: { type: 'string', description: 'Comment body (markdown supported)' }
      },
      required: ['repo', 'issue_number', 'body']
    },
    handler: async (args, context) => {
      const octokit = getOctokit(context.token);
      const { owner, repo } = parseRepo(args.repo);

      const comment = await octokit.issues.createComment({
        owner, repo,
        issue_number: args.issue_number,
        body: args.body
      });

      return JSON.stringify({
        id: comment.data.id,
        url: comment.data.html_url,
        created_at: comment.data.created_at
      }, null, 2);
    }
  },

  {
    name: 'github_list_issues',
    description: 'List issues in a repository with optional filtering by state, labels, or assignee.',
    input_schema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository in owner/repo format' },
        state: { type: 'string', enum: ['open', 'closed', 'all'], description: 'Filter by state (default: open)' },
        labels: { type: 'string', description: 'Comma-separated label names to filter by' },
        assignee: { type: 'string', description: 'Filter by assignee login' },
        per_page: { type: 'integer', description: 'Results per page (max 100, default 30)' }
      },
      required: ['repo']
    },
    handler: async (args, context) => {
      const octokit = getOctokit(context.token);
      const { owner, repo } = parseRepo(args.repo);

      const issues = await octokit.issues.listForRepo({
        owner, repo,
        state: args.state || 'open',
        labels: args.labels,
        assignee: args.assignee,
        per_page: args.per_page || 30
      });

      const result = issues.data
        .filter(i => !i.pull_request)
        .map(i => ({
          number: i.number,
          title: i.title,
          state: i.state,
          labels: i.labels.map(l => l.name),
          assignees: i.assignees.map(a => a.login),
          created_at: i.created_at,
          comments: i.comments
        }));

      return JSON.stringify(result, null, 2);
    }
  },

  {
    name: 'github_get_file',
    description: 'Get the contents of a file from a GitHub repository via the API (without cloning).',
    input_schema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository in owner/repo format' },
        path: { type: 'string', description: 'File path in the repository' },
        ref: { type: 'string', description: 'Branch, tag, or commit SHA (default: default branch)' }
      },
      required: ['repo', 'path']
    },
    handler: async (args, context) => {
      const octokit = getOctokit(context.token);
      const { owner, repo } = parseRepo(args.repo);

      const params = { owner, repo, path: args.path };
      if (args.ref) params.ref = args.ref;

      const file = await octokit.repos.getContent(params);

      if (file.data.type !== 'file') {
        return JSON.stringify({ error: `Path "${args.path}" is a ${file.data.type}, not a file.` });
      }

      const content = Buffer.from(file.data.content, 'base64').toString('utf8');
      return JSON.stringify({
        path: file.data.path,
        size: file.data.size,
        sha: file.data.sha,
        content
      }, null, 2);
    }
  },

  {
    name: 'github_list_repos',
    description: 'List repositories accessible to the authenticated user.',
    input_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['all', 'owner', 'public', 'private', 'member'], description: 'Type filter (default: all)' },
        sort: { type: 'string', enum: ['created', 'updated', 'pushed', 'full_name'], description: 'Sort by (default: updated)' },
        per_page: { type: 'integer', description: 'Results per page (max 100, default 30)' }
      }
    },
    handler: async (args, context) => {
      const octokit = getOctokit(context.token);

      const repos = await octokit.repos.listForAuthenticatedUser({
        type: args.type || 'all',
        sort: args.sort || 'updated',
        per_page: args.per_page || 30
      });

      const result = repos.data.map(r => ({
        full_name: r.full_name,
        description: r.description,
        language: r.language,
        private: r.private,
        default_branch: r.default_branch,
        updated_at: r.updated_at,
        open_issues: r.open_issues_count
      }));

      return JSON.stringify(result, null, 2);
    }
  },

  {
    name: 'github_get_repo_info',
    description: 'Get detailed information about a GitHub repository.',
    input_schema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository in owner/repo format' }
      },
      required: ['repo']
    },
    handler: async (args, context) => {
      const octokit = getOctokit(context.token);
      const { owner, repo } = parseRepo(args.repo);

      const repoData = await octokit.repos.get({ owner, repo });
      const r = repoData.data;

      return JSON.stringify({
        full_name: r.full_name,
        description: r.description,
        language: r.language,
        private: r.private,
        fork: r.fork,
        default_branch: r.default_branch,
        created_at: r.created_at,
        updated_at: r.updated_at,
        pushed_at: r.pushed_at,
        size: r.size,
        open_issues: r.open_issues_count,
        forks: r.forks_count,
        watchers: r.watchers_count,
        topics: r.topics,
        license: r.license?.spdx_id,
        parent: r.parent ? r.parent.full_name : null
      }, null, 2);
    }
  },

  // === Phase 4: GitHub Write Tools ===

  {
    name: 'github_create_branch',
    description: 'Create a new branch from a base ref via the GitHub API.',
    input_schema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository in owner/repo format' },
        branch_name: { type: 'string', description: 'Name for the new branch' },
        base_ref: { type: 'string', description: 'Base branch/tag/SHA (default: default branch)' }
      },
      required: ['repo', 'branch_name']
    },
    handler: async (args, context) => {
      const octokit = getOctokit(context.token);
      const { owner, repo } = parseRepo(args.repo);

      // Get the SHA of the base ref
      let baseSha;
      if (args.base_ref) {
        const ref = await octokit.git.getRef({ owner, repo, ref: `heads/${args.base_ref}` }).catch(() => null);
        if (ref) {
          baseSha = ref.data.object.sha;
        } else {
          const commit = await octokit.git.getCommit({ owner, repo, commit_sha: args.base_ref });
          baseSha = commit.data.sha;
        }
      } else {
        const repoInfo = await octokit.repos.get({ owner, repo });
        const defaultBranch = repoInfo.data.default_branch;
        const ref = await octokit.git.getRef({ owner, repo, ref: `heads/${defaultBranch}` });
        baseSha = ref.data.object.sha;
      }

      await octokit.git.createRef({
        owner, repo,
        ref: `refs/heads/${args.branch_name}`,
        sha: baseSha
      });

      return JSON.stringify({
        status: 'created',
        branch: args.branch_name,
        base_sha: baseSha
      }, null, 2);
    }
  },

  {
    name: 'github_create_pr',
    description: 'Open a pull request on a GitHub repository.',
    input_schema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository in owner/repo format' },
        title: { type: 'string', description: 'PR title' },
        body: { type: 'string', description: 'PR description body (markdown)' },
        head: { type: 'string', description: 'Source branch (or user:branch for cross-repo)' },
        base: { type: 'string', description: 'Target branch (default: default branch)' },
        draft: { type: 'boolean', description: 'Create as draft PR (default: false)' },
        issue_number: { type: 'integer', description: 'Issue number to reference with "Fixes #N"' }
      },
      required: ['repo', 'title', 'head']
    },
    handler: async (args, context) => {
      const octokit = getOctokit(context.token);
      const { owner, repo } = parseRepo(args.repo);

      let body = args.body || '';
      if (args.issue_number) {
        body = `Fixes #${args.issue_number}\n\n${body}`;
      }

      let base = args.base;
      if (!base) {
        const repoInfo = await octokit.repos.get({ owner, repo });
        base = repoInfo.data.default_branch;
      }

      const pr = await octokit.pulls.create({
        owner, repo,
        title: args.title,
        body,
        head: args.head,
        base,
        draft: args.draft || false
      });

      return JSON.stringify({
        number: pr.data.number,
        url: pr.data.html_url,
        state: pr.data.state,
        draft: pr.data.draft,
        head: pr.data.head.ref,
        base: pr.data.base.ref
      }, null, 2);
    }
  },

  {
    name: 'github_fork_repo',
    description: "Fork a repository to the authenticated user's account. If fork already exists, returns it.",
    input_schema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository in owner/repo format' }
      },
      required: ['repo']
    },
    handler: async (args, context) => {
      const octokit = getOctokit(context.token);
      const { owner, repo } = parseRepo(args.repo);

      // Check if fork already exists
      const user = await octokit.users.getAuthenticated();
      const login = user.data.login;

      try {
        const existing = await octokit.repos.get({ owner: login, repo });
        if (existing.data.fork) {
          return JSON.stringify({
            status: 'existing_fork',
            full_name: existing.data.full_name,
            clone_url: existing.data.clone_url,
            default_branch: existing.data.default_branch
          }, null, 2);
        }
      } catch (_) {
        // Fork doesn't exist, create it
      }

      const fork = await octokit.repos.createFork({ owner, repo });

      // Poll until fork is ready (async creation)
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 2000));
        try {
          const check = await octokit.repos.get({ owner: login, repo });
          if (check.data.size > 0) {
            return JSON.stringify({
              status: 'created',
              full_name: check.data.full_name,
              clone_url: check.data.clone_url,
              default_branch: check.data.default_branch
            }, null, 2);
          }
        } catch (_) {}
      }

      return JSON.stringify({
        status: 'pending',
        full_name: fork.data.full_name,
        message: 'Fork created but may still be processing. Try again in a moment.'
      }, null, 2);
    }
  },

  {
    name: 'github_check_permissions',
    description: "Check the authenticated user's permission level on a repository.",
    input_schema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository in owner/repo format' }
      },
      required: ['repo']
    },
    handler: async (args, context) => {
      const octokit = getOctokit(context.token);
      const { owner, repo } = parseRepo(args.repo);

      try {
        const user = await octokit.users.getAuthenticated();
        const perm = await octokit.repos.getCollaboratorPermissionLevel({
          owner, repo,
          username: user.data.login
        });

        return JSON.stringify({
          user: user.data.login,
          permission: perm.data.permission, // admin, write, read, none
          can_push: ['admin', 'write'].includes(perm.data.permission)
        }, null, 2);
      } catch (err) {
        if (err.status === 403 || err.status === 404) {
          return JSON.stringify({ permission: 'none', can_push: false }, null, 2);
        }
        throw err;
      }
    }
  },

  {
    name: 'github_get_pr',
    description: 'Get details of a pull request including diff, reviews, and comments.',
    input_schema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository in owner/repo format' },
        pull_number: { type: 'integer', description: 'Pull request number' },
        include_diff: { type: 'boolean', description: 'Include the full diff (default: false)' }
      },
      required: ['repo', 'pull_number']
    },
    handler: async (args, context) => {
      const octokit = getOctokit(context.token);
      const { owner, repo } = parseRepo(args.repo);

      const [pr, reviews, comments] = await Promise.all([
        octokit.pulls.get({ owner, repo, pull_number: args.pull_number }),
        octokit.pulls.listReviews({ owner, repo, pull_number: args.pull_number }),
        octokit.pulls.listReviewComments({ owner, repo, pull_number: args.pull_number })
      ]);

      const result = {
        number: pr.data.number,
        title: pr.data.title,
        state: pr.data.state,
        draft: pr.data.draft,
        body: pr.data.body,
        head: pr.data.head.ref,
        base: pr.data.base.ref,
        user: pr.data.user.login,
        mergeable: pr.data.mergeable,
        additions: pr.data.additions,
        deletions: pr.data.deletions,
        changed_files: pr.data.changed_files,
        reviews: reviews.data.map(r => ({
          user: r.user.login,
          state: r.state,
          body: r.body
        })),
        comments: comments.data.map(c => ({
          user: c.user.login,
          path: c.path,
          line: c.line,
          body: c.body
        }))
      };

      if (args.include_diff) {
        const diff = await octokit.pulls.get({
          owner, repo, pull_number: args.pull_number,
          mediaType: { format: 'diff' }
        });
        result.diff = diff.data;
      }

      return JSON.stringify(result, null, 2);
    }
  },

  {
    name: 'github_search',
    description: 'Search GitHub for issues/PRs, repositories, or code.',
    input_schema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['issues', 'repos', 'code'],
          description: 'What to search: "issues" (issues & PRs), "repos" (repositories), "code" (code content)'
        },
        query: { type: 'string', description: 'Search query (GitHub search syntax)' },
        repo: { type: 'string', description: 'Limit to specific repo (owner/repo format)' },
        sort: {
          type: 'string',
          description: 'Sort by — issues: created/updated/comments; repos: stars/forks/updated; code: indexed'
        },
        path_filter: { type: 'string', description: 'Filter by file path — code search only (e.g., "src/")' },
        extension: { type: 'string', description: 'Filter by file extension — code search only (e.g., "js")' },
        per_page: { type: 'integer', description: 'Results per page (max 100, default 20)' }
      },
      required: ['type', 'query']
    },
    handler: async (args, context) => {
      const octokit = getOctokit(context.token);
      const perPage = args.per_page || 20;

      switch (args.type) {
        case 'issues': {
          let q = args.query;
          if (args.repo) q += ` repo:${args.repo}`;

          const results = await octokit.search.issuesAndPullRequests({
            q,
            sort: args.sort,
            per_page: perPage
          });

          const items = results.data.items.map(i => ({
            number: i.number,
            title: i.title,
            state: i.state,
            repo: i.repository_url.split('/').slice(-2).join('/'),
            is_pr: !!i.pull_request,
            labels: i.labels.map(l => l.name),
            created_at: i.created_at
          }));

          return JSON.stringify({ total_count: results.data.total_count, items }, null, 2);
        }

        case 'repos': {
          const results = await octokit.search.repos({
            q: args.query,
            sort: args.sort,
            per_page: perPage
          });

          const items = results.data.items.map(r => ({
            full_name: r.full_name,
            description: r.description,
            language: r.language,
            stars: r.stargazers_count,
            forks: r.forks_count,
            updated_at: r.updated_at
          }));

          return JSON.stringify({ total_count: results.data.total_count, items }, null, 2);
        }

        case 'code': {
          let q = args.query;
          if (args.repo) q += ` repo:${args.repo}`;
          if (args.path_filter) q += ` path:${args.path_filter}`;
          if (args.extension) q += ` extension:${args.extension}`;

          const results = await octokit.search.code({
            q,
            per_page: perPage
          });

          const items = results.data.items.map(i => ({
            path: i.path,
            repo: i.repository.full_name,
            sha: i.sha,
            url: i.html_url,
            score: i.score
          }));

          return JSON.stringify({ total_count: results.data.total_count, items }, null, 2);
        }

        default:
          throw new Error(`Unknown search type: "${args.type}". Use "issues", "repos", or "code".`);
      }
    }
  },

  // === Phase 8: PR Code Review Tool ===

  {
    name: 'github_review_pr',
    description: 'Analyze a pull request and post a code review with line-specific comments.',
    input_schema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository in owner/repo format' },
        pull_number: { type: 'integer', description: 'Pull request number' },
        review_body: { type: 'string', description: 'Overall review comment' },
        event: { type: 'string', enum: ['APPROVE', 'REQUEST_CHANGES', 'COMMENT'], description: 'Review action (default: COMMENT)' },
        comments: {
          type: 'array',
          description: 'Line-specific review comments',
          items: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'File path' },
              line: { type: 'integer', description: 'Line number to comment on' },
              body: { type: 'string', description: 'Comment text' }
            },
            required: ['path', 'line', 'body']
          }
        }
      },
      required: ['repo', 'pull_number']
    },
    handler: async (args, context) => {
      const octokit = getOctokit(context.token);
      const { owner, repo } = parseRepo(args.repo);

      const reviewParams = {
        owner, repo,
        pull_number: args.pull_number,
        event: args.event || 'COMMENT',
        body: args.review_body || ''
      };

      if (args.comments && args.comments.length > 0) {
        reviewParams.comments = args.comments.map(c => ({
          path: c.path,
          line: c.line,
          body: c.body
        }));
      }

      const review = await octokit.pulls.createReview(reviewParams);

      return JSON.stringify({
        review_id: review.data.id,
        state: review.data.state,
        comments_count: args.comments?.length || 0,
        url: review.data.html_url
      }, null, 2);
    }
  },

  // === Issue Pre-Processor — extract attachments, classify, auto-download ===

  {
    name: 'github_analyze_issue',
    description:
      'Fetch a GitHub issue, extract all attachments (logs, images, archives), classify them, ' +
      'and auto-download text/log files for analysis. Returns a structured manifest with attachment ' +
      'inventory and local file paths. Use this FIRST when investigating an issue — it replaces the ' +
      'need to manually call github_get_issue + web_download separately.',
    input_schema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository in owner/repo format' },
        issue_number: { type: 'integer', description: 'Issue number' }
      },
      required: ['repo', 'issue_number']
    },
    handler: async (args, context) => {
      const octokit = getOctokit(context.token);
      const { owner, repo } = parseRepo(args.repo);

      // Fetch issue
      const issue = await octokit.issues.get({ owner, repo, issue_number: args.issue_number });

      // Fetch all comments (paginated)
      const allComments = [];
      let page = 1;
      while (true) {
        const batch = await octokit.issues.listComments({
          owner, repo, issue_number: args.issue_number, per_page: 100, page
        });
        allComments.push(...batch.data);
        if (batch.data.length < 100) break;
        page++;
      }

      // Run the preprocessor — extracts attachments, classifies, downloads logs
      const manifest = await preprocessIssue(
        {
          number: issue.data.number,
          title: issue.data.title,
          body: issue.data.body
        },
        allComments,
        context.token
      );

      // Add full issue metadata
      manifest.issue.state = issue.data.state;
      manifest.issue.labels = issue.data.labels.map(l => l.name);
      manifest.issue.created_at = issue.data.created_at;
      manifest.issue.body = issue.data.body;

      return JSON.stringify(manifest, null, 2);
    }
  }
];

module.exports = { tools, getOctokit, parseRepo };

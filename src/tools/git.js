const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const config = require('../utils/config');
const { getGitIdentity } = require('../utils/github-identity');
const { checkWorkspaceQuota } = require('../utils/workspace');

/**
 * Resolve the per-user workspace directory for a repo.
 * Layout: {workspaceDir}/users/{userId}/{owner}--{repo}/
 */
function getWorkspaceDir(userId, repoStr) {
  const [owner, repo] = repoStr.split('/');
  if (!owner || !repo) throw new Error('Invalid repo format. Expected "owner/repo".');
  return path.join(config.workspaceDir, 'users', userId, `${owner}--${repo}`);
}

/**
 * Validate that a workspace directory exists and is a git repo.
 */
function requireWorkspace(cwd) {
  if (!fs.existsSync(cwd)) {
    throw new Error(
      'Repository not found in workspace. Use repo_clone first to set up the workspace.'
    );
  }
  if (!fs.existsSync(path.join(cwd, '.git'))) {
    throw new Error(
      'Directory exists but is not a git repository. Use repo_clone to initialize it.'
    );
  }
}

/**
 * Run a git command safely (no shell) with consistent options.
 */
function git(args, cwd, env) {
  return execFileSync('git', args, {
    cwd,
    env: env || process.env,
    timeout: 60000,
    encoding: 'utf8',
    stdio: 'pipe'
  });
}

const tools = [
  // ─── git_status ────────────────────────────────────────────────
  {
    name: 'git_status',
    description: 'Show the working tree status of a cloned repository (staged, unstaged, and untracked files).',
    input_schema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository in owner/repo format' }
      },
      required: ['repo']
    },
    handler: async (args, context) => {
      const cwd = getWorkspaceDir(context.userId, args.repo);
      requireWorkspace(cwd);
      const output = git(['status'], cwd);
      return output || '(working tree clean)';
    }
  },

  // ─── git_branch ────────────────────────────────────────────────
  {
    name: 'git_branch',
    description: 'List, create, or switch branches in a cloned repository.',
    input_schema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository in owner/repo format' },
        action: {
          type: 'string',
          enum: ['list', 'create', 'switch'],
          description: 'Branch action: list all branches, create a new branch, or switch to an existing branch'
        },
        branch_name: {
          type: 'string',
          description: 'Branch name (required for create and switch actions)'
        }
      },
      required: ['repo', 'action']
    },
    handler: async (args, context) => {
      const cwd = getWorkspaceDir(context.userId, args.repo);
      requireWorkspace(cwd);

      switch (args.action) {
        case 'list': {
          const output = git(['branch', '-a'], cwd);
          return output || '(no branches)';
        }
        case 'create': {
          if (!args.branch_name) throw new Error('branch_name is required for create action.');
          git(['checkout', '-b', args.branch_name], cwd);
          return `Created and switched to new branch: ${args.branch_name}`;
        }
        case 'switch': {
          if (!args.branch_name) throw new Error('branch_name is required for switch action.');
          git(['checkout', args.branch_name], cwd);
          return `Switched to branch: ${args.branch_name}`;
        }
        default:
          throw new Error(`Unknown action: ${args.action}`);
      }
    }
  },

  // ─── git_commit ────────────────────────────────────────────────
  {
    name: 'git_commit',
    description: 'Stage files and create a commit. Sets the git author/committer to the user\'s GitHub identity.',
    input_schema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository in owner/repo format' },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'File paths to stage (relative to repo root). Use ["."] to stage all changes.'
        },
        message: { type: 'string', description: 'Commit message' }
      },
      required: ['repo', 'files', 'message']
    },
    handler: async (args, context) => {
      const cwd = getWorkspaceDir(context.userId, args.repo);
      requireWorkspace(cwd);

      // Quota check before committing
      const [owner, repo] = args.repo.split('/');
      checkWorkspaceQuota(context.userId, owner, repo);

      // Fetch the user's GitHub identity for author/committer fields
      const identity = await getGitIdentity(context.userId);

      // Build env with git identity overlaid on process.env
      const env = {
        ...process.env,
        GIT_AUTHOR_NAME: identity.name,
        GIT_AUTHOR_EMAIL: identity.email,
        GIT_COMMITTER_NAME: identity.name,
        GIT_COMMITTER_EMAIL: identity.email
      };

      // Stage files
      git(['add', ...args.files], cwd, env);

      // Commit
      const output = git(['commit', '-m', args.message], cwd, env);
      return output;
    }
  },

  // ─── git_push ──────────────────────────────────────────────────
  {
    name: 'git_push',
    description: 'Push a branch to the remote repository. Temporarily injects the user\'s PAT for authentication.',
    input_schema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository in owner/repo format' },
        branch: { type: 'string', description: 'Branch to push (default: current branch)' }
      },
      required: ['repo']
    },
    handler: async (args, context) => {
      const cwd = getWorkspaceDir(context.userId, args.repo);
      requireWorkspace(cwd);

      // Quota check before pushing
      const [owner, repo] = args.repo.split('/');
      checkWorkspaceQuota(context.userId, owner, repo);

      if (!context.token) {
        throw new Error('GitHub PAT is required for push. DM me your PAT to register it.');
      }
      const authedUrl = `https://x-access-token:${context.token}@github.com/${owner}/${repo}.git`;
      const cleanUrl = `https://github.com/${owner}/${repo}.git`;

      // Inject PAT into remote URL for authentication
      git(['remote', 'set-url', 'origin', authedUrl], cwd);

      try {
        // Push (with optional branch, or current branch via --set-upstream)
        const pushArgs = ['push'];
        if (args.branch) {
          pushArgs.push('origin', args.branch);
        } else {
          // Push current branch, setting upstream if needed
          pushArgs.push('-u', 'origin', 'HEAD');
        }

        const output = git(pushArgs, cwd);
        return output || 'Push successful.';
      } finally {
        // ALWAYS remove PAT from remote URL, even if push fails
        try {
          git(['remote', 'set-url', 'origin', cleanUrl], cwd);
        } catch (_) {
          // If cleanup fails, log but don't mask the original error
          console.error('WARNING: Failed to clean PAT from remote URL after push.');
        }
      }
    }
  },

  // ─── git_diff ──────────────────────────────────────────────────
  {
    name: 'git_diff',
    description: 'Show the diff of changes in the working tree, or diff against a specific branch/commit.',
    input_schema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository in owner/repo format' },
        target: {
          type: 'string',
          description: 'Branch name or commit SHA to diff against (default: working tree diff)'
        }
      },
      required: ['repo']
    },
    handler: async (args, context) => {
      const cwd = getWorkspaceDir(context.userId, args.repo);
      requireWorkspace(cwd);

      const diffArgs = ['diff'];
      if (args.target) {
        diffArgs.push(args.target);
      }

      const output = git(diffArgs, cwd);
      return output || '(no differences)';
    }
  },

  // ─── git_log ───────────────────────────────────────────────────
  {
    name: 'git_log',
    description: 'Show recent commit history of the repository.',
    input_schema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repository in owner/repo format' },
        count: {
          type: 'integer',
          description: 'Number of commits to show (default: 10)'
        }
      },
      required: ['repo']
    },
    handler: async (args, context) => {
      const cwd = getWorkspaceDir(context.userId, args.repo);
      requireWorkspace(cwd);

      const count = args.count || 10;
      const output = git(
        ['log', `--max-count=${count}`, '--oneline', '--decorate'],
        cwd
      );
      return output || '(no commits)';
    }
  }
];

module.exports = { tools };

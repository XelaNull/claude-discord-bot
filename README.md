# Codebot — Team Coding Assistant for Discord

An autonomous AI coding assistant for Discord teams, powered by **Claude** (Anthropic). Any team member can say *"fix issue #42 on my repo"* and get a PR back in minutes. Each user works on their own repos with their own GitHub identity.

---

## Features

- **35 tools** across 6 categories (GitHub read/write, repo analysis, code editing, git operations, web, self-management)
- **Per-user encrypted PAT storage** (AES-256-GCM with per-user PBKDF2 key derivation)
- **Claude tool-use loop** with context threading and conversation history
- **Per-user workspace isolation** — each user gets their own cloned repos
- **Full git workflow** — branch, commit, push under user's GitHub identity
- **Issue-to-PR pipeline** — fetch issue, analyze code, fix, commit, push, open PR
- **PR code review** with line-specific comments via GitHub API
- **Codebase analyzer** — auto-detects language, framework, package manager, CI, entry points
- **Error parser** — extracts file paths and line numbers from stack traces (JS, Python, Java, Go, Rust, C#)
- **Interactive confirmations** for destructive operations (Discord buttons)
- **Real-time progress tracking** via editable Discord embeds
- **Slash commands** — `/codefix`, `/codereview`, `/codepat`, `/codestatus`, `/codeask`
- **Per-user profiles** with default repo, git name/email, branch prefix
- **Project memory** — remembers key findings about each codebase
- **Usage tracking** — API calls, tokens, PRs created, issues fixed
- **Docker deployment** with auto-restart and persistent volumes

---

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) v18+
- A Discord bot token ([Discord Developer Portal](https://discord.com/developers/applications))
- An Anthropic API key ([console.anthropic.com](https://console.anthropic.com))

### Installation

```bash
git clone <repo-url>
cd claude-discord-bot
npm install
cp .env.example .env
```

Edit `.env` and fill in your keys:

```env
DISCORD_TOKEN=your_discord_bot_token
ANTHROPIC_API_KEY=your_anthropic_api_key
TOKEN_ENCRYPTION_SECRET=<generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))">
```

### Running

```bash
npm start
```

### Docker

```bash
docker compose up -d
```

---

## GitHub PAT Setup

Each user registers their own GitHub Personal Access Token:

1. **DM the bot** with your PAT (starts with `ghp_` or `github_pat_`)
2. Or use the `/codepat` slash command for secure modal entry
3. The bot encrypts and stores it — your message is deleted immediately
4. Send `remove pat` in DMs to delete your stored token

The PAT is used for all GitHub API calls and git operations under your identity.

---

## Commands

### Prefix Commands (`!code`)

| Command | Description |
|---|---|
| `!code help` | Show help and all capabilities |
| `!code clear` | Clear conversation history for this channel |
| `!code status` | Show your registration and profile status |
| `!code profile` | View your profile |
| `!code profile set repo owner/repo` | Set your default repository |
| `!code profile set name "Name"` | Set git display name |
| `!code profile set email user@example.com` | Set git email |
| `!code workspaces` | List your cloned repos with sizes |
| `!code workspace clean owner/repo` | Delete a workspace |
| `!code usage` | Show your personal usage stats |

### Slash Commands

| Command | Description |
|---|---|
| `/codefix <issue-url>` | Fix an issue and create a PR |
| `/codereview <pr-url>` | Review a pull request |
| `/codepat` | Securely register your GitHub PAT (modal) |
| `/codestatus` | Check your status (ephemeral) |
| `/codeask <question>` | Ask Claude anything |

You can also @mention the bot or talk in active threads without the prefix.

---

## Tools (35 total)

### GitHub (15)
`github_get_issue` `github_get_issue_comments` `github_create_issue_comment` `github_list_issues` `github_get_file` `github_list_repos` `github_get_repo_info` `github_search` `github_create_branch` `github_create_pr` `github_fork_repo` `github_check_permissions` `github_get_pr` `github_review_pr` `github_analyze_issue`

### Repository & Shell (7)
`repo_clone` `repo_list` `repo_read` `repo_analyze` `parse_error` `shell` `analyze_log`

### Code Editing (3)
`file_edit` `file_write` `file_patch`

### Web (3)
`web_search` `web_fetch` `web_download`

### Git Operations (6)
`git_status` `git_branch` `git_commit` `git_push` `git_diff` `git_log`

### Bot Management (1)
`bot_manage`

---

## Project Structure

```
claude-discord-bot/
├── index.js                    # Entry point
├── package.json
├── Dockerfile
├── docker-compose.yml
├── .env.example
├── src/
│   ├── bot.js                  # Discord message handling, commands, threads
│   ├── claude.js               # Claude API with tool-use loop
│   ├── slash-commands.js       # Slash command registration and handling
│   ├── tools/
│   │   ├── index.js            # Tool registry (35 tools)
│   │   ├── github.js           # GitHub API tools (15 tools)
│   │   ├── repo.js             # Repository tools (7 tools)
│   │   ├── patch.js            # Code editing tools (3 tools)
│   │   ├── git.js              # Git workflow tools (6 tools)
│   │   ├── web.js              # Web search/fetch/download (3 tools)
│   │   └── self.js             # Bot management (1 tool)
│   └── utils/
│       ├── config.js           # Configuration management
│       ├── token-store.js      # Encrypted PAT storage (AES-256-GCM)
│       ├── workspace.js        # Per-user workspace isolation
│       ├── paths.js            # Shared path helpers (getRepoDir, validatePath)
│       ├── github-identity.js  # GitHub profile for git config
│       ├── conversation.js     # Per-channel conversation history (persistent)
│       ├── conversation-log.js # Structured session logging
│       ├── chat-threads.js     # Chat thread lifecycle management
│       ├── system-prompt.js    # Dynamic system prompt builder
│       ├── user-profiles.js    # Per-user settings persistence
│       ├── project-memory.js   # Per-user, per-repo memory
│       ├── issue-preprocessor.js # Issue attachment extraction & download
│       ├── log-analyzer.js     # Streaming log file parser
│       ├── progress.js         # Real-time progress embeds
│       ├── confirmation.js     # Interactive button confirmations
│       ├── usage.js            # Per-user usage tracking
│       └── scratch.js          # Non-user scratch space
├── data/                       # Runtime data (gitignored)
│   ├── tokens.enc.json         # Encrypted PATs
│   ├── user-profiles.json      # User settings
│   ├── project-memory.json     # Codebase knowledge
│   ├── usage.json              # Usage stats
│   ├── conversations/          # Persisted conversations
│   └── audit.log               # Token operation audit log
├── scratch/                    # Shared clone space (gitignored)
└── workspaces/                 # Per-user workspaces (gitignored)
    └── users/{userId}/{owner}--{repo}/
```

---

## Discord Bot Permissions

Required permissions when inviting the bot:

- **Read Messages / View Channels**
- **Send Messages**
- **Read Message History**
- **Create Public Threads**
- **Send Messages in Threads**
- **Use External Emojis**
- **Use Slash Commands**

Required gateway intents (enable in Developer Portal):

- **Message Content Intent**

---

## Security

- PATs are encrypted with AES-256-GCM using per-user PBKDF2-derived keys
- Token operations are audit-logged (timestamp + userId, never the token)
- Git operations use `execFileSync` (no shell injection)
- Commands use allowlists, not blocklists
- Path traversal guards on all file operations
- Per-user workspace isolation prevents cross-user access
- PATs injected into git remote URLs are cleaned in `try/finally` blocks

---

## License

MIT

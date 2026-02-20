# Claude Discord Bot

A Claude Code-style AI assistant that runs as a Discord bot. Natural language interface with powerful tool capabilities.

## Features

- **GitHub Integration** — Read/comment on issues, download attachments, browse repo files
- **Web Search** — Search the web via Brave Search API, fetch and parse URLs
- **Repository Analysis** — Clone git repos to a scratch space, browse and read source code
- **File Patching** — Edit and write files in the scratch space with string replacement or unified diffs
- **Self-Modification** — Read, modify, and write its own source code, then trigger a restart
- **Docker** — Runs in a container with auto-restart on crash or self-triggered restart

## Quick Start

### 1. Prerequisites

- [Docker](https://docs.docker.com/get-docker/) and Docker Compose
- A [Discord bot token](https://discord.com/developers/applications)
- An [Anthropic API key](https://console.anthropic.com/)

### 2. Setup

```bash
git clone https://github.com/YOUR_USERNAME/claude-discord-bot.git
cd claude-discord-bot
cp .env.example .env
# Edit .env with your tokens
```

### 3. Run with Docker

```bash
docker compose up -d
```

View logs:
```bash
docker compose logs -f
```

### 4. Run without Docker

```bash
npm install
npm start
```

## Usage

In Discord, mention the bot or use the prefix:

```
@ClaudeBot list open issues on owner/repo
!claude search for OAuth best practices in Node.js
!claude clone owner/repo and explain the project structure
!claude read issue #42 and draft a fix
```

### Built-in Commands

| Command | Description |
|---------|-------------|
| `!claude help` | Show capabilities and examples |
| `!claude status` | Bot status, uptime, scratch usage |
| `!claude clear` | Clear conversation history for this channel |
| `!claude clean` | Clean the scratch space |

## Configuration

See [.env.example](.env.example) for all configuration options.

| Variable | Required | Description |
|----------|----------|-------------|
| `DISCORD_TOKEN` | Yes | Discord bot token |
| `ANTHROPIC_API_KEY` | Yes | Anthropic API key |
| `GITHUB_TOKEN` | No | GitHub PAT for issue/repo access |
| `BRAVE_API_KEY` | No | Brave Search API key for web search |
| `BOT_PREFIX` | No | Command prefix (default: `!claude`) |
| `CLAUDE_MODEL` | No | Claude model (default: `claude-sonnet-4-6-20250514`) |

## Architecture

```
src/
├── index.js              # Entry point, signal handling
├── bot.js                # Discord client, message handling, response splitting
├── claude.js             # Claude API tool-use loop
├── tools/
│   ├── index.js          # Tool registry
│   ├── github.js         # GitHub API tools (Octokit)
│   ├── search.js         # Web search + URL fetching
│   ├── repo.js           # Git clone, file browsing, shell commands
│   ├── patch.js          # File editing (string replace, write, unified diff)
│   └── self.js           # Self-modification and restart
└── utils/
    ├── config.js         # Environment configuration
    ├── conversation.js   # Per-channel conversation history
    └── scratch.js        # Scratch space management
```

The bot uses Claude's **tool-use API** — when a user sends a message, it goes to Claude along with tool definitions. Claude decides which tools to call, the bot executes them, sends results back to Claude, and repeats until Claude produces a final text response.

## Discord Bot Setup

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Create a new application
3. Go to **Bot** tab → **Reset Token** → copy the token
4. Enable **Message Content Intent** under Privileged Gateway Intents
5. Go to **OAuth2** → **URL Generator**
   - Scopes: `bot`
   - Permissions: `Send Messages`, `Read Message History`, `Add Reactions`, `Use External Emojis`
6. Use the generated URL to invite the bot to your server

## Self-Modification

The bot can modify its own source code through Discord commands:

```
!claude read your own source for the github tool
!claude add a new tool that can create GitHub gists
!claude restart to apply changes
```

In Docker, the `src/` directory is volume-mounted so modifications persist. The bot exits cleanly and Docker's `restart: unless-stopped` policy brings it back with the changes applied.

## License

MIT

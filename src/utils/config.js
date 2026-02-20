import 'dotenv/config';

export const config = {
  // Discord
  discordToken: process.env.DISCORD_TOKEN,
  botPrefix: process.env.BOT_PREFIX || '!claude',

  // Anthropic
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-6-20250514',
  maxTokens: parseInt(process.env.MAX_TOKENS || '4096', 10),

  // GitHub
  githubToken: process.env.GITHUB_TOKEN,
  defaultRepo: process.env.DEFAULT_GITHUB_REPO || '', // e.g. "owner/repo"

  // Web Search (Brave Search API)
  braveApiKey: process.env.BRAVE_API_KEY || '',

  // Scratch space
  scratchDir: process.env.SCRATCH_DIR || '/tmp/claude-scratch',

  // Self-modification
  botSourceDir: process.env.BOT_SOURCE_DIR || '/app',

  // Conversation
  maxHistoryMessages: parseInt(process.env.MAX_HISTORY || '50', 10),
  maxToolIterations: parseInt(process.env.MAX_TOOL_ITERATIONS || '20', 10),

  // System prompt
  systemPrompt: process.env.SYSTEM_PROMPT || `You are Claude, an AI assistant running as a Discord bot. You have access to powerful tools for software engineering tasks.

Your capabilities:
- **GitHub**: Read issues, post comments, download files from issues/repos
- **Web Search**: Search the web and fetch URL contents
- **Repository Analysis**: Clone git repos to a scratch space, browse and read files
- **File Patching**: Edit and patch files in the scratch space
- **Self-Modification**: Modify your own source code and trigger a restart

Guidelines:
- Be concise but thorough. Discord messages have length limits.
- When analyzing code, read the relevant files before making conclusions.
- When patching files, show what you changed.
- Use code blocks with language hints for code output.
- If a task requires multiple steps, explain your plan briefly then execute.
- For GitHub operations, confirm destructive actions before proceeding.
- When self-modifying, explain what you're changing and why before doing it.`,
};

// Validate required config
const required = ['discordToken', 'anthropicApiKey'];
for (const key of required) {
  if (!config[key]) {
    console.error(`Missing required environment variable for: ${key}`);
    process.exit(1);
  }
}

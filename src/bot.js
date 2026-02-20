import { Client, GatewayIntentBits, Partials, EmbedBuilder } from 'discord.js';
import { config } from './utils/config.js';
import { conversationManager } from './utils/conversation.js';
import { ensureScratchDir, cleanScratch, scratchUsage, formatBytes } from './utils/scratch.js';
import { storeToken, removeToken, hasToken, isEphemeralKey } from './utils/token-store.js';
import { runClaudeLoop } from './claude.js';

const DISCORD_MAX_LENGTH = 2000;

/**
 * Create and configure the Discord client.
 */
export function createBot() {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Message, Partials.Channel],
  });

  // Track active requests per channel to prevent overlap
  const activeRequests = new Set();

  client.once('ready', () => {
    console.log(`[bot] Logged in as ${client.user.tag}`);
    console.log(`[bot] Prefix: "${config.botPrefix}" | Mention: @${client.user.tag}`);
    ensureScratchDir();
  });

  client.on('messageCreate', async (message) => {
    // Ignore bots and system messages
    if (message.author.bot) return;

    // --- DM handling for token management ---
    if (!message.guild) {
      return handleDM(message);
    }

    // --- Guild message handling ---
    const botMention = `<@${client.user.id}>`;
    let content = message.content.trim();
    let isCommand = false;

    if (content.startsWith(config.botPrefix)) {
      content = content.slice(config.botPrefix.length).trim();
      isCommand = true;
    } else if (content.startsWith(botMention)) {
      content = content.slice(botMention.length).trim();
      isCommand = true;
    } else if (message.mentions.has(client.user)) {
      content = content.replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '').trim();
      isCommand = true;
    }

    if (!isCommand) return;

    // Intercept token commands in public channels — warn and delete
    if (content.match(/^token\s+set\s/i)) {
      try { await message.delete(); } catch {}
      return message.channel.send(
        `${message.author}, **do not paste tokens in public channels!** I've deleted your message. ` +
        `Please DM me directly with your token command.`
      );
    }

    // Handle built-in commands
    if (content === 'help' || content === '') {
      return sendHelp(message);
    }
    if (content === 'clear' || content === 'reset') {
      conversationManager.clearHistory(message.channel.id);
      return message.reply('Conversation cleared.');
    }
    if (content === 'status') {
      return sendStatus(message);
    }
    if (content === 'clean') {
      cleanScratch();
      return message.reply('Scratch space cleaned.');
    }
    if (content.match(/^token\b/i)) {
      return handleTokenCommand(message, content);
    }

    // Prevent concurrent requests in the same channel
    const channelId = message.channel.id;
    if (activeRequests.has(channelId)) {
      return message.reply('I\'m still working on a previous request in this channel. Please wait.');
    }

    activeRequests.add(channelId);

    try {
      await handleClaudeRequest(message, content);
    } finally {
      activeRequests.delete(channelId);
    }
  });

  return client;
}

// =============================================================================
// Token management (DM-only for set, public-safe for status/remove)
// =============================================================================

async function handleDM(message) {
  const content = message.content.trim();

  // In DMs, strip prefix if present but don't require it
  let cmd = content;
  if (cmd.startsWith(config.botPrefix)) {
    cmd = cmd.slice(config.botPrefix.length).trim();
  }

  // Token set — DM only
  const setMatch = cmd.match(/^token\s+set\s+(\S+)/i);
  if (setMatch) {
    const token = setMatch[1];

    // Basic validation
    if (!token.startsWith('ghp_') && !token.startsWith('github_pat_') && !token.startsWith('gho_')) {
      return message.reply(
        'That doesn\'t look like a GitHub personal access token. ' +
        'Tokens typically start with `ghp_`, `github_pat_`, or `gho_`.'
      );
    }

    // Verify the token works by making a test API call
    const { Octokit } = await import('@octokit/rest');
    try {
      const testOk = new Octokit({ auth: token });
      const { data: user } = await testOk.users.getAuthenticated();

      storeToken(message.author.id, token);

      // Delete the message containing the token for safety
      try { await message.delete(); } catch {}

      await message.author.send(
        `GitHub token verified and stored (encrypted). ` +
        `GitHub actions will now be performed as **${user.login}**.\n\n` +
        `${isEphemeralKey() ? '**Warning:** No TOKEN_ENCRYPTION_SECRET is configured. Your token is encrypted but the key is ephemeral — it will be lost on bot restart. Ask the bot admin to set TOKEN_ENCRYPTION_SECRET in the environment.\n\n' : ''}` +
        `Use \`token remove\` to delete your stored token at any time.`
      );
    } catch (err) {
      // Still delete the message with the token
      try { await message.delete(); } catch {}
      await message.author.send(
        `Failed to verify that GitHub token: ${err.message}\n` +
        `Make sure the token is valid and has the necessary scopes (e.g., \`repo\`, \`read:org\`).`
      );
    }
    return;
  }

  // Token remove
  if (cmd.match(/^token\s+remove/i)) {
    const removed = removeToken(message.author.id);
    return message.reply(
      removed
        ? 'Your GitHub token has been removed. Actions will now use the bot\'s default token.'
        : 'You don\'t have a stored token.'
    );
  }

  // Token status
  if (cmd.match(/^token(\s+status)?$/i)) {
    const has = hasToken(message.author.id);
    return message.reply(
      has
        ? 'You have a personal GitHub token stored. GitHub actions will use your identity.\nUse `token remove` to delete it.'
        : 'No personal token stored. GitHub actions will use the bot\'s default token.\nUse `token set ghp_YOUR_TOKEN` to register yours.'
    );
  }

  // Help for DMs
  if (cmd === 'help' || cmd === '') {
    const embed = new EmbedBuilder()
      .setTitle('DM Commands — Token Management')
      .setColor(0x7c3aed)
      .setDescription(
        'DMs are used for secure token management. Your GitHub Personal Access Token (PAT) is stored encrypted and used for GitHub operations performed on your behalf.'
      )
      .addFields(
        {
          name: 'Commands',
          value: [
            '`token set ghp_YOUR_TOKEN` — Store your GitHub PAT (encrypted)',
            '`token remove` — Remove your stored token',
            '`token status` — Check if you have a token stored',
          ].join('\n'),
        },
        {
          name: 'How It Works',
          value: [
            '1. Create a PAT at github.com → Settings → Developer settings → Personal access tokens',
            '2. Grant scopes: `repo` (for private repos) or `public_repo` (for public only)',
            '3. DM me: `token set ghp_YOUR_TOKEN`',
            '4. When you ask me to comment on issues, push code, etc., it will be done as **you**',
          ].join('\n'),
        },
        {
          name: 'Security',
          value: [
            '- Tokens are encrypted at rest using AES-256-GCM',
            '- DM messages containing tokens are automatically deleted',
            '- You can remove your token at any time',
            '- **Never paste tokens in public channels** — the bot will delete them if you do',
          ].join('\n'),
        }
      );

    return message.reply({ embeds: [embed] });
  }

  // For any other DM, treat it as a Claude request
  const channelId = message.channel.id;
  await handleClaudeRequest(message, cmd);
}

/**
 * Handle token commands in public channels (limited — no set allowed).
 */
async function handleTokenCommand(message, content) {
  if (content.match(/^token\s+status$/i) || content === 'token') {
    const has = hasToken(message.author.id);
    return message.reply(
      has
        ? 'You have a personal GitHub token stored. GitHub actions use your identity.'
        : 'No personal token stored. DM me with `token set ghp_YOUR_TOKEN` to register one.'
    );
  }

  if (content.match(/^token\s+remove$/i)) {
    const removed = removeToken(message.author.id);
    return message.reply(
      removed ? 'Your GitHub token has been removed.' : 'You don\'t have a stored token.'
    );
  }

  // Anything else token-related in public: redirect to DMs
  return message.reply('For security, token registration must be done via DM. Send me a direct message with `token set ghp_YOUR_TOKEN`.');
}

// =============================================================================
// Claude request handling
// =============================================================================

async function handleClaudeRequest(message, content) {
  const channelId = message.channel.id;

  // Show typing indicator
  let typingInterval;
  try {
    await message.channel.sendTyping();
    typingInterval = setInterval(() => {
      message.channel.sendTyping().catch(() => {});
    }, 8000);
  } catch {
    // Typing indicator is non-critical
  }

  // Add user message to conversation history
  conversationManager.addUserMessage(
    channelId,
    content,
    message.author.displayName || message.author.username
  );

  // Build messages array for Claude
  const messages = [...conversationManager.getHistory(channelId)];

  // Build execution context with user identity
  const context = {
    discordUserId: message.author.id,
    discordUsername: message.author.displayName || message.author.username,
  };

  // Status message for tool usage
  let statusMsg = null;
  const toolNames = [];

  const onToolUse = async (toolName) => {
    toolNames.push(toolName);
    const statusText = `Using: \`${toolName}\` (${toolNames.length} tool${toolNames.length > 1 ? 's' : ''} used)`;

    try {
      if (!statusMsg) {
        statusMsg = await message.reply(statusText);
      } else {
        await statusMsg.edit(statusText);
      }
    } catch {
      // Status updates are non-critical
    }
  };

  // Intermediate text callback
  const intermediateTexts = [];
  const onText = (text) => {
    if (text.trim()) intermediateTexts.push(text);
  };

  try {
    const { response, messages: updatedMessages, toolsUsed } = await runClaudeLoop(
      messages,
      context,
      onToolUse,
      onText
    );

    // Update conversation history with the final exchange
    conversationManager.addAssistantMessage(channelId, response);

    // Delete status message if we have one
    if (statusMsg) {
      try { await statusMsg.delete(); } catch {}
    }

    // Send intermediate texts if any
    for (const text of intermediateTexts) {
      await sendLongMessage(message, text);
    }

    // Send the final response
    if (response.trim()) {
      await sendLongMessage(message, response);
    }

    // If tools were used, add a subtle footer
    if (toolsUsed.length > 0) {
      const uniqueTools = [...new Set(toolsUsed)];
      const footer = `*Tools used: ${uniqueTools.join(', ')}*`;
      if (footer.length < DISCORD_MAX_LENGTH) {
        await message.channel.send(footer);
      }
    }
  } catch (err) {
    console.error('[bot] Claude loop error:', err);

    if (statusMsg) {
      try { await statusMsg.delete(); } catch {}
    }

    const errorMsg = err.message?.includes('rate_limit')
      ? 'Rate limited by Claude API. Please wait a moment and try again.'
      : `Error: ${err.message?.slice(0, 500) || 'Unknown error'}`;

    await message.reply(errorMsg);
  } finally {
    if (typingInterval) clearInterval(typingInterval);
  }
}

// =============================================================================
// Message splitting
// =============================================================================

async function sendLongMessage(message, text) {
  const chunks = splitMessage(text);
  for (const chunk of chunks) {
    await message.channel.send(chunk);
  }
}

function splitMessage(text, maxLength = DISCORD_MAX_LENGTH) {
  if (text.length <= maxLength) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    let splitAt = maxLength;
    const slice = remaining.slice(0, maxLength);

    const lastCodeBlock = slice.lastIndexOf('\n```');
    if (lastCodeBlock > maxLength * 0.3) {
      splitAt = lastCodeBlock + 1;
    } else {
      const lastNewline = slice.lastIndexOf('\n');
      if (lastNewline > maxLength * 0.3) {
        splitAt = lastNewline + 1;
      }
    }

    let chunk = remaining.slice(0, splitAt);

    const openFences = (chunk.match(/```/g) || []).length;
    if (openFences % 2 !== 0) {
      chunk += '\n```';
      const lastFence = chunk.lastIndexOf('```', chunk.length - 4);
      const afterFence = chunk.slice(lastFence + 3).split('\n')[0];
      remaining = '```' + afterFence + '\n' + remaining.slice(splitAt);
    } else {
      remaining = remaining.slice(splitAt);
    }

    chunks.push(chunk);
  }

  return chunks;
}

// =============================================================================
// Help & Status
// =============================================================================

async function sendHelp(message) {
  const embed = new EmbedBuilder()
    .setTitle('Claude Discord Bot')
    .setDescription('A Claude Code-style AI assistant with tool capabilities.')
    .setColor(0x7c3aed)
    .addFields(
      {
        name: 'How to Use',
        value: `Mention me or use \`${config.botPrefix}\` followed by your request.\nI understand natural language — just describe what you need.`,
      },
      {
        name: 'Capabilities',
        value: [
          '**GitHub** — Read issues, post comments, download files',
          '**Web Search** — Search the web, fetch page content',
          '**Repo Analysis** — Clone repos, browse & read code',
          '**File Patching** — Edit files in scratch space',
          '**Self-Modification** — Modify my own code & restart',
        ].join('\n'),
      },
      {
        name: 'Commands',
        value: [
          `\`${config.botPrefix} clear\` — Clear conversation history`,
          `\`${config.botPrefix} status\` — Show bot status`,
          `\`${config.botPrefix} clean\` — Clean scratch space`,
          `\`${config.botPrefix} token status\` — Check your GitHub token`,
          `\`${config.botPrefix} help\` — Show this help`,
        ].join('\n'),
      },
      {
        name: 'GitHub Authentication',
        value: 'DM me with `token set ghp_YOUR_TOKEN` to register your personal GitHub token. ' +
          'Actions like commenting on issues will then be performed as **you**.\n' +
          '*Never paste tokens in public channels.*',
      },
      {
        name: 'Examples',
        value: [
          `\`${config.botPrefix} list open issues on owner/repo\``,
          `\`${config.botPrefix} search for how to implement OAuth in Node.js\``,
          `\`${config.botPrefix} clone owner/repo and explain the project structure\``,
          `\`${config.botPrefix} read issue #42 and summarize the problem\``,
        ].join('\n'),
      }
    );

  await message.reply({ embeds: [embed] });
}

async function sendStatus(message) {
  const usage = scratchUsage();
  const history = conversationManager.getHistory(message.channel.id);
  const userHasToken = hasToken(message.author.id);

  const embed = new EmbedBuilder()
    .setTitle('Bot Status')
    .setColor(0x10b981)
    .addFields(
      { name: 'Model', value: config.model, inline: true },
      { name: 'Scratch Space', value: formatBytes(usage), inline: true },
      { name: 'Channel History', value: `${history.length} messages`, inline: true },
      { name: 'Uptime', value: formatUptime(process.uptime()), inline: true },
      { name: 'GitHub (Bot)', value: config.githubToken ? 'Configured' : 'Not configured', inline: true },
      { name: 'GitHub (You)', value: userHasToken ? 'Personal token set' : 'Using bot default', inline: true },
      { name: 'Web Search', value: config.braveApiKey ? 'Configured' : 'Not configured', inline: true },
    );

  await message.reply({ embeds: [embed] });
}

function formatUptime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

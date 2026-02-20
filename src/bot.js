import { Client, GatewayIntentBits, Partials, EmbedBuilder } from 'discord.js';
import { config } from './utils/config.js';
import { conversationManager } from './utils/conversation.js';
import { ensureScratchDir, cleanScratch, scratchUsage, formatBytes } from './utils/scratch.js';
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

    // Check if the message is for us (prefix or mention)
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
      // Mentioned anywhere in the message
      content = content.replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '').trim();
      isCommand = true;
    }

    if (!isCommand) return;

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

/**
 * Handle a user request by running the Claude tool-use loop.
 */
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

/**
 * Send a long message, splitting at code block boundaries and newlines.
 */
async function sendLongMessage(message, text) {
  const chunks = splitMessage(text);
  for (const chunk of chunks) {
    await message.channel.send(chunk);
  }
}

/**
 * Split a message into chunks that fit Discord's limit.
 * Respects code block boundaries.
 */
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

    // Try to split at a code block boundary
    const lastCodeBlock = slice.lastIndexOf('\n```');
    if (lastCodeBlock > maxLength * 0.3) {
      splitAt = lastCodeBlock + 1; // After the newline, before ```
    } else {
      // Try to split at a newline
      const lastNewline = slice.lastIndexOf('\n');
      if (lastNewline > maxLength * 0.3) {
        splitAt = lastNewline + 1;
      }
    }

    let chunk = remaining.slice(0, splitAt);

    // If we're splitting inside a code block, close/reopen it
    const openFences = (chunk.match(/```/g) || []).length;
    if (openFences % 2 !== 0) {
      chunk += '\n```';
      // Find what language the code block was
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

/**
 * Send help embed.
 */
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
          `\`${config.botPrefix} help\` — Show this help`,
        ].join('\n'),
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

/**
 * Send status embed.
 */
async function sendStatus(message) {
  const usage = scratchUsage();
  const history = conversationManager.getHistory(message.channel.id);

  const embed = new EmbedBuilder()
    .setTitle('Bot Status')
    .setColor(0x10b981)
    .addFields(
      { name: 'Model', value: config.model, inline: true },
      { name: 'Scratch Space', value: formatBytes(usage), inline: true },
      { name: 'Channel History', value: `${history.length} messages`, inline: true },
      { name: 'Uptime', value: formatUptime(process.uptime()), inline: true },
      { name: 'GitHub', value: config.githubToken ? 'Configured' : 'Not configured', inline: true },
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

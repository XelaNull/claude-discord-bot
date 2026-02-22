const { Client, GatewayIntentBits, EmbedBuilder, Partials } = require('discord.js');
const config = require('./utils/config');
const { addMessage, clearHistory, getConversationMessages } = require('./utils/conversation');
const { storeToken, getToken, removeToken, hasToken } = require('./utils/token-store');
const { callClaude, extractText, classifyMessage, classifyChannelMessage, generateAcknowledgment, generateThreadTitle, tryHaikuAnswer } = require('./claude');
const { buildSystemPrompt } = require('./utils/system-prompt');
const { getProfile, setProfile } = require('./utils/user-profiles');
const { getMemorySummary } = require('./utils/project-memory');
const { listUserWorkspaces, cleanUserWorkspace, cleanExpiredWorkspaces } = require('./utils/workspace');
const { getUsageStats, formatUsageEmbed, calculateCost } = require('./utils/usage');
const { createProgress } = require('./utils/progress');
const { requestConfirmation } = require('./utils/confirmation');
const { isOwner, isAllowed, grantAccess, revokeAccess, listAllowed, denyMessage } = require('./utils/access-control');
const { registerCommands, handleInteraction } = require('./slash-commands');
const { ResponseStream } = require('./utils/response-stream');
const {
  buildThreadButtons, buildPRReviewButtons, attachButtonsWithTimeout,
  handleComponentInteraction, handleFollowUpModal, handleReqChangesModal, handleContextMenu
} = require('./interaction-handler');
const {
  isChatThread, addChatThread, removeChatThread, getChatThreadsByUser,
  touchThread, trackThreadTokens, getThreadTokens, startInactivityTimers, closeThread,
  _formatTokenCount, incrementMessageCount, markRenamed, shouldAutoRename
} = require('./utils/chat-threads');
const {
  generateSessionId, logUserMessage, logIntentClassification,
  logResponse, logError, logThreadLifecycle
} = require('./utils/conversation-log');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Message, Partials.Channel]
});

const COLORS = {
  SUCCESS: 0x2ecc71,
  ERROR: 0xe74c3c,
  INFO: 0x5865f2,
  WARNING: 0xfee75c
};

// Phase 1 fix: 1990 effective max to leave headroom for code block markers
const MAX_MSG_LENGTH = 1990;

// Max chat threads a single user can have open simultaneously
const MAX_CHAT_THREADS_PER_USER = 10;

// Active requests per channel — used for stop/cancel keyword detection
const activeRequests = new Map(); // channelId → context

// ============================================================
//  MESSAGE SPLITTING
// ============================================================

function splitMessage(text) {
  if (text.length <= MAX_MSG_LENGTH) return [text];

  const chunks = [];
  let remaining = text;
  let inCodeBlock = false;
  let codeBlockLang = '';

  while (remaining.length > 0) {
    if (remaining.length <= MAX_MSG_LENGTH) {
      chunks.push(remaining);
      break;
    }

    const effectiveMax = inCodeBlock
      ? MAX_MSG_LENGTH - 10 - codeBlockLang.length
      : MAX_MSG_LENGTH;

    let splitAt = effectiveMax;
    const newlineIdx = remaining.lastIndexOf('\n', effectiveMax);
    if (newlineIdx > effectiveMax * 0.5) {
      splitAt = newlineIdx;
    }

    let chunk = remaining.substring(0, splitAt);
    remaining = remaining.substring(splitAt);

    // Track code block state
    const backtickMatches = chunk.match(/```/g);
    if (backtickMatches) {
      for (const _ of backtickMatches) {
        if (!inCodeBlock) {
          const lastOpen = chunk.lastIndexOf('```');
          const langMatch = chunk.substring(lastOpen + 3).match(/^(\w*)/);
          codeBlockLang = langMatch ? langMatch[1] : '';
          inCodeBlock = true;
        } else {
          inCodeBlock = false;
          codeBlockLang = '';
        }
      }
    }

    if (inCodeBlock) {
      chunk += '\n```';
      remaining = '```' + codeBlockLang + '\n' + remaining;
    }

    chunks.push(chunk);
  }

  return chunks;
}

/**
 * Wrap bare URLs in <angle brackets> to prevent Discord link preview embeds.
 * Skips URLs already inside <brackets> or markdown [text](url) links.
 */
function suppressLinkEmbeds(text) {
  return text.replace(/(?<![(<])(https?:\/\/[^\s>)\]]+)/g, '<$1>');
}

// ============================================================
//  TRIGGER DETECTION — bot name or @mention
// ============================================================

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Check if a message is directed at the bot.
 * Returns { query, atStart } where query is the text with bot name stripped,
 * and atStart indicates the bot name/mention was at the beginning of the message.
 * Returns null if not triggered.
 */
function extractBotTrigger(content) {
  // 1. Check @mention (with or without nickname format)
  const mentionRegex = new RegExp(`<@!?${client.user.id}>\\s*`, 'g');
  if (mentionRegex.test(content)) {
    const startsWithMention = new RegExp(`^\\s*<@!?${client.user.id}>`).test(content);
    return { query: content.replace(mentionRegex, '').trim(), atStart: startsWithMention };
  }

  // 2. Check bot username as a word boundary match (case-insensitive)
  const botName = client.user.username;
  const nameRegex = new RegExp(`\\b${escapeRegex(botName)}\\b`, 'gi');
  if (nameRegex.test(content)) {
    const startsWithName = new RegExp(`^\\s*(?:hey\\s+|hi\\s+|yo\\s+)?${escapeRegex(botName)}\\b`, 'i').test(content);
    return { query: content.replace(nameRegex, '').trim(), atStart: startsWithName };
  }

  return null;
}

// ============================================================
//  KEYWORD PRE-CHECK — fast routing without classifier
// ============================================================

/**
 * Match obvious keyword intents before hitting the Haiku classifier.
 * Returns { intent, query } or null if no keyword match.
 */
function matchKeywordIntent(queryLower, queryOriginal) {
  // Help
  if (queryLower === 'help' || queryLower === 'what can you do' || queryLower === 'what can you do?') {
    return { intent: 'help', query: '' };
  }

  // Chat — start a thread
  if (queryLower === 'chat' || queryLower.startsWith('chat ') ||
      queryLower === "let's chat" || queryLower.startsWith("let's chat ") ||
      queryLower === 'lets chat' || queryLower.startsWith('lets chat ')) {
    const chatQuery = queryLower === 'chat' || queryLower === "let's chat" || queryLower === 'lets chat'
      ? null
      : queryOriginal.replace(/^(?:chat|let'?s chat)\s+(?:about\s+)?/i, '').trim() || null;
    return { intent: 'chat', query: chatQuery };
  }

  // Status
  if (queryLower === 'status' || queryLower === 'am i registered' || queryLower === 'am i registered?') {
    return { intent: 'status', query: '' };
  }

  // Usage
  if (queryLower === 'usage' || queryLower === 'my usage' || queryLower === 'show my usage' ||
      queryLower === 'show usage') {
    return { intent: 'usage', query: '' };
  }

  // Profile
  if (queryLower === 'profile' || queryLower === 'my profile' || queryLower === 'show my profile' ||
      queryLower === 'show profile') {
    return { intent: 'profile', query: '' };
  }
  if (queryLower.startsWith('set my ') || queryLower.startsWith('set default ') ||
      queryLower.startsWith('set repo ') || queryLower.startsWith('set name ') ||
      queryLower.startsWith('set email ') || queryLower.startsWith('set branch ')) {
    return { intent: 'profile', query: queryOriginal };
  }

  // Admin — grant/revoke/list users
  if (queryLower.startsWith('grant ')) {
    return { intent: 'admin_grant', query: queryOriginal };
  }
  if (queryLower.startsWith('revoke ')) {
    return { intent: 'admin_revoke', query: queryOriginal };
  }
  if (queryLower === 'users' || queryLower === 'list users' || queryLower === 'show users' ||
      queryLower === 'allowed users' || queryLower === 'access list') {
    return { intent: 'admin_users', query: '' };
  }

  return null;
}

// ============================================================
//  HAIKU-FIRST SKIP HEURISTIC — detect queries that need tools
// ============================================================

const SKIP_ACTION_VERBS = /\b(fix|review|clone|analyze|search|create|deploy|push|commit|merge|patch|edit|refactor|debug|delete|remove|update|install|build|run|execute|test|write|implement|add)\b/i;
const SKIP_GITHUB_URL = /github\.com\//i;
const SKIP_ISSUE_PR_REF = /(?:#\d+|\bissue\s+\d+|\bpr\s+\d+|\bpull\s+request\s+\d+)/i;
const SKIP_REPO_REF = /\b[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+\b/;
const SKIP_FILE_PATH = /\b\S+\.(js|ts|py|go|rs|java|cpp|c|h|rb|php|css|html|json|yml|yaml|toml|sh|sql|md|jsx|tsx|vue|svelte)\b/i;
const SKIP_TEMPORAL = /\b(latest|current|recent|newest|today|yesterday|now|open|active|pending)\b/i;

function shouldSkipHaiku(query) {
  if (SKIP_GITHUB_URL.test(query)) return true;
  if (SKIP_ISSUE_PR_REF.test(query)) return true;
  if (SKIP_ACTION_VERBS.test(query)) return true;
  if (SKIP_REPO_REF.test(query)) return true;
  if (SKIP_FILE_PATH.test(query)) return true;
  if (SKIP_TEMPORAL.test(query)) return true;
  return false;
}

// ============================================================
//  TOKEN FOOTER
// ============================================================

function buildTokenFooter(totalUsage, threadTokens) {
  const responseTokens = totalUsage.inputTokens + totalUsage.outputTokens;
  let footer = `\n\n📊 This response: ${_formatTokenCount(responseTokens)} tokens`;

  if (threadTokens) {
    const threadTotal = threadTokens.totalInputTokens + threadTokens.totalOutputTokens;
    footer += ` | Thread total: ${_formatTokenCount(threadTotal)} tokens ($${threadTokens.totalCost.toFixed(2)})`;
  }

  return footer;
}

// ============================================================
//  CHAT MODE — in-thread natural language routing via Haiku
// ============================================================

async function handleChatMode(msg) {
  const content = msg.content.trim();
  if (!content) return;

  const chatSessionId = generateSessionId();

  // Log user message in chat thread
  logUserMessage(msg.channel.id, {
    sessionId: chatSessionId, userId: msg.author.id, displayName: msg.author.username,
    channelId: msg.channel.id, guildId: msg.guild?.id,
    content: content.substring(0, 500), source: 'chat_thread', inThread: true
  });

  // Show thinking indicator
  await msg.channel.sendTyping();

  const { command, args, usage } = await classifyMessage(content);

  // Track the Haiku classifier cost
  if (usage) {
    const { trackApiCall, trackTokens } = require('./utils/usage');
    trackApiCall(msg.author.id);
    trackTokens(msg.author.id, usage.input_tokens || 0, usage.output_tokens || 0, config.classifierModel);
  }

  const chatClassifierCost = usage
    ? calculateCost(config.classifierModel, usage.input_tokens || 0, usage.output_tokens || 0)
    : 0;

  logIntentClassification(msg.channel.id, {
    sessionId: chatSessionId, userId: msg.author.id,
    method: 'chat_mode_classifier', intent: command, query: (args || content).substring(0, 500),
    classifierTokens: usage ? { input: usage.input_tokens, output: usage.output_tokens } : null,
    classifierCost: chatClassifierCost
  });

  console.log(`[chat-mode] "${content.substring(0, 80)}" → ${command}(${args})`);

  switch (command) {
    case 'help':
      return msg.reply({
        embeds: [new EmbedBuilder()
          .setColor(COLORS.INFO)
          .setTitle('Chat Thread Active')
          .setDescription(
            `You're in a **chat thread** — just type naturally!\n\n` +
            `Try things like:\n` +
            `- "show my profile"\n` +
            `- "set my default repo to owner/repo"\n` +
            `- "how many tokens have I used?"\n` +
            `- "fix issue https://github.com/..."\n` +
            `- "what is a JavaScript promise?"\n` +
            `- "close" or "exit" to end the thread\n\n` +
            `I use a lightweight AI to understand what you mean and route to the right command.`
          )
        ]
      });

    case 'status': {
      const hasPat = hasToken(msg.author.id);
      const profile = getProfile(msg.author.id);
      return msg.reply({
        embeds: [new EmbedBuilder()
          .setColor(COLORS.INFO)
          .setTitle('Your Status')
          .setDescription(
            `**User:** ${msg.author.username}\n` +
            `**GitHub PAT:** ${hasPat ? 'Registered' : 'Not registered'}\n` +
            `**Default repo:** ${profile.defaultRepo || 'Not set'}\n` +
            `**Chat thread:** Active\n` +
            `**Conversation:** ${getConversationMessages(msg.channel.id).length} messages`
          )
        ]
      });
    }

    case 'profile_show':
      return handleProfileCommand(msg, '');

    case 'profile_set': {
      if (!args) return msg.reply("I couldn't figure out what to set. Try something like: \"set my default repo to owner/repo\"");
      return handleProfileCommand(msg, 'set ' + args);
    }

    case 'workspaces':
      return handleWorkspacesCommand(msg);

    case 'workspace_clean': {
      if (!args) return msg.reply("Which workspace? Try: \"clean workspace owner/repo\"");
      return handleWorkspaceCleanCommand(msg, args);
    }

    case 'usage': {
      const stats = getUsageStats(msg.author.id);
      const embed = formatUsageEmbed(stats);
      return msg.reply({ embeds: [embed] });
    }

    case 'exit_chat':
      await closeThread(msg.channel.id, client, 'user');
      return;

    case 'general':
    default:
      // Send to Claude as a regular request
      return handleClaudeRequest(msg, args || content, { sessionId: chatSessionId, source: 'chat_thread' });
  }
}

// ============================================================
//  DM HANDLER (PAT management)
// ============================================================

async function handleDM(msg) {
  const content = msg.content.trim();

  if (content.toLowerCase() === 'remove pat' || content.toLowerCase() === 'delete pat') {
    removeToken(msg.author.id);
    return msg.reply('Your GitHub PAT has been removed.');
  }

  if (content.toLowerCase() === 'status') {
    const hasPat = hasToken(msg.author.id);
    return msg.reply(hasPat
      ? 'You have a GitHub PAT registered. Send `remove pat` to remove it.'
      : 'No GitHub PAT registered. Send me a GitHub Personal Access Token to get started.'
    );
  }

  if (content.match(/^gh[ps]_[A-Za-z0-9_]+$/) || content.startsWith('github_pat_')) {
    try {
      storeToken(msg.author.id, content);
      try { await msg.delete(); } catch (_) {}
      return msg.channel.send({
        embeds: [new EmbedBuilder()
          .setColor(COLORS.SUCCESS)
          .setTitle('GitHub PAT Stored')
          .setDescription(
            'Your token has been encrypted and stored. I deleted your message for security.\n\n' +
            'You can now use GitHub tools in any channel. Send `remove pat` to delete your token.'
          )
        ]
      });
    } catch (err) {
      return msg.reply(`Failed to store token: ${err.message}`);
    }
  }

  return msg.reply(
    'Send me your GitHub Personal Access Token (starts with `ghp_` or `github_pat_`) to register it.\n' +
    'Send `status` to check your current registration.\n' +
    'Send `remove pat` to delete your stored token.'
  );
}

// ============================================================
//  CLAUDE REQUEST HANDLER
// ============================================================

async function handleClaudeRequest(msg, query, options = {}) {
  // Support both Message objects and Interaction objects (slash commands)
  const isInteraction = !!msg.user; // interactions have .user, messages have .author
  const channelId = msg.channel?.id || msg.channelId;
  const userId = isInteraction ? msg.user.id : msg.author.id;
  const displayName = msg.member?.displayName
    || (isInteraction ? msg.user.username : msg.author.username);

  // Keep typing indicator alive during long tool-use loops (refreshes every 8s)
  let typingInterval = null;
  const replyChannel = options.replyChannel || msg.channel;

  // Use the reply channel's ID for conversation scoping
  const effectiveChannelId = replyChannel?.id || channelId;

  // Session tracking — thread through entire request lifecycle
  const sessionId = options.sessionId || generateSessionId();
  const requestStartTime = Date.now();

  const context = {
    userId,
    channelId: effectiveChannelId,
    guildId: msg.guild?.id || msg.guildId,
    token: getToken(userId),
    displayName,
    _requestRestart: false,
    _logSession: sessionId
  };

  // Log the user message
  logUserMessage(effectiveChannelId, {
    sessionId,
    userId,
    displayName,
    channelId: effectiveChannelId,
    guildId: context.guildId,
    content: query.substring(0, 500),
    source: options.source || (isInteraction ? 'slash_command' : 'channel'),
    inThread: isChatThread(effectiveChannelId)
  });

  // Build dynamic system prompt
  const profile = getProfile(userId);
  const memorySummary = profile.defaultRepo
    ? getMemorySummary(userId, profile.defaultRepo)
    : null;

  const systemPrompt = buildSystemPrompt({
    ...context,
    profile,
    memorySummary
  });

  // Only use conversation history inside chat threads — in-channel responses are one-shot
  const inThread = isChatThread(effectiveChannelId);
  let messages;

  if (inThread) {
    addMessage(effectiveChannelId, 'user', query);
    messages = getConversationMessages(effectiveChannelId);
  } else {
    messages = [{ role: 'user', content: query }];
  }

  try {
    // ── ResponseStream: edit-in-place progressive response ──────────
    const stream = new ResponseStream(replyChannel, {
      interaction: isInteraction ? msg : null
    });
    await stream.init('Thinking...');

    // Register stop callback — sets abort flag on context
    stream.onStop(() => {
      context._aborted = true;
      console.log(`[bot] Stop button clicked for channel ${effectiveChannelId}`);
    });

    // Track this request so "stop" keyword can abort it
    activeRequests.set(effectiveChannelId, context);

    if (!isInteraction && !options.skipTyping) {
      typingInterval = setInterval(() => {
        replyChannel.sendTyping().catch(() => {});
      }, 8000);
    }

    const onText = async (text) => {
      await stream.append(suppressLinkEmbeds(text));
    };
    const onToolStart = async (toolNames) => {
      await stream.setToolStatus(toolNames);
    };

    const { response, iterations, totalUsage, toolsUsed, prContext } = await callClaude(
      messages, systemPrompt, context, { onText, onToolStart }
    );

    // Clean up active request tracking
    activeRequests.delete(effectiveChannelId);

    // Handle abort — finalize with cancellation message
    if (context._aborted) {
      await stream.finalize('\n\n\u23F9 *Request cancelled.*');

      // Still attach post-response buttons on the final message
      const lastMsg = stream.getMessage();
      if (lastMsg && inThread) {
        await attachButtonsWithTimeout(lastMsg, buildThreadButtons());
      }
      return null;
    }

    let text = extractText(response);
    if (text) text = suppressLinkEmbeds(text);

    // Log the complete response summary
    logResponse(effectiveChannelId, {
      sessionId,
      userId,
      totalIterations: iterations,
      totalInputTokens: totalUsage.inputTokens,
      totalOutputTokens: totalUsage.outputTokens,
      totalCost: calculateCost(config.claudeModel, totalUsage.inputTokens, totalUsage.outputTokens),
      totalDurationMs: Date.now() - requestStartTime,
      responseLength: text ? text.length : 0,
      responsePreview: text ? text.substring(0, 200) : ''
    });

    // Only persist conversation history inside chat threads
    if (inThread && text) {
      addMessage(effectiveChannelId, 'assistant', text);
    }

    // Track per-thread tokens if we're in a chat thread
    if (inThread) {
      const cost = calculateCost(config.claudeModel, totalUsage.inputTokens, totalUsage.outputTokens);
      trackThreadTokens(effectiveChannelId, totalUsage.inputTokens, totalUsage.outputTokens, cost);
    }

    // Build token footer
    const threadTokens = isChatThread(effectiveChannelId) ? getThreadTokens(effectiveChannelId) : null;
    const footer = buildTokenFooter(totalUsage, threadTokens);

    if (text) {
      await stream.append(suppressLinkEmbeds(text));
    }
    await stream.finalize(footer);

    // Attach post-response buttons to the final message
    const lastMsg = stream.getMessage();
    if (lastMsg) {
      if (prContext) {
        await attachButtonsWithTimeout(lastMsg, buildPRReviewButtons(prContext));
      } else if (inThread) {
        await attachButtonsWithTimeout(lastMsg, buildThreadButtons());
      }
    }

    // Proper restart drain
    if (context._requestRestart) {
      console.log('Restart requested — draining and exiting...');
      setTimeout(() => process.exit(0), 3000);
    }

    // For interactions, return null (stream already sent everything)
    if (isInteraction) return null;
    return text;
  } catch (err) {
    console.error('Claude request error:', err);

    logError(effectiveChannelId, {
      sessionId,
      userId,
      phase: 'claude_request',
      error: err.message || String(err),
      stack: err.stack
    });

    if (isInteraction) throw err;

    // Truncate error message to prevent Discord embed overflow (4096 char limit)
    const errMsg = (err.message || String(err)).substring(0, 1500);
    const errorTarget = replyChannel || msg.channel;
    try {
      await errorTarget.send({
        embeds: [new EmbedBuilder()
          .setColor(COLORS.ERROR)
          .setTitle('Error')
          .setDescription(`Something went wrong: ${errMsg}`)
        ]
      });
    } catch (replyErr) {
      // Error embed itself failed — last resort plain text
      console.error('Failed to send error embed:', replyErr.message);
      try {
        await errorTarget.send(`Error: ${errMsg.substring(0, 1900)}`);
      } catch (_) {
        console.error('Failed to send any error response to user');
      }
    }
    return null;
  } finally {
    activeRequests.delete(effectiveChannelId);
    if (typingInterval) clearInterval(typingInterval);
  }
}

// ============================================================
//  PROFILE COMMANDS
// ============================================================

async function handleProfileCommand(msg, args) {
  const userId = msg.author.id;

  if (!args || args === '') {
    // Show current profile
    const profile = getProfile(userId);
    const hasPat = hasToken(userId);
    return msg.reply({
      embeds: [new EmbedBuilder()
        .setColor(COLORS.INFO)
        .setTitle('Your Profile')
        .setDescription(
          `**GitHub PAT:** ${hasPat ? 'Registered' : 'Not registered'}\n` +
          `**Default repo:** ${profile.defaultRepo || 'Not set'}\n` +
          `**Git name:** ${profile.gitName || 'From GitHub profile'}\n` +
          `**Git email:** ${profile.gitEmail || 'From GitHub profile'}\n` +
          `**Branch prefix:** ${profile.branchPrefix}`
        )
      ]
    });
  }

  const parts = args.split(/\s+/);
  if (parts[0] !== 'set' || parts.length < 3) {
    return msg.reply(
      `**Profile commands:**\n` +
      `Say "show my profile" to view your settings.\n` +
      `Say "set my default repo to owner/repo" to change a setting.\n` +
      `Available keys: **repo**, **name**, **email**, **branch**`
    );
  }

  const key = parts[1];
  const value = parts.slice(2).join(' ').replace(/^["']|["']$/g, '');

  const keyMap = { repo: 'defaultRepo', name: 'gitName', email: 'gitEmail', branch: 'branchPrefix' };
  const profileKey = keyMap[key];
  if (!profileKey) {
    return msg.reply(`Unknown profile key: \`${key}\`. Valid keys: repo, name, email, branch`);
  }

  setProfile(userId, profileKey, value);
  return msg.reply({
    embeds: [new EmbedBuilder()
      .setColor(COLORS.SUCCESS)
      .setDescription(`Profile updated: **${key}** = \`${value}\``)
    ]
  });
}

// ============================================================
//  WORKSPACE COMMANDS
// ============================================================

async function handleWorkspacesCommand(msg) {
  const userId = msg.author.id;
  const workspaces = listUserWorkspaces(userId);

  if (workspaces.length === 0) {
    return msg.reply('You have no cloned workspaces.');
  }

  const lines = workspaces.map(w => {
    const sizeMB = (w.sizeBytes / (1024 * 1024)).toFixed(1);
    const accessed = new Date(w.lastAccessed).toLocaleDateString();
    return `**${w.owner}/${w.repo}** — ${sizeMB} MB — last accessed ${accessed}`;
  });

  return msg.reply({
    embeds: [new EmbedBuilder()
      .setColor(COLORS.INFO)
      .setTitle('Your Workspaces')
      .setDescription(lines.join('\n'))
    ]
  });
}

async function handleWorkspaceCleanCommand(msg, args) {
  const userId = msg.author.id;

  if (!args) {
    return msg.reply('Please specify a repo in `owner/repo` format.');
  }

  const [owner, repo] = args.split('/');
  if (!owner || !repo) {
    return msg.reply('Please specify a repo in `owner/repo` format.');
  }

  cleanUserWorkspace(userId, owner, repo);
  return msg.reply({
    embeds: [new EmbedBuilder()
      .setColor(COLORS.SUCCESS)
      .setDescription(`Workspace \`${owner}/${repo}\` cleaned.`)
    ]
  });
}

// ============================================================
//  HELP EMBED — natural language examples
// ============================================================

function buildHelpEmbed(userId) {
  const hasPat = hasToken(userId);
  const botName = client.user?.username || 'CodeBot';

  return new EmbedBuilder()
    .setColor(COLORS.INFO)
    .setTitle(`${botName} — Team Coding Assistant`)
    .setDescription(
      `**How to talk to me:**\n` +
      `Just mention me by name or @mention me!\n\n` +
      `**Examples:**\n` +
      `- "${botName} what is a JavaScript promise?"\n` +
      `- "${botName} fix issue #21 on owner/repo"\n` +
      `- "${botName} review this PR https://github.com/..."\n` +
      `- "@${botName} help me refactor the auth module"\n` +
      `- "Hey ${botName}, let's chat about my project"\n\n` +
      `**In a chat thread:** Just type naturally, no need to mention me.\n\n` +
      `**Thread lifecycle:**\n` +
      `- Say "close" or "exit" to end a conversation\n` +
      `- Threads auto-close after 15 minutes of inactivity\n\n` +
      `**Other things you can ask me:**\n` +
      `- "show my profile" / "set my default repo to owner/repo"\n` +
      `- "what's my usage?" / "am I registered?"\n` +
      `- "show my workspaces"\n\n` +
      `**GitHub PAT:** ${hasPat ? 'Registered' : 'Not registered — use `/codepat` or DM me your token to enable GitHub features.'}`
    );
}

// ============================================================
//  THREAD CREATION — shared logic for chat + action intents
// ============================================================

async function createChatThread(msg, query, intent, options = {}) {
  // Guard: DMs
  if (!msg.guild) {
    return msg.reply({
      embeds: [new EmbedBuilder()
        .setColor(COLORS.ERROR)
        .setDescription('Chat threads can only be created in server channels.')
      ]
    });
  }

  // Guard: already inside a thread
  if (msg.channel.isThread()) {
    if (isChatThread(msg.channel.id)) {
      return msg.reply({
        embeds: [new EmbedBuilder()
          .setColor(COLORS.WARNING)
          .setDescription("You're already in a chat thread! Just type naturally.")
        ]
      });
    }
    return msg.reply({
      embeds: [new EmbedBuilder()
        .setColor(COLORS.WARNING)
        .setDescription("Can't start a chat thread from inside another thread.")
      ]
    });
  }

  // Guard: per-user thread limit
  const userThreads = getChatThreadsByUser(msg.author.id);
  if (userThreads.length >= MAX_CHAT_THREADS_PER_USER) {
    return msg.reply({
      embeds: [new EmbedBuilder()
        .setColor(COLORS.WARNING)
        .setTitle('Thread Limit Reached')
        .setDescription(
          `You have ${userThreads.length} active chat threads (max ${MAX_CHAT_THREADS_PER_USER}).\n` +
          `Say "close" or "exit" in an existing thread to free up a slot.`
        )
      ]
    });
  }

  try {
    const displayName = msg.member?.displayName || msg.author.username;
    const thread = await msg.startThread({ name: `${displayName}'s Chat`, autoArchiveDuration: 1440 });
    addChatThread(thread.id, { channelId: msg.channel.id, createdBy: msg.author.id });

    logThreadLifecycle(thread.id, {
      sessionId: options.sessionId || generateSessionId(),
      userId: msg.author.id,
      action: 'created',
      threadId: thread.id,
      parentChannelId: msg.channel.id,
      intent
    });

    if (query) {
      // Generate title + ack in parallel, then process
      const [title, ack] = await Promise.all([
        generateThreadTitle(query),
        generateAcknowledgment(query)
      ]);

      try { await thread.setName(title); } catch (_) {}
      markRenamed(thread.id);
      await thread.send(ack || 'Working on it...');

      // Process query with Claude, replying in the thread
      handleClaudeRequest(msg, query, { replyChannel: thread, sessionId: options.sessionId }).catch(err => {
        console.error('Unhandled error in chat thread request:', err);
        thread.send('Something went wrong. Please try again.').catch(() => {});
      });
    } else {
      // No query — welcome embed
      const botName = client.user.username;
      await thread.send({
        embeds: [new EmbedBuilder()
          .setColor(COLORS.SUCCESS)
          .setTitle('Chat Thread Started')
          .setDescription(
            `Just type naturally — no need to mention me!\n\n` +
            `**Try things like:**\n` +
            `- "show my profile"\n` +
            `- "set my default repo to owner/repo"\n` +
            `- "how much have I spent?"\n` +
            `- "fix this issue https://github.com/..."\n` +
            `- Any coding question\n\n` +
            `Say **"close"** or **"exit"** to end this thread.\n` +
            `Thread auto-closes after 15 minutes of inactivity.`
          )
        ]
      });
    }
  } catch (err) {
    console.error('Failed to create chat thread:', err);
    return msg.reply({
      embeds: [new EmbedBuilder()
        .setColor(COLORS.ERROR)
        .setTitle('Thread Creation Failed')
        .setDescription(
          `Could not create a thread. Make sure I have the **Create Public Threads** permission.\n` +
          `Error: ${err.message}`
        )
      ]
    });
  }
}

// ============================================================
//  CHANNEL INTENT ROUTING — handle classified intents
// ============================================================

async function routeChannelIntent(msg, intent, query, options = {}) {
  switch (intent) {
    case 'ignore':
      return; // Do nothing

    case 'chat':
      return createChatThread(msg, query || null, 'chat', options);

    case 'question':
      // Simple question — try Haiku first for cheap/fast answers
      if (config.haikuFirstEnabled && !shouldSkipHaiku(query)) {
        const haikuResult = await tryHaikuAnswer(query, msg.author.id);

        const haikuMethod = 'haiku_first';
        const haikuIntent = haikuResult.answered ? 'haiku_answered' : 'haiku_escalated';
        logIntentClassification(msg.channel.id, {
          sessionId: options.sessionId, userId: msg.author.id,
          method: haikuMethod, intent: haikuIntent, query: query.substring(0, 500),
          classifierTokens: haikuResult.usage ? { input: haikuResult.usage.input_tokens, output: haikuResult.usage.output_tokens } : null,
          classifierCost: haikuResult.usage
            ? calculateCost(config.haikuFirstModel, haikuResult.usage.input_tokens || 0, haikuResult.usage.output_tokens || 0)
            : 0
        });

        if (haikuResult.answered) {
          const text = suppressLinkEmbeds(haikuResult.text);
          const footer = '\n\n-# Answered by Haiku (fast mode)';
          const chunks = splitMessage(text);
          const lastIdx = chunks.length - 1;
          if (chunks[lastIdx].length + footer.length <= MAX_MSG_LENGTH) {
            chunks[lastIdx] += footer;
          } else {
            chunks.push(footer);
          }
          for (const chunk of chunks) {
            await msg.channel.send(chunk);
          }

          logResponse(msg.channel.id, {
            sessionId: options.sessionId,
            userId: msg.author.id,
            totalIterations: 0,
            totalInputTokens: haikuResult.usage?.input_tokens || 0,
            totalOutputTokens: haikuResult.usage?.output_tokens || 0,
            totalCost: haikuResult.usage
              ? calculateCost(config.haikuFirstModel, haikuResult.usage.input_tokens || 0, haikuResult.usage.output_tokens || 0)
              : 0,
            totalDurationMs: 0,
            responseLength: text.length,
            responsePreview: text.substring(0, 200)
          });
          return;
        }
        // Haiku couldn't answer — fall through to Sonnet
      }
      return handleClaudeRequest(msg, query, { sessionId: options.sessionId });

    case 'action':
      // Complex request — create thread and process
      return createChatThread(msg, query, 'action', options);

    case 'help':
      return msg.reply({ embeds: [buildHelpEmbed(msg.author.id)] });

    case 'status': {
      const hasPat = hasToken(msg.author.id);
      const profile = getProfile(msg.author.id);
      return msg.reply({
        embeds: [new EmbedBuilder()
          .setColor(COLORS.INFO)
          .setTitle('Your Status')
          .setDescription(
            `**User:** ${msg.author.username}\n` +
            `**GitHub PAT:** ${hasPat ? 'Registered' : 'Not registered'}\n` +
            `**Default repo:** ${profile.defaultRepo || 'Not set'}\n` +
            `**Conversation:** ${getConversationMessages(msg.channel.id).length} messages`
          )
        ]
      });
    }

    case 'profile':
      if (query && query.startsWith('set ')) {
        return handleProfileCommand(msg, query);
      }
      return handleProfileCommand(msg, '');

    case 'usage': {
      const stats = getUsageStats(msg.author.id);
      const embed = formatUsageEmbed(stats);
      return msg.reply({ embeds: [embed] });
    }

    case 'admin_grant': {
      if (!isOwner(msg.author.id)) {
        return msg.reply({ embeds: [new EmbedBuilder().setColor(COLORS.ERROR).setDescription('Only the bot owner can grant access.')] });
      }
      const mentionMatch = query.match(/<@!?(\d+)>/) || query.match(/(\d{17,20})/);
      if (!mentionMatch) {
        return msg.reply({ embeds: [new EmbedBuilder().setColor(COLORS.WARNING).setDescription('Usage: `grant @user` or `grant <userId>`')] });
      }
      const targetId = mentionMatch[1];
      if (isOwner(targetId)) {
        return msg.reply({ embeds: [new EmbedBuilder().setColor(COLORS.INFO).setDescription('The owner always has access — no grant needed.')] });
      }
      // Try to resolve display name from the guild
      let targetName = targetId;
      try {
        const member = await msg.guild.members.fetch(targetId);
        targetName = member.displayName || member.user.username;
      } catch (_) {}
      grantAccess(targetId, msg.author.id, targetName);
      return msg.reply({
        embeds: [new EmbedBuilder()
          .setColor(COLORS.SUCCESS)
          .setTitle('Access Granted')
          .setDescription(`**${targetName}** (<@${targetId}>) now has access to the bot.`)
        ]
      });
    }

    case 'admin_revoke': {
      if (!isOwner(msg.author.id)) {
        return msg.reply({ embeds: [new EmbedBuilder().setColor(COLORS.ERROR).setDescription('Only the bot owner can revoke access.')] });
      }
      const mentionMatch = query.match(/<@!?(\d+)>/) || query.match(/(\d{17,20})/);
      if (!mentionMatch) {
        return msg.reply({ embeds: [new EmbedBuilder().setColor(COLORS.WARNING).setDescription('Usage: `revoke @user` or `revoke <userId>`')] });
      }
      const targetId = mentionMatch[1];
      if (isOwner(targetId)) {
        return msg.reply({ embeds: [new EmbedBuilder().setColor(COLORS.ERROR).setDescription('Cannot revoke the owner\'s access.')] });
      }
      revokeAccess(targetId, msg.author.id);
      return msg.reply({
        embeds: [new EmbedBuilder()
          .setColor(COLORS.SUCCESS)
          .setTitle('Access Revoked')
          .setDescription(`<@${targetId}> no longer has access to the bot.`)
        ]
      });
    }

    case 'admin_users': {
      if (!isOwner(msg.author.id)) {
        return msg.reply({ embeds: [new EmbedBuilder().setColor(COLORS.ERROR).setDescription('Only the bot owner can view the access list.')] });
      }
      const allowed = listAllowed();
      const ownerLine = `**Owner:** <@${config.ownerId}> (always allowed)`;
      const userLines = allowed.length > 0
        ? allowed.map(u => {
            const date = u.grantedAt ? new Date(u.grantedAt).toLocaleDateString() : 'unknown';
            return `- **${u.displayName}** (<@${u.userId}>) — granted ${date}`;
          }).join('\n')
        : '_No additional users granted access._';
      return msg.reply({
        embeds: [new EmbedBuilder()
          .setColor(COLORS.INFO)
          .setTitle('Access List')
          .setDescription(`${ownerLine}\n\n**Granted Users:**\n${userLines}`)
        ]
      });
    }

    default:
      // Unknown intent — treat as question
      return handleClaudeRequest(msg, query, { sessionId: options.sessionId });
  }
}

// ============================================================
//  START BOT
// ============================================================

function startBot() {
  client.on('clientReady', async () => {
    console.log(`Bot online as ${client.user.tag}`);
    console.log(`Trigger: bot name "${client.user.username}" or @mention`);
    console.log(`Model: ${config.claudeModel}`);
    console.log(`Thread inactivity timeout: ${config.threadInactivityMs / 1000}s`);
    console.log(`PAT encryption: ${config.tokenEncryptionSecret ? 'enabled' : 'DISABLED'}`);

    // Register slash commands
    await registerCommands(client);

    // Clean expired workspaces on startup
    try { cleanExpiredWorkspaces(); } catch (_) {}

    // Start inactivity timers for existing threads (also prunes stale ones)
    try { await startInactivityTimers(client); } catch (err) {
      console.error('Failed to start inactivity timers:', err.message);
    }
  });

  // Slash command + component interaction handler
  const interactionDeps = {
    getToken,
    storeToken,
    hasToken,
    handleClaudeRequest,
    splitMessage,
    tryHaikuAnswer,
    shouldSkipHaiku,
    suppressLinkEmbeds,
    client
  };

  client.on('interactionCreate', async (interaction) => {
    try {
      // Button clicks and select menus
      if (interaction.isButton() || interaction.isStringSelectMenu()) {
        return await handleComponentInteraction(interaction, interactionDeps);
      }

      // Modal submissions — follow-up and request-changes
      if (interaction.isModalSubmit()) {
        if (interaction.customId.startsWith('followup_modal_')) {
          return await handleFollowUpModal(interaction, interactionDeps);
        }
        if (interaction.customId.startsWith('reqchanges_modal_')) {
          return await handleReqChangesModal(interaction);
        }
        // Fall through to slash-commands.js for PAT modal
      }

      // Context menu commands (right-click message)
      if (interaction.isMessageContextMenuCommand()) {
        return await handleContextMenu(interaction, interactionDeps);
      }

      // Slash commands + PAT modal
      await handleInteraction(interaction, interactionDeps);
    } catch (err) {
      console.error('Interaction error:', err);
      try {
        const reply = interaction.replied || interaction.deferred
          ? interaction.followUp.bind(interaction)
          : interaction.reply.bind(interaction);
        await reply({ content: `Error: ${err.message}`, ephemeral: true });
      } catch (_) {}
    }
  });

  client.on('messageCreate', async (msg) => {
    if (msg.author.bot) return;

    // DM handling
    if (!msg.guild) {
      if (!isAllowed(msg.author.id)) {
        return msg.reply(denyMessage());
      }
      return handleDM(msg);
    }

    const content = msg.content.trim();

    // ── In registered chat thread ─────────────────────────────────────
    if (isChatThread(msg.channel.id)) {
      if (!isAllowed(msg.author.id)) {
        return msg.reply({ embeds: [new EmbedBuilder().setColor(COLORS.ERROR).setDescription(denyMessage())] });
      }

      // Check for stop keywords while a request is in-flight
      const activeCtx = activeRequests.get(msg.channel.id);
      if (activeCtx && /^(stop|cancel|abort|nevermind)$/i.test(content)) {
        activeCtx._aborted = true;
        await msg.react('\u23F9').catch(() => {});
        return;
      }

      // Reset inactivity timer on every message
      touchThread(msg.channel.id);

      // Auto-rename: on 1st or 2nd message in a generically-named thread, ask Haiku for a better title
      const msgCount = incrementMessageCount(msg.channel.id);
      if (msgCount <= 2 && shouldAutoRename(msg.channel.id)) {
        const trimmed = content.trim();
        if (trimmed.length > 5) {
          // Fire-and-forget — don't block message handling
          generateThreadTitle(trimmed).then(title => {
            if (title && title !== 'CodeBot Chat') {
              msg.channel.setName(title).then(() => {
                markRenamed(msg.channel.id);
                console.log(`[chat-threads] Auto-renamed thread ${msg.channel.id} → "${title}"`);
              }).catch(() => {});
            }
          }).catch(() => {});
        }
      }

      // Check if message is prefixed with bot name/mention (for in-thread commands like "CodeBot close")
      const trigger = extractBotTrigger(content);
      if (trigger !== null) {
        // Classify the triggered query through the in-thread classifier
        return handleChatMode({ ...msg, content: trigger.query, channel: msg.channel }).catch(err => {
          console.error('Unhandled error in chat thread (triggered):', err);
          msg.reply('Something went wrong. Please try again.').catch(() => {});
        });
      }

      // No trigger — route through Haiku classifier for natural language
      return handleChatMode(msg).catch(err => {
        console.error('Unhandled error in chat thread:', err);
        msg.reply('Something went wrong. Please try again.').catch(() => {});
      });
    }

    // ── Channel message — check for bot trigger ───────────────────────
    const trigger = extractBotTrigger(content);
    if (trigger === null) return; // Not directed at us — ignore

    // Access control — only check after confirming message is for us
    if (!isAllowed(msg.author.id)) {
      return msg.reply({ embeds: [new EmbedBuilder().setColor(COLORS.ERROR).setDescription(denyMessage())] });
    }

    const { query, atStart } = trigger;

    // Empty query after stripping bot name (e.g., just "CodeBot")
    if (!query) {
      return msg.reply({ embeds: [buildHelpEmbed(msg.author.id)] });
    }

    // ── Keyword pre-check — catch built-in intents before classifier ──
    // These keywords need special routing regardless of bot name position.
    const queryLower = query.toLowerCase().trim();
    const keywordIntent = matchKeywordIntent(queryLower, query);

    if (keywordIntent) {
      const kwSessionId = generateSessionId();
      console.log(`[channel] "${content.substring(0, 80)}" → keyword match: ${keywordIntent.intent}`);
      logUserMessage(msg.channel.id, {
        sessionId: kwSessionId, userId: msg.author.id, displayName: msg.author.username,
        channelId: msg.channel.id, guildId: msg.guild?.id,
        content: content.substring(0, 500), source: 'channel_keyword', inThread: false
      });
      logIntentClassification(msg.channel.id, {
        sessionId: kwSessionId, userId: msg.author.id,
        method: 'keyword_match', intent: keywordIntent.intent, query: keywordIntent.query
      });
      try {
        await routeChannelIntent(msg, keywordIntent.intent, keywordIntent.query, { sessionId: kwSessionId });
      } catch (err) {
        console.error('Unhandled error in channel message handler:', err);
        msg.reply('Something went wrong. Please try again.').catch(() => {});
      }
      return;
    }

    await msg.channel.sendTyping();

    // Bot name at the START of the message → user is talking TO the bot.
    // Skip the classifier and route directly as a question (saves a Haiku call
    // and avoids false "ignore" classifications).
    if (atStart) {
      const directSessionId = generateSessionId();
      console.log(`[channel] "${content.substring(0, 80)}" → direct (bot name at start), query="${query.substring(0, 80)}"`);
      logUserMessage(msg.channel.id, {
        sessionId: directSessionId, userId: msg.author.id, displayName: msg.author.username,
        channelId: msg.channel.id, guildId: msg.guild?.id,
        content: content.substring(0, 500), source: 'channel_at_start', inThread: false
      });
      logIntentClassification(msg.channel.id, {
        sessionId: directSessionId, userId: msg.author.id,
        method: 'direct_routing', intent: 'question', query: query.substring(0, 500)
      });
      try {
        await routeChannelIntent(msg, 'question', query, { sessionId: directSessionId });
      } catch (err) {
        console.error('Unhandled error in channel message handler:', err);
        msg.reply('Something went wrong. Please try again.').catch(() => {});
      }
      return;
    }

    // Bot name in the MIDDLE/END → could be casual mention. Classify with Haiku.
    const haikuSessionId = generateSessionId();
    const botName = client.user.username;

    logUserMessage(msg.channel.id, {
      sessionId: haikuSessionId, userId: msg.author.id, displayName: msg.author.username,
      channelId: msg.channel.id, guildId: msg.guild?.id,
      content: content.substring(0, 500), source: 'channel_mention', inThread: false
    });

    const { intent, query: classifiedQuery, usage } = await classifyChannelMessage(query, botName);

    // Track classifier cost
    if (usage) {
      const { trackApiCall, trackTokens } = require('./utils/usage');
      trackApiCall(msg.author.id);
      trackTokens(msg.author.id, usage.input_tokens || 0, usage.output_tokens || 0, config.classifierModel);
    }

    const classifierCost = usage
      ? calculateCost(config.classifierModel, usage.input_tokens || 0, usage.output_tokens || 0)
      : 0;

    logIntentClassification(msg.channel.id, {
      sessionId: haikuSessionId, userId: msg.author.id,
      method: 'haiku_classifier', intent, query: (classifiedQuery || query).substring(0, 500),
      classifierTokens: usage ? { input: usage.input_tokens, output: usage.output_tokens } : null,
      classifierCost
    });

    console.log(`[channel] "${content.substring(0, 80)}" → intent=${intent}, query="${(classifiedQuery || '').substring(0, 80)}"`);

    try {
      await routeChannelIntent(msg, intent, classifiedQuery || query, { sessionId: haikuSessionId });
    } catch (err) {
      console.error('Unhandled error in channel message handler:', err);
      msg.reply('Something went wrong. Please try again.').catch(() => {});
    }
  });

  client.login(config.discordToken);
}

module.exports = { startBot, client, handleClaudeRequest, splitMessage };

const config = require('./utils/config');
const { getToolDefinitions, executeTool } = require('./tools');
const { trackApiCall, trackTokens, calculateCost } = require('./utils/usage');
const { logApiCall, logToolCall } = require('./utils/conversation-log');
const { CLIClient, isCliAvailable } = require('./utils/claude-cli');

// Client selection: API key → Anthropic SDK, otherwise → Claude CLI (Max subscription)
let anthropic = null;
let clientMode = 'none';

if (config.anthropicApiKey) {
  const Anthropic = require('@anthropic-ai/sdk');
  anthropic = new Anthropic({ apiKey: config.anthropicApiKey });
  clientMode = 'api';
  console.log('[claude] Using Anthropic API (api key)');
} else if (isCliAvailable()) {
  anthropic = new CLIClient();
  clientMode = 'cli';
  console.log('[claude] Using Claude CLI (Max subscription)');
} else {
  console.warn('[claude] No AI backend available — ANTHROPIC_API_KEY not set and claude CLI not found');
}

// ============================================================
//  Context size management
// ============================================================

const TOOL_RESULT_MAX_CHARS = 12000;   // ~3K tokens per tool result
const CONTEXT_TOKEN_BUDGET = 50000;    // Trim older tool results above this
const MAX_HISTORY_MESSAGES = 10;       // Only send last N conversation messages

// Rough token estimate (~4 chars per token)
function estimateTokens(messages) {
  let chars = 0;
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      chars += msg.content.length;
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        chars += typeof block === 'string' ? block.length : JSON.stringify(block).length;
      }
    }
  }
  return Math.ceil(chars / 4);
}

function truncateResult(text) {
  if (text.length <= TOOL_RESULT_MAX_CHARS) return text;
  return text.substring(0, TOOL_RESULT_MAX_CHARS) +
    `\n\n[... truncated — original ${text.length} chars. Request specific sections if needed.]`;
}

// Trim older tool iterations when context exceeds budget
function trimOlderToolResults(messages) {
  const estimated = estimateTokens(messages);
  if (estimated <= CONTEXT_TOKEN_BUDGET) return messages;

  const trimmed = [...messages];

  // Aggressively compress tool results from older iterations (keep last 4 messages intact)
  for (let i = 0; i < trimmed.length - 4; i++) {
    const msg = trimmed[i];
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      trimmed[i] = {
        role: 'user',
        content: msg.content.map(block => {
          if (block.type === 'tool_result' && typeof block.content === 'string' && block.content.length > 500) {
            return { ...block, content: block.content.substring(0, 500) + '\n[... trimmed to save context ...]' };
          }
          return block;
        })
      };
    }
    if (estimateTokens(trimmed) <= CONTEXT_TOKEN_BUDGET) break;
  }

  const after = estimateTokens(trimmed);
  if (after < estimated) {
    console.log(`[context] Trimmed ${estimated} → ${after} estimated tokens`);
  }
  return trimmed;
}

// ============================================================
//  Main tool-use loop
// ============================================================

async function callClaude(messages, systemPrompt, context, options = {}) {
  if (!anthropic) {
    throw new Error('AI features unavailable — set ANTHROPIC_API_KEY or install Claude CLI');
  }

  const tools = getToolDefinitions();

  // Only send recent conversation history to avoid bloated context
  const recentHistory = messages.length > MAX_HISTORY_MESSAGES
    ? messages.slice(-MAX_HISTORY_MESSAGES)
    : [...messages];

  let currentMessages = recentHistory;
  let iterations = 0;
  let lastResponse = null;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  // Track tools used and PR context for post-response buttons
  const toolsUsed = new Set();
  let prContext = null;

  // Tool result dedup cache — prevents wasted iterations on identical tool calls
  // Exclude tools that read mutable state (their output changes after write operations)
  const CACHE_EXEMPT_TOOLS = new Set([
    'git_status', 'git_diff', 'git_log', 'repo_list', 'repo_read',
    'shell'
  ]);
  const toolCache = new Map();

  while (iterations < config.maxToolIterations) {
    iterations++;

    // Check abort flag — allows users to cancel via Stop button or keyword
    if (context._aborted) {
      console.log(`[claude] Request aborted by user at iteration ${iterations}`);
      break;
    }

    // Trim context if it's grown too large from tool results
    currentMessages = trimOlderToolResults(currentMessages);

    const estTokens = estimateTokens(currentMessages);
    console.log(`[claude] Iteration ${iterations} — ~${estTokens} input tokens, ${currentMessages.length} messages`);

    const params = {
      model: config.claudeModel,
      max_tokens: 4096,
      messages: currentMessages,
      tools
    };

    // Prompt caching: system prompt + tool defs cached at 90% discount on iterations 2+
    if (systemPrompt) {
      params.system = [
        { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }
      ];
    }

    const apiStart = Date.now();
    const response = await anthropic.messages.create(params);
    const apiDurationMs = Date.now() - apiStart;
    lastResponse = response;

    // Accumulate token usage across iterations
    const iterInputTokens = response.usage?.input_tokens || 0;
    const iterOutputTokens = response.usage?.output_tokens || 0;
    totalInputTokens += iterInputTokens;
    totalOutputTokens += iterOutputTokens;

    // Track usage per user
    if (context.userId) {
      trackApiCall(context.userId);
      if (response.usage) {
        trackTokens(context.userId, iterInputTokens, iterOutputTokens, config.claudeModel);
      }
    }

    // Log API call if session is active
    if (context._logSession) {
      logApiCall(context.channelId, {
        sessionId: context._logSession,
        userId: context.userId,
        iteration: iterations,
        model: config.claudeModel,
        inputTokens: iterInputTokens,
        outputTokens: iterOutputTokens,
        cost: calculateCost(config.claudeModel, iterInputTokens, iterOutputTokens),
        stopReason: response.stop_reason,
        estimatedContextTokens: estTokens,
        messageCount: currentMessages.length,
        durationMs: apiDurationMs
      });
    }

    // Continue loop only if Claude explicitly requests tool use
    if (response.stop_reason !== 'tool_use') {
      break;
    }

    // Surface intermediate text to Discord immediately (before executing tools)
    if (options.onText) {
      const intermediateText = response.content
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('\n')
        .trim();
      if (intermediateText.length >= 20) {
        try { await options.onText(intermediateText); }
        catch (err) { console.error('[claude] onText callback error:', err.message); }
      }
    }

    const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');

    // Notify caller about tool execution (for real-time status updates)
    if (options.onToolStart && toolUseBlocks.length > 0) {
      const toolNames = toolUseBlocks.map(t => t.name).join(', ');
      try { await options.onToolStart(toolNames); } catch (_) {}
    }

    // Add Claude's response to messages
    currentMessages.push({ role: 'assistant', content: response.content });

    // Execute each tool and collect results
    const toolResults = [];
    for (const toolUse of toolUseBlocks) {
      // Track tool usage for metadata
      toolsUsed.add(toolUse.name);

      // Detect PR context for post-response action buttons
      if ((toolUse.name === 'github_get_pr' || toolUse.name === 'github_review_pr') && toolUse.input) {
        const repo = toolUse.input.repo;
        const prNum = toolUse.input.pr_number;
        if (repo && prNum) {
          const parts = repo.split('/');
          if (parts.length === 2) {
            prContext = { owner: parts[0], repo: parts[1], number: prNum };
          }
        }
      }
      let result;
      let toolError = null;
      const toolStart = Date.now();

      // Check dedup cache — skip re-execution of identical tool calls
      const cacheKey = `${toolUse.name}:${JSON.stringify(toolUse.input)}`;
      if (toolCache.has(cacheKey) && !CACHE_EXEMPT_TOOLS.has(toolUse.name)) {
        result = toolCache.get(cacheKey) + '\n\n[Cached — identical to previous call. Try a different approach or parameters.]';
        console.log(`[tool] ${toolUse.name} — cache hit (dedup)`);
      } else {
        try {
          console.log(`[tool] ${toolUse.name}(${JSON.stringify(toolUse.input).substring(0, 200)})`);
          result = await executeTool(toolUse.name, toolUse.input, context);
          // Cache the result for dedup
          toolCache.set(cacheKey, typeof result === 'string' ? result : JSON.stringify(result));
        } catch (err) {
          console.error(`[tool] ${toolUse.name} error:`, err.message);
          toolError = err.message;
          result = `Error: ${err.message}`;
        }
      }
      const toolDurationMs = Date.now() - toolStart;

      // Truncate large tool results to prevent context explosion
      const resultStr = typeof result === 'string' ? result : JSON.stringify(result);

      // Log tool call if session is active
      if (context._logSession) {
        logToolCall(context.channelId, {
          sessionId: context._logSession,
          userId: context.userId,
          iteration: iterations,
          toolName: toolUse.name,
          toolInput: toolUse.input,
          resultLength: resultStr.length,
          resultPreview: resultStr.substring(0, 200),
          durationMs: toolDurationMs,
          error: toolError
        });
      }

      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: truncateResult(resultStr)
      });

      // Check abort between tool executions within the same iteration
      if (context._aborted) break;
    }

    // If aborted mid-tools, still need to feed partial results so we can break cleanly
    if (context._aborted) {
      console.log(`[claude] Aborted during tool execution at iteration ${iterations}`);
      break;
    }

    // Inject phase-aware iteration/cost status so Claude can self-regulate
    const costSoFar = calculateCost(config.claudeModel, totalInputTokens, totalOutputTokens);
    const maxIter = config.maxToolIterations;
    const pct = iterations / maxIter;
    const phase = iterations <= 3 ? 'Research'
      : pct < 0.7 ? 'Action'
      : pct < 0.9 ? 'Wrap up'
      : 'STOP';
    toolResults.push({
      type: 'text',
      text: `[System: Iteration ${iterations}/${maxIter} (${phase}) | Tokens: ${totalInputTokens + totalOutputTokens} | Cost: $${costSoFar.toFixed(2)}]`
    });

    // Add tool results as user message
    currentMessages.push({ role: 'user', content: toolResults });
  }

  if (iterations >= config.maxToolIterations) {
    console.warn(`Tool-use loop hit max iterations (${config.maxToolIterations})`);

    // Force a final summary call so the user gets something useful
    currentMessages.push({
      role: 'user',
      content: 'You have reached your tool iteration limit. Do NOT call any more tools. ' +
        'Summarize everything you have found so far and provide your best answer with the information you have gathered.'
    });

    const summaryResponse = await anthropic.messages.create({
      model: config.claudeModel,
      max_tokens: 4096,
      messages: trimOlderToolResults(currentMessages),
      ...(systemPrompt ? { system: systemPrompt } : {})
      // No tools — force a text-only response
    });

    const sumInputTokens = summaryResponse.usage?.input_tokens || 0;
    const sumOutputTokens = summaryResponse.usage?.output_tokens || 0;
    totalInputTokens += sumInputTokens;
    totalOutputTokens += sumOutputTokens;

    if (context.userId) {
      trackApiCall(context.userId);
      if (summaryResponse.usage) {
        trackTokens(context.userId, sumInputTokens, sumOutputTokens, config.claudeModel);
      }
    }

    lastResponse = summaryResponse;
  }

  return {
    response: lastResponse,
    iterations,
    totalUsage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
    toolsUsed: [...toolsUsed],
    prContext
  };
}

// Extract text content from Claude response
function extractText(response) {
  if (!response || !response.content) return '';
  return response.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('\n');
}

// ============================================================
//  Lightweight message classifier using Haiku
//  Used by chat mode to route natural language to commands
// ============================================================

const CLASSIFIER_MODEL = config.classifierModel;

const CLASSIFIER_PROMPT = `You are a command parser for a Discord coding assistant bot called CodeBot.
Given a user message in a chat thread, determine if it maps to a built-in command or is a general question/request.

Available commands:
- help: user wants to see help, commands, or capabilities
- status: user wants to see their registration status
- profile_show: user wants to view their profile
- profile_set: user wants to change a profile setting. Extract key (repo|name|email|branch) and value.
- workspaces: user wants to list their workspaces/cloned repos
- workspace_clean: user wants to clean/delete a workspace. Extract the repo (owner/repo format).
- usage: user wants to see usage stats, costs, token counts
- exit_chat: user wants to leave/close/end the thread, exit chat, stop chatting, says "bye", "done", "close", "exit"
- general: anything else — a coding question, request, conversation, etc.

Return ONLY a JSON object, no markdown, no explanation:
{"command": "...", "args": "..."}

args should be empty string "" unless the command needs arguments.
For profile_set, args should be like "repo owner/repo" or "name John Smith" or "email j@x.com" or "branch feat".
For workspace_clean, args should be the repo like "owner/repo".
For general, args should be the full original message.`;

async function classifyMessage(text) {
  if (!anthropic) {
    return { command: 'general', args: text, usage: null };
  }

  // CLI/Max mode: keyword match instead of burning a round-trip on classification
  if (clientMode === 'cli') {
    return _keywordClassify(text);
  }

  try {
    const response = await anthropic.messages.create({
      model: CLASSIFIER_MODEL,
      max_tokens: 150,
      system: CLASSIFIER_PROMPT,
      messages: [{ role: 'user', content: text }]
    });

    const raw = response.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');

    // Parse JSON from response — handle possible markdown wrapping
    const jsonStr = raw.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(jsonStr);
    return {
      command: parsed.command || 'general',
      args: parsed.args || '',
      usage: response.usage
    };
  } catch (err) {
    console.error('Classifier error:', err.message);
    // On failure, treat as general query
    return { command: 'general', args: text, usage: null };
  }
}

// Lightweight keyword classifier — no API call needed
function _keywordClassify(text) {
  const lower = text.toLowerCase().trim();
  if (/^(help|commands|capabilities|what can you)/.test(lower))
    return { command: 'help', args: '', usage: null };
  if (/^(status|am i registered|registration)/.test(lower))
    return { command: 'status', args: '', usage: null };
  if (/^(usage|stats|cost|tokens|how much)/.test(lower))
    return { command: 'usage', args: '', usage: null };
  if (/^(workspaces?|list.*repos|cloned)/.test(lower))
    return { command: 'workspaces', args: '', usage: null };
  if (/^(bye|done|close|exit|leave|end|quit|stop( chat)?|enough|nevermind|never mind|cancel)$/.test(lower))
    return { command: 'exit_chat', args: '', usage: null };
  if (/^(show|view|my) ?(profile|settings)/.test(lower))
    return { command: 'profile_show', args: '', usage: null };
  if (/^(set|change|update) ?(profile|repo|name|email|branch)/.test(lower)) {
    return { command: 'profile_set', args: text, usage: null };
  }
  if (/^(clean|delete|remove) ?(workspace|repo)/.test(lower)) {
    return { command: 'workspace_clean', args: text.replace(/^(clean|delete|remove)\s*(workspace|repo)\s*/i, ''), usage: null };
  }
  return { command: 'general', args: text, usage: null };
}

// ============================================================
//  Quick acknowledgment generator using Haiku
//  Used to give immediate feedback before long tool-use tasks
// ============================================================

const ACK_PROMPT = `You are a friendly Discord coding assistant. The user just sent a request that will take a while to process.
Write a SHORT (1-2 sentence max) acknowledgment message. Be specific to what they asked — reference the issue number, repo, or task.
Do NOT start with "Sure" or "Certainly". Be natural, energetic, concise. Use one relevant emoji at most.
Examples:
- "Pulling up Issue #21 and scanning the log for errors — hang tight."
- "Cloning the repo now to dig into that bug. One moment."
- "On it — reviewing PR #45 for you."`;

async function generateAcknowledgment(query) {
  if (!anthropic) return null;

  try {
    const response = await anthropic.messages.create({
      model: CLASSIFIER_MODEL,
      max_tokens: 100,
      system: ACK_PROMPT,
      messages: [{ role: 'user', content: query }]
    });

    const text = response.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');

    return text.trim() || null;
  } catch (err) {
    console.error('Ack generation error:', err.message);
    return null;
  }
}

// ============================================================
//  Thread title generator using Haiku
//  Produces a concise 3-6 word title for a Discord thread
// ============================================================

const TITLE_PROMPT = `Given the user's request, generate a SHORT Discord thread title (3-6 words max, under 100 characters).
The title should capture the essence of the request. No quotes, no punctuation at the end, no prefixes like "Title:".
Just output the title text — nothing else.

Examples:
- "Can you fix the login bug on the auth page?" → "Fix Login Auth Bug"
- "Review PR #45 for memory leaks" → "PR 45 Memory Leak Review"
- "What is a JavaScript promise?" → "JavaScript Promises Explained"
- "Help me refactor the database module" → "Database Module Refactor"`;

async function generateThreadTitle(query) {
  if (!anthropic) return 'CodeBot Chat';

  try {
    const response = await anthropic.messages.create({
      model: CLASSIFIER_MODEL,
      max_tokens: 60,
      system: TITLE_PROMPT,
      messages: [{ role: 'user', content: query }]
    });

    const text = response.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('')
      .trim();

    // Discord thread name limit is 100 chars; enforce 3+ chars
    if (text && text.length >= 3) {
      return text.substring(0, 100);
    }
    return 'CodeBot Chat';
  } catch (err) {
    console.error('Thread title generation error:', err.message);
    return 'CodeBot Chat';
  }
}

// ============================================================
//  Channel-level message classifier using Haiku
//  Determines intent when someone mentions the bot in a channel
// ============================================================

function buildChannelClassifierPrompt(botName) {
  return `You are classifying a Discord message that was directed at a bot called "${botName}".

IMPORTANT: The user already mentioned the bot by name or @mentioned it. The bot name has been stripped. You are classifying what remains.

Since the user deliberately mentioned the bot, ASSUME they want something. Only use "ignore" if the leftover text is CLEARLY about the bot itself (opinions, complaints about the bot as a topic). When in doubt, use "question".

Categories:
- ignore: ONLY when the leftover text is clearly an opinion or statement ABOUT the bot itself, not a request TO it. Examples: "is cool", "is great", "is broken today", "has anyone tried". Also use for empty/meaningless leftover text like "," or "!".
- chat: Wants to start an ongoing conversation. Examples: "let's chat", "can we discuss this project?", "chat about issue 21", "let's talk about the auth module".
- question: ANY question or request that needs at most ONE tool call or can be answered from knowledge alone. This is the DEFAULT — use it unless the request clearly needs multi-step work. Examples: "what is a promise?", "how does git rebase work?", "explain async/await", "what is the best language for game modding?", "how do I use GitHub Actions?", "what is Lua?", "tell me about Farming Simulator modding", "what's in issue #21?" (single API call), "show me the README of owner/repo" (single file fetch).
- action: Request that needs MULTIPLE tool calls — code editing, git workflow, multi-step analysis, or creating PRs/branches. Examples: "fix issue #21", "review this PR https://github.com/...", "analyze the auth module and suggest improvements", "help me refactor the database", "clone owner/repo and look at the tests", "create a PR for this fix".
- help: Wants to see bot capabilities/commands. Examples: "what can you do?", "help", "show me your commands".
- status: Wants registration/status info. Examples: "am I registered?", "show my status", "what's my setup?".
- profile: Wants to view or update profile. Examples: "show my profile", "set my default repo to owner/repo", "change my branch prefix to fix".
- usage: Wants usage stats. Examples: "how many tokens have I used?", "what's my cost?", "show my usage".

Return ONLY a JSON object, no markdown, no explanation:
{"intent": "...", "query": "..."}

- intent: one of the categories above
- query: the actual request, cleaned up. For ignore, query should be empty string.`;
}

async function classifyChannelMessage(text, botName) {
  if (!anthropic) {
    return { intent: 'question', query: text, usage: null };
  }

  // CLI/Max mode: keyword match instead of burning a round-trip
  if (clientMode === 'cli') {
    return _keywordClassifyChannel(text);
  }

  try {
    const response = await anthropic.messages.create({
      model: CLASSIFIER_MODEL,
      max_tokens: 150,
      system: buildChannelClassifierPrompt(botName),
      messages: [{ role: 'user', content: text }]
    });

    const raw = response.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');

    const jsonStr = raw.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(jsonStr);
    return {
      intent: parsed.intent || 'ignore',
      query: parsed.query || '',
      usage: response.usage
    };
  } catch (err) {
    console.error('Channel classifier error:', err.message);
    // On failure, treat as question (cheapest safe default — answers in-channel)
    return { intent: 'question', query: text, usage: null };
  }
}

// Lightweight channel keyword classifier — no API call needed
function _keywordClassifyChannel(text) {
  const lower = text.toLowerCase().trim();
  if (!lower || /^[,!?.;:\s]+$/.test(lower))
    return { intent: 'ignore', query: '', usage: null };
  if (/^(help|commands|what can you)/.test(lower))
    return { intent: 'help', query: text, usage: null };
  if (/^(status|am i registered|my setup)/.test(lower))
    return { intent: 'status', query: text, usage: null };
  if (/^(usage|stats|cost|tokens)/.test(lower))
    return { intent: 'usage', query: text, usage: null };
  if (/^(profile|show.*profile|set.*repo|set.*name|set.*email)/.test(lower))
    return { intent: 'profile', query: text, usage: null };
  if (/^(chat|let'?s (chat|talk|discuss))/.test(lower))
    return { intent: 'chat', query: text, usage: null };
  if (/^(fix|review|analyze|clone|refactor|edit|patch|create.*pr|create.*branch)/.test(lower))
    return { intent: 'action', query: text, usage: null };
  // Default: treat as question — Sonnet can handle it
  return { intent: 'question', query: text, usage: null };
}

// ============================================================
//  Haiku-first: attempt to answer simple questions cheaply
//  before escalating to full Sonnet + tools pipeline
// ============================================================

const HAIKU_FIRST_PROMPT = `You are a helpful coding assistant answering a question on Discord.
If you can answer fully and accurately from your knowledge, do so concisely (Discord markdown, under 1500 chars).
If the question requires GitHub access, web search, file reading, code execution, or ANY external data — respond with ONLY "[NEEDS_TOOLS]".
When in doubt, respond with [NEEDS_TOOLS]. Never guess about specific repos, issues, PRs, or code.`;

async function tryHaikuAnswer(query, userId) {
  if (!anthropic || clientMode === 'cli') {
    // CLI/Max mode: skip Haiku-first, go straight to Sonnet (no per-token cost)
    return { answered: false, usage: null };
  }

  try {
    const model = config.haikuFirstModel;
    const response = await anthropic.messages.create({
      model,
      max_tokens: 1024,
      system: HAIKU_FIRST_PROMPT,
      messages: [{ role: 'user', content: query }]
    });

    const text = response.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('')
      .trim();

    // Track usage
    if (userId) {
      const inputTokens = response.usage?.input_tokens || 0;
      const outputTokens = response.usage?.output_tokens || 0;
      trackApiCall(userId);
      trackTokens(userId, inputTokens, outputTokens, model);
    }

    // Escalate: explicit needs-tools signal
    if (text.includes('[NEEDS_TOOLS]')) {
      console.log(`[haiku-first] "${query.substring(0, 60)}" → [NEEDS_TOOLS] — escalating to Sonnet`);
      return { answered: false, usage: response.usage };
    }

    // Escalate: degenerate response
    if (text.length < 10) {
      console.log(`[haiku-first] "${query.substring(0, 60)}" → response too short (${text.length} chars) — escalating`);
      return { answered: false, usage: response.usage };
    }

    console.log(`[haiku-first] "${query.substring(0, 60)}" → answered (${text.length} chars)`);
    return { answered: true, text, usage: response.usage };
  } catch (err) {
    console.error('[haiku-first] Error — silently falling back to Sonnet:', err.message);
    return { answered: false, usage: null };
  }
}

module.exports = { callClaude, extractText, classifyMessage, classifyChannelMessage, generateAcknowledgment, generateThreadTitle, tryHaikuAnswer, clientMode };

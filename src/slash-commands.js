const {
  SlashCommandBuilder,
  ContextMenuCommandBuilder,
  ApplicationCommandType,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  EmbedBuilder
} = require('discord.js');
const { isAllowed, denyMessage } = require('./utils/access-control');
const { getProfile } = require('./utils/user-profiles');

// ---------------------------------------------------------------------------
// Autocomplete caches — per-user, 60-second TTL
// ---------------------------------------------------------------------------

const repoCache = new Map();   // userId → { repos: [], timestamp }
const prCache = new Map();     // "owner/repo" → { prs: [], timestamp }
const issueCache = new Map();  // "owner/repo" → { issues: [], timestamp }
const CACHE_TTL_MS = 60 * 1000;

// ---------------------------------------------------------------------------
// Command definitions
// ---------------------------------------------------------------------------

const commands = [
  new SlashCommandBuilder()
    .setName('codereview')
    .setDescription('Review a pull request')
    .addStringOption(opt =>
      opt.setName('pr_url')
        .setDescription('GitHub PR URL or select from open PRs')
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addStringOption(opt =>
      opt.setName('focus')
        .setDescription('Focus areas (e.g., security, performance)')
        .setRequired(false)
    )
    .addStringOption(opt =>
      opt.setName('depth')
        .setDescription('Review depth')
        .setRequired(false)
        .addChoices(
          { name: 'Quick scan', value: 'quick' },
          { name: 'Thorough review', value: 'thorough' },
          { name: 'Security-focused', value: 'security' }
        )
    ),

  new SlashCommandBuilder()
    .setName('codefix')
    .setDescription('Fix a GitHub issue and create a PR')
    .addStringOption(opt =>
      opt.setName('issue_url')
        .setDescription('GitHub issue URL or select from open issues')
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addStringOption(opt =>
      opt.setName('approach')
        .setDescription('Fix approach guidance (optional)')
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('codepat')
    .setDescription('Securely register your GitHub Personal Access Token'),

  new SlashCommandBuilder()
    .setName('codestatus')
    .setDescription('Show your registration status'),

  new SlashCommandBuilder()
    .setName('codeask')
    .setDescription('Ask Claude anything')
    .addStringOption(opt =>
      opt.setName('question')
        .setDescription('The question to ask')
        .setRequired(true)
    )
    .addStringOption(opt =>
      opt.setName('repo')
        .setDescription('Repository context (owner/repo)')
        .setRequired(false)
        .setAutocomplete(true)
    ),

  new SlashCommandBuilder()
    .setName('codehelp')
    .setDescription('Show all CodeBot commands and capabilities'),
];

// Context menu commands (right-click message actions)
const contextMenuCommands = [
  new ContextMenuCommandBuilder()
    .setName('Debug This')
    .setType(ApplicationCommandType.Message),
  new ContextMenuCommandBuilder()
    .setName('Explain This')
    .setType(ApplicationCommandType.Message),
  new ContextMenuCommandBuilder()
    .setName('Review PR')
    .setType(ApplicationCommandType.Message),
];

const allCommands = [...commands, ...contextMenuCommands];

// ---------------------------------------------------------------------------
// Register slash commands globally on the bot's application
// ---------------------------------------------------------------------------

async function registerCommands(client) {
  try {
    // Register per-guild for instant availability (global commands take up to 1 hour)
    const guilds = client.guilds.cache;
    for (const [guildId, guild] of guilds) {
      try {
        await guild.commands.set(allCommands);
        console.log(`Registered ${allCommands.length} commands in guild: ${guild.name} (${guildId})`);
      } catch (err) {
        console.error(`Failed to register commands in guild ${guild.name}: ${err.message}`);
      }
    }

    // Also register globally (for any guilds the bot joins later)
    await client.application.commands.set(allCommands);
    console.log(`Registered ${allCommands.length} commands globally`);
  } catch (err) {
    console.error('Failed to register slash commands:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Parse a GitHub URL into { owner, repo, type, number }
// type is either "issues" or "pull"
// ---------------------------------------------------------------------------

function parseGitHubUrl(url) {
  const match = url.match(
    /github\.com\/([^/]+)\/([^/]+)\/(issues|pull)\/(\d+)/
  );
  if (!match) {
    throw new Error(
      'Invalid GitHub URL. Expected format: `https://github.com/owner/repo/issues/123` or `.../pull/456`'
    );
  }
  return {
    owner: match[1],
    repo: match[2],
    type: match[3],       // "issues" or "pull"
    number: parseInt(match[4], 10)
  };
}

// ---------------------------------------------------------------------------
// Shared colours (mirrors bot.js)
// ---------------------------------------------------------------------------

const COLORS = {
  SUCCESS: 0x2ecc71,
  ERROR: 0xe74c3c,
  INFO: 0x5865f2,
  WARNING: 0xfee75c
};

// ---------------------------------------------------------------------------
// Handle all interaction events (slash commands + modal submits + autocomplete)
//
// deps = {
//   getToken, storeToken, hasToken,
//   handleClaudeRequest, splitMessage,
//   tryHaikuAnswer, shouldSkipHaiku, suppressLinkEmbeds,
//   client
// }
// ---------------------------------------------------------------------------

async function handleInteraction(interaction, deps) {
  // ---- Autocomplete -------------------------------------------------------
  if (interaction.isAutocomplete()) {
    return handleAutocomplete(interaction, deps);
  }

  // ---- Modal submit (PAT entry) -------------------------------------------
  if (interaction.isModalSubmit()) {
    if (interaction.customId === 'pat_modal') {
      if (!isAllowed(interaction.user.id)) {
        return interaction.reply({ ephemeral: true, embeds: [new EmbedBuilder().setColor(0xe74c3c).setDescription(denyMessage())] });
      }
      return handlePatModalSubmit(interaction, deps);
    }
    return; // unknown modal — handled by interaction-handler.js
  }

  // ---- Slash commands -----------------------------------------------------
  if (!interaction.isChatInputCommand()) return;

  // Access control — block unauthorized users (except /codehelp which is informational)
  if (interaction.commandName !== 'codehelp' && !isAllowed(interaction.user.id)) {
    return interaction.reply({
      ephemeral: true,
      embeds: [new EmbedBuilder()
        .setColor(0xe74c3c)
        .setDescription(denyMessage())
      ]
    });
  }

  switch (interaction.commandName) {
    case 'codepat':
      return handlePatCommand(interaction);
    case 'codestatus':
      return handleStatusCommand(interaction, deps);
    case 'codereview':
      return handleReviewCommand(interaction, deps);
    case 'codefix':
      return handleFixCommand(interaction, deps);
    case 'codeask':
      return handleAskCommand(interaction, deps);
    case 'codehelp':
      return handleHelpCommand(interaction, deps);
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Autocomplete handler — routes to PR, issue, or repo autocomplete
// ---------------------------------------------------------------------------

async function handleAutocomplete(interaction, deps) {
  const focused = interaction.options.getFocused(true);
  const query = focused.value.toLowerCase();

  try {
    switch (interaction.commandName) {
      case 'codereview':
        return interaction.respond(await autocompletePRs(interaction.user.id, query, deps));
      case 'codefix':
        return interaction.respond(await autocompleteIssues(interaction.user.id, query, deps));
      case 'codeask':
        if (focused.name === 'repo') {
          return interaction.respond(await autocompleteRepos(interaction.user.id, query, deps));
        }
        break;
    }
    return interaction.respond([]);
  } catch (err) {
    console.error(`[autocomplete] ${interaction.commandName}/${focused.name} error:`, err.message);
    return interaction.respond([]);
  }
}

// ---------------------------------------------------------------------------
// Autocomplete: Open PRs for /codereview
// ---------------------------------------------------------------------------

async function autocompletePRs(userId, query, deps) {
  const token = deps.getToken(userId);
  if (!token) return [];

  const profile = getProfile(userId);
  const defaultRepo = profile.defaultRepo;
  if (!defaultRepo) return [];

  const cacheKey = defaultRepo;
  const cached = prCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return filterPRChoices(cached.prs, query);
  }

  try {
    const { Octokit } = require('@octokit/rest');
    const octokit = new Octokit({ auth: token });
    const [owner, repo] = defaultRepo.split('/');

    const { data } = await octokit.pulls.list({
      owner, repo, state: 'open', sort: 'updated', per_page: 25
    });

    const prs = data.map(pr => ({
      name: `#${pr.number}: ${pr.title.substring(0, 80)} (by ${pr.user?.login || 'unknown'})`.substring(0, 100),
      value: pr.html_url
    }));

    prCache.set(cacheKey, { prs, timestamp: Date.now() });
    return filterPRChoices(prs, query);
  } catch (err) {
    console.error('[autocomplete] PR fetch error:', err.message);
    return [];
  }
}

function filterPRChoices(prs, query) {
  if (!query) return prs.slice(0, 25);
  return prs.filter(pr =>
    pr.name.toLowerCase().includes(query) || pr.value.includes(query)
  ).slice(0, 25);
}

// ---------------------------------------------------------------------------
// Autocomplete: Open issues for /codefix
// ---------------------------------------------------------------------------

async function autocompleteIssues(userId, query, deps) {
  const token = deps.getToken(userId);
  if (!token) return [];

  const profile = getProfile(userId);
  const defaultRepo = profile.defaultRepo;
  if (!defaultRepo) return [];

  const cacheKey = defaultRepo;
  const cached = issueCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return filterIssueChoices(cached.issues, query);
  }

  try {
    const { Octokit } = require('@octokit/rest');
    const octokit = new Octokit({ auth: token });
    const [owner, repo] = defaultRepo.split('/');

    const { data } = await octokit.issues.listForRepo({
      owner, repo, state: 'open', sort: 'updated', per_page: 25
    });

    // Filter out PRs (GitHub API returns PRs as issues)
    const issues = data
      .filter(issue => !issue.pull_request)
      .map(issue => ({
        name: `#${issue.number}: ${issue.title.substring(0, 80)}`.substring(0, 100),
        value: issue.html_url
      }));

    issueCache.set(cacheKey, { issues, timestamp: Date.now() });
    return filterIssueChoices(issues, query);
  } catch (err) {
    console.error('[autocomplete] Issue fetch error:', err.message);
    return [];
  }
}

function filterIssueChoices(issues, query) {
  if (!query) return issues.slice(0, 25);
  return issues.filter(issue =>
    issue.name.toLowerCase().includes(query) || issue.value.includes(query)
  ).slice(0, 25);
}

// ---------------------------------------------------------------------------
// Autocomplete: Repos for /codeask
// ---------------------------------------------------------------------------

async function autocompleteRepos(userId, query, deps) {
  const token = deps.getToken(userId);
  const profile = getProfile(userId);
  const choices = [];

  // Always include default repo at the top if it matches
  if (profile.defaultRepo) {
    const defaultChoice = { name: `${profile.defaultRepo} (default)`, value: profile.defaultRepo };
    if (!query || defaultChoice.name.toLowerCase().includes(query)) {
      choices.push(defaultChoice);
    }
  }

  if (!token) return choices.slice(0, 25);

  const cached = repoCache.get(userId);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return mergeAndFilter(choices, cached.repos, query);
  }

  try {
    const { Octokit } = require('@octokit/rest');
    const octokit = new Octokit({ auth: token });

    const { data } = await octokit.repos.listForAuthenticatedUser({
      sort: 'pushed', per_page: 20
    });

    const repos = data.map(r => ({
      name: r.full_name.substring(0, 100),
      value: r.full_name
    }));

    repoCache.set(userId, { repos, timestamp: Date.now() });
    return mergeAndFilter(choices, repos, query);
  } catch (err) {
    console.error('[autocomplete] Repo fetch error:', err.message);
    return choices.slice(0, 25);
  }
}

function mergeAndFilter(existing, repos, query) {
  const seen = new Set(existing.map(c => c.value));
  for (const repo of repos) {
    if (!seen.has(repo.value)) {
      existing.push(repo);
      seen.add(repo.value);
    }
  }
  if (!query) return existing.slice(0, 25);
  return existing.filter(c =>
    c.name.toLowerCase().includes(query) || c.value.toLowerCase().includes(query)
  ).slice(0, 25);
}

// ---------------------------------------------------------------------------
// /pat — open a modal for secure PAT entry
// ---------------------------------------------------------------------------

async function handlePatCommand(interaction) {
  const modal = new ModalBuilder()
    .setCustomId('pat_modal')
    .setTitle('Register GitHub PAT');

  const patInput = new TextInputBuilder()
    .setCustomId('pat_input')
    .setLabel('GitHub Personal Access Token')
    .setPlaceholder('ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMinLength(4)
    .setMaxLength(256);

  const row = new ActionRowBuilder().addComponents(patInput);
  modal.addComponents(row);

  await interaction.showModal(modal);
}

// ---------------------------------------------------------------------------
// Modal submit handler for /pat
// ---------------------------------------------------------------------------

async function handlePatModalSubmit(interaction, deps) {
  const pat = interaction.fields.getTextInputValue('pat_input').trim();

  // Basic validation — accept ghp_, ghs_, github_pat_ prefixes
  if (!/^(gh[ps]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)$/.test(pat)) {
    return interaction.reply({
      ephemeral: true,
      embeds: [new EmbedBuilder()
        .setColor(COLORS.ERROR)
        .setTitle('Invalid Token')
        .setDescription(
          'That doesn\'t look like a GitHub PAT.\n' +
          'Tokens should start with `ghp_`, `ghs_`, or `github_pat_`.'
        )
      ]
    });
  }

  try {
    deps.storeToken(interaction.user.id, pat);
    return interaction.reply({
      ephemeral: true,
      embeds: [new EmbedBuilder()
        .setColor(COLORS.SUCCESS)
        .setTitle('GitHub PAT Stored')
        .setDescription(
          'Your token has been encrypted and stored securely.\n' +
          'You can now use GitHub features like `/codereview` and issue fixing.\n\n' +
          'Use `/codestatus` to check your registration, or DM the bot `remove pat` to delete it.'
        )
      ]
    });
  } catch (err) {
    return interaction.reply({
      ephemeral: true,
      embeds: [new EmbedBuilder()
        .setColor(COLORS.ERROR)
        .setTitle('Storage Failed')
        .setDescription(`Could not store your token: ${err.message}`)
      ]
    });
  }
}

// ---------------------------------------------------------------------------
// /status — ephemeral registration status
// ---------------------------------------------------------------------------

async function handleStatusCommand(interaction, deps) {
  const hasPat = deps.hasToken(interaction.user.id);
  return interaction.reply({
    ephemeral: true,
    embeds: [new EmbedBuilder()
      .setColor(COLORS.INFO)
      .setTitle('Your Status')
      .setDescription(
        `**User:** ${interaction.user.username}\n` +
        `**GitHub PAT:** ${hasPat ? '\u2705 Registered' : '\u274C Not registered'}\n` +
        `**Tip:** ${hasPat
          ? 'You\'re all set! Use `/codereview` or mention me by name to work with GitHub.'
          : 'Use `/codepat` to securely register your GitHub Personal Access Token.'
        }`
      )
    ]
  });
}

// ---------------------------------------------------------------------------
// /codereview — review a pull request (enhanced with focus/depth options)
// ---------------------------------------------------------------------------

async function handleReviewCommand(interaction, deps) {
  const url = interaction.options.getString('pr_url');
  const focus = interaction.options.getString('focus');
  const depth = interaction.options.getString('depth');

  let parsed;
  try {
    parsed = parseGitHubUrl(url);
  } catch (err) {
    return interaction.reply({ ephemeral: true, content: err.message });
  }

  // Validate that the URL points to a PR, not an issue
  if (parsed.type !== 'pull') {
    return interaction.reply({
      ephemeral: true,
      content: 'The `/codereview` command expects a GitHub **pull request** URL (`.../pull/456`), not an issue URL.'
    });
  }

  await interaction.deferReply();

  const { owner, repo, number } = parsed;

  // Build enhanced prompt with optional focus and depth
  let prompt = depth
    ? `Provide a ${depth} review of pull request ${owner}/${repo}#${number}.`
    : `Review pull request ${owner}/${repo}#${number}. Fetch the PR diff and provide a thorough code review.`;

  if (focus) {
    prompt += ` Focus on: ${focus}.`;
  }

  try {
    // handleClaudeRequest now uses ResponseStream — sends everything via the stream
    await deps.handleClaudeRequest(interaction, prompt);
    // ResponseStream handles all output — nothing more to send
  } catch (err) {
    await safeEditReply(interaction, {
      embeds: [new EmbedBuilder()
        .setColor(COLORS.ERROR)
        .setTitle('Error')
        .setDescription(`Failed to review PR: ${err.message}`)
      ]
    });
  }
}

// ---------------------------------------------------------------------------
// /codefix — fix a GitHub issue and create a PR
// ---------------------------------------------------------------------------

async function handleFixCommand(interaction, deps) {
  const url = interaction.options.getString('issue_url');
  const approach = interaction.options.getString('approach');

  let parsed;
  try {
    parsed = parseGitHubUrl(url);
  } catch (err) {
    return interaction.reply({ ephemeral: true, content: err.message });
  }

  // Validate that the URL points to an issue, not a PR
  if (parsed.type !== 'issues') {
    return interaction.reply({
      ephemeral: true,
      content: 'The `/codefix` command expects a GitHub **issue** URL (`.../issues/123`), not a PR URL. Use `/codereview` for PRs.'
    });
  }

  await interaction.deferReply();

  const { owner, repo, number } = parsed;
  let prompt = `Fix issue ${owner}/${repo}#${number}. ` +
    `Clone the repository, analyze the issue, implement a fix, and create a pull request.`;

  if (approach) {
    prompt += ` Approach: ${approach}`;
  }

  try {
    await deps.handleClaudeRequest(interaction, prompt);
  } catch (err) {
    await safeEditReply(interaction, {
      embeds: [new EmbedBuilder()
        .setColor(COLORS.ERROR)
        .setTitle('Error')
        .setDescription(`Failed to fix issue: ${err.message}`)
      ]
    });
  }
}

// ---------------------------------------------------------------------------
// /ask — ask Claude anything (with optional repo context)
// ---------------------------------------------------------------------------

async function handleAskCommand(interaction, deps) {
  const question = interaction.options.getString('question');
  const repo = interaction.options.getString('repo');
  const config = require('./utils/config');

  await interaction.deferReply();

  try {
    // Haiku-first: try cheap/fast answer before Sonnet
    if (config.haikuFirstEnabled && deps.tryHaikuAnswer && deps.shouldSkipHaiku && !deps.shouldSkipHaiku(question)) {
      const result = await deps.tryHaikuAnswer(question, interaction.user.id);
      if (result.answered) {
        const answer = deps.suppressLinkEmbeds
          ? deps.suppressLinkEmbeds(result.text)
          : result.text;
        const footer = '\n\n-# Answered by Haiku (fast mode)';
        const chunks = deps.splitMessage(answer + footer);
        await interaction.editReply(chunks[0]);
        for (let i = 1; i < chunks.length; i++) {
          await interaction.followUp(chunks[i]);
        }
        return;
      }
      // Haiku couldn't answer — fall through to Sonnet
    }

    // Build prompt with optional repo context
    const prompt = repo
      ? `[Context: repository ${repo}]\n\n${question}`
      : question;

    await deps.handleClaudeRequest(interaction, prompt);
    // ResponseStream handles all output
  } catch (err) {
    await safeEditReply(interaction, {
      embeds: [new EmbedBuilder()
        .setColor(COLORS.ERROR)
        .setTitle('Error')
        .setDescription(`Something went wrong: ${err.message}`)
      ]
    });
  }
}

// ---------------------------------------------------------------------------
// /codehelp — show all commands and capabilities
// ---------------------------------------------------------------------------

async function handleHelpCommand(interaction, deps) {
  const hasPat = deps.hasToken(interaction.user.id);
  return interaction.reply({
    ephemeral: true,
    embeds: [new EmbedBuilder()
      .setColor(COLORS.INFO)
      .setTitle('CodeBot \u2014 Team Coding Assistant')
      .setDescription(
        `**Slash Commands:**\n` +
        `\u2022 \`/codereview\` \u2014 Review a PR (with focus & depth options)\n` +
        `\u2022 \`/codefix\` \u2014 Fix a GitHub issue and create a PR\n` +
        `\u2022 \`/codeask\` \u2014 Ask Claude anything (with optional repo context)\n` +
        `\u2022 \`/codepat\` \u2014 Register your GitHub PAT securely\n` +
        `\u2022 \`/codestatus\` \u2014 Check your registration status\n\n` +
        `**Context Menus (right-click a message):**\n` +
        `\u2022 Debug This \u2014 Debug an error in a message\n` +
        `\u2022 Explain This \u2014 Explain code or a message\n` +
        `\u2022 Review PR \u2014 Review a PR linked in a message\n\n` +
        `**In Chat:**\n` +
        `\u2022 Mention me by name or @mention to start\n` +
        `\u2022 Say "chat" to start a conversation thread\n` +
        `\u2022 Say "close" or "exit" to end a thread\n\n` +
        `**Post-Response Buttons:**\n` +
        `\u2022 Follow Up \u2014 Ask a follow-up question\n` +
        `\u2022 Close Thread \u2014 End the conversation\n` +
        `\u2022 Approve/Request Changes \u2014 After PR reviews\n` +
        `\u2022 Stop \u2014 Cancel a running request\n\n` +
        `**GitHub PAT:** ${hasPat ? '\u2705 Registered' : '\u274C Not registered \u2014 use `/codepat` or DM me your token to enable GitHub features.'}`
      )
    ]
  });
}

// ---------------------------------------------------------------------------
// Utility: safely edit a deferred reply (won't throw if interaction expired)
// ---------------------------------------------------------------------------

async function safeEditReply(interaction, payload) {
  try {
    await interaction.editReply(payload);
  } catch (err) {
    console.error('Failed to edit interaction reply:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  commands: allCommands,
  registerCommands,
  handleInteraction,
  parseGitHubUrl
};

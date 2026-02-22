const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  EmbedBuilder,
  ComponentType
} = require('discord.js');
const { getToken } = require('./utils/token-store');
const { isChatThread, closeThread } = require('./utils/chat-threads');

const COLORS = {
  SUCCESS: 0x2ecc71,
  ERROR: 0xe74c3c,
  INFO: 0x5865f2,
  WARNING: 0xfee75c
};

// Button collector timeout (5 minutes)
const BUTTON_TIMEOUT_MS = 5 * 60 * 1000;

// ============================================================
//  Button row builders
// ============================================================

/**
 * Build post-response buttons for a chat thread.
 * @returns {ActionRowBuilder}
 */
function buildThreadButtons() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('followup_btn')
      .setLabel('Follow Up')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('close_thread_btn')
      .setLabel('Close Thread')
      .setStyle(ButtonStyle.Danger)
  );
}

/**
 * Build post-response buttons for a PR review context.
 * @param {{ owner: string, repo: string, number: number }} prContext
 * @returns {ActionRowBuilder}
 */
function buildPRReviewButtons(prContext) {
  const { owner, repo, number } = prContext;
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`approve_pr_${owner}_${repo}_${number}`)
      .setLabel('Approve PR')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`reqchanges_pr_${owner}_${repo}_${number}`)
      .setLabel('Request Changes')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId('followup_btn')
      .setLabel('Follow Up')
      .setStyle(ButtonStyle.Primary)
  );
}

/**
 * Build a disabled copy of the action row (greys out all buttons).
 * @param {ActionRowBuilder} row
 * @returns {ActionRowBuilder}
 */
function disableRow(row) {
  return new ActionRowBuilder().addComponents(
    row.components.map(btn =>
      ButtonBuilder.from(btn).setDisabled(true)
    )
  );
}

/**
 * Attach post-response buttons to a message and set up a collector with timeout.
 * @param {import('discord.js').Message} message
 * @param {ActionRowBuilder} row
 */
async function attachButtonsWithTimeout(message, row) {
  try {
    await message.edit({ components: [row] });

    // Set up timeout collector to disable buttons after 5 minutes
    const collector = message.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: BUTTON_TIMEOUT_MS,
      max: 0 // We handle clicks in interactionCreate, this is just for timeout
    });

    collector.on('end', async () => {
      try {
        // Re-fetch message to check if it still has active components
        const fresh = await message.fetch().catch(() => null);
        if (fresh && fresh.components.length > 0) {
          const disabledRow = disableRow(row);
          await fresh.edit({ components: [disabledRow] });
        }
      } catch (_) {}
    });
  } catch (err) {
    console.error('[interaction-handler] Failed to attach buttons:', err.message);
  }
}

// ============================================================
//  Button click handlers
// ============================================================

/**
 * Handle all button and select menu interactions.
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {object} deps — { handleClaudeRequest, client }
 */
async function handleComponentInteraction(interaction, deps) {
  const customId = interaction.customId;

  // ── Follow Up button ─────────────────────────────────────────
  if (customId === 'followup_btn') {
    const modal = new ModalBuilder()
      .setCustomId(`followup_modal_${interaction.channel.id}`)
      .setTitle('Follow Up');

    const input = new TextInputBuilder()
      .setCustomId('followup_input')
      .setLabel('What would you like to ask?')
      .setStyle(TextInputStyle.Paragraph)
      .setPlaceholder('Ask a follow-up question...')
      .setRequired(true)
      .setMaxLength(2000);

    modal.addComponents(new ActionRowBuilder().addComponents(input));
    return interaction.showModal(modal);
  }

  // ── Close Thread button ──────────────────────────────────────
  if (customId === 'close_thread_btn') {
    if (!isChatThread(interaction.channel.id)) {
      return interaction.reply({
        ephemeral: true,
        content: 'This is not an active chat thread.'
      });
    }

    await interaction.deferUpdate();
    await closeThread(interaction.channel.id, deps.client, 'user');
    return;
  }

  // ── Approve PR button ────────────────────────────────────────
  if (customId.startsWith('approve_pr_')) {
    const prInfo = parsePRCustomId(customId, 'approve_pr_');
    if (!prInfo) return interaction.reply({ ephemeral: true, content: 'Invalid PR reference.' });

    const token = getToken(interaction.user.id);
    if (!token) {
      return interaction.reply({
        ephemeral: true,
        content: 'Register your GitHub PAT with `/codepat` first.'
      });
    }

    await interaction.deferReply({ ephemeral: true });

    try {
      const { Octokit } = require('@octokit/rest');
      const octokit = new Octokit({ auth: token });
      await octokit.pulls.createReview({
        owner: prInfo.owner,
        repo: prInfo.repo,
        pull_number: prInfo.number,
        event: 'APPROVE'
      });

      return interaction.editReply({
        embeds: [new EmbedBuilder()
          .setColor(COLORS.SUCCESS)
          .setDescription(`Approved PR #${prInfo.number} on ${prInfo.owner}/${prInfo.repo}.`)
        ]
      });
    } catch (err) {
      return interaction.editReply({
        embeds: [new EmbedBuilder()
          .setColor(COLORS.ERROR)
          .setDescription(`Failed to approve PR: ${err.message}`)
        ]
      });
    }
  }

  // ── Request Changes button ───────────────────────────────────
  if (customId.startsWith('reqchanges_pr_')) {
    const prInfo = parsePRCustomId(customId, 'reqchanges_pr_');
    if (!prInfo) return interaction.reply({ ephemeral: true, content: 'Invalid PR reference.' });

    const token = getToken(interaction.user.id);
    if (!token) {
      return interaction.reply({
        ephemeral: true,
        content: 'Register your GitHub PAT with `/codepat` first.'
      });
    }

    const modal = new ModalBuilder()
      .setCustomId(`reqchanges_modal_${prInfo.owner}_${prInfo.repo}_${prInfo.number}`)
      .setTitle('Request Changes');

    const input = new TextInputBuilder()
      .setCustomId('reqchanges_body')
      .setLabel('What changes are needed?')
      .setStyle(TextInputStyle.Paragraph)
      .setPlaceholder('Describe the changes you want...')
      .setRequired(true)
      .setMaxLength(2000);

    modal.addComponents(new ActionRowBuilder().addComponents(input));
    return interaction.showModal(modal);
  }

  // ── Stop button is handled by ResponseStream collector ───────
  if (customId === 'stop_request') {
    // Already handled by the ResponseStream onStop collector.
    // If we reach here, the collector already expired — acknowledge gracefully.
    return interaction.deferUpdate().catch(() => {});
  }
}

/**
 * Handle follow-up modal submission.
 * @param {import('discord.js').ModalSubmitInteraction} interaction
 * @param {object} deps
 */
async function handleFollowUpModal(interaction, deps) {
  const question = interaction.fields.getTextInputValue('followup_input').trim();
  if (!question) {
    return interaction.reply({ ephemeral: true, content: 'Please enter a question.' });
  }

  await interaction.deferReply();

  try {
    await deps.handleClaudeRequest(interaction, question, { source: 'followup_button' });
  } catch (err) {
    try {
      const reply = interaction.replied || interaction.deferred
        ? interaction.editReply.bind(interaction)
        : interaction.reply.bind(interaction);
      await reply({
        embeds: [new EmbedBuilder()
          .setColor(COLORS.ERROR)
          .setDescription(`Error: ${err.message}`)
        ]
      });
    } catch (_) {}
  }
}

/**
 * Handle request-changes modal submission.
 * @param {import('discord.js').ModalSubmitInteraction} interaction
 */
async function handleReqChangesModal(interaction) {
  const body = interaction.fields.getTextInputValue('reqchanges_body').trim();
  if (!body) {
    return interaction.reply({ ephemeral: true, content: 'Please describe the changes needed.' });
  }

  // Parse PR info from modal customId: reqchanges_modal_{owner}_{repo}_{number}
  const parts = interaction.customId.replace('reqchanges_modal_', '').split('_');
  if (parts.length < 3) {
    return interaction.reply({ ephemeral: true, content: 'Invalid PR reference.' });
  }

  const number = parseInt(parts.pop(), 10);
  const repo = parts.pop();
  const owner = parts.join('_'); // owner may contain underscores

  const token = getToken(interaction.user.id);
  if (!token) {
    return interaction.reply({
      ephemeral: true,
      content: 'Register your GitHub PAT with `/codepat` first.'
    });
  }

  await interaction.deferReply({ ephemeral: true });

  try {
    const { Octokit } = require('@octokit/rest');
    const octokit = new Octokit({ auth: token });
    await octokit.pulls.createReview({
      owner,
      repo,
      pull_number: number,
      event: 'REQUEST_CHANGES',
      body
    });

    return interaction.editReply({
      embeds: [new EmbedBuilder()
        .setColor(COLORS.SUCCESS)
        .setDescription(`Requested changes on PR #${number} on ${owner}/${repo}.`)
      ]
    });
  } catch (err) {
    return interaction.editReply({
      embeds: [new EmbedBuilder()
        .setColor(COLORS.ERROR)
        .setDescription(`Failed to request changes: ${err.message}`)
      ]
    });
  }
}

/**
 * Handle context menu (right-click message) interactions.
 * @param {import('discord.js').MessageContextMenuCommandInteraction} interaction
 * @param {object} deps
 */
async function handleContextMenu(interaction, deps) {
  const { commandName, targetMessage } = interaction;
  const content = targetMessage.content?.trim();

  if (!content) {
    return interaction.reply({
      ephemeral: true,
      content: 'That message has no text content to analyze.'
    });
  }

  await interaction.deferReply();

  let prompt;
  switch (commandName) {
    case 'Debug This':
      prompt = `Debug this error or issue:\n\n${content}`;
      break;
    case 'Explain This':
      prompt = `Explain this code or message:\n\n${content}`;
      break;
    case 'Review PR': {
      const prMatch = content.match(/github\.com\/[^/]+\/[^/]+\/pull\/\d+/);
      if (!prMatch) {
        return interaction.editReply({
          embeds: [new EmbedBuilder()
            .setColor(COLORS.WARNING)
            .setDescription('No GitHub PR URL found in that message.')
          ]
        });
      }
      prompt = `Review this pull request: https://${prMatch[0]}`;
      break;
    }
    default:
      return interaction.editReply({ content: 'Unknown context menu command.' });
  }

  try {
    await deps.handleClaudeRequest(interaction, prompt, { source: 'context_menu' });
  } catch (err) {
    try {
      await interaction.editReply({
        embeds: [new EmbedBuilder()
          .setColor(COLORS.ERROR)
          .setDescription(`Error: ${err.message}`)
        ]
      });
    } catch (_) {}
  }
}

// ============================================================
//  Helpers
// ============================================================

/**
 * Parse a PR custom ID like "approve_pr_owner_repo_42" into { owner, repo, number }.
 * Handles owners/repos that may contain underscores by treating the last segment as number
 * and the second-to-last as repo.
 */
function parsePRCustomId(customId, prefix) {
  const remainder = customId.replace(prefix, '');
  const parts = remainder.split('_');
  if (parts.length < 3) return null;

  const number = parseInt(parts.pop(), 10);
  if (isNaN(number)) return null;

  const repo = parts.pop();
  const owner = parts.join('_');
  if (!owner || !repo) return null;

  return { owner, repo, number };
}

module.exports = {
  buildThreadButtons,
  buildPRReviewButtons,
  disableRow,
  attachButtonsWithTimeout,
  handleComponentInteraction,
  handleFollowUpModal,
  handleReqChangesModal,
  handleContextMenu
};

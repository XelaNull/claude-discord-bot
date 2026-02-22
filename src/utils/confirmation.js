const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ComponentType
} = require('discord.js');

const COLORS = {
  PENDING: 0xfee75c,
  APPROVED: 0x2ecc71,
  REJECTED: 0xe74c3c,
  EXPIRED: 0x95a5a6
};

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
 * Send an interactive confirmation prompt and wait for the target user's response.
 *
 * @param {import('discord.js').TextBasedChannel} channel - Channel to post in.
 * @param {string} userId - Only this user may interact with the buttons.
 * @param {string} description - What operation requires confirmation.
 * @param {object} [options]
 * @param {number} [options.timeout=30000] - Milliseconds before the prompt expires.
 * @returns {Promise<boolean>} `true` if approved, `false` if rejected or timed out.
 */
async function requestConfirmation(channel, userId, description, options = {}) {
  const timeout = options.timeout || 30000;

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('confirm_yes')
      .setLabel('Approve')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId('confirm_no')
      .setLabel('Reject')
      .setStyle(ButtonStyle.Danger)
  );

  const embed = new EmbedBuilder()
    .setColor(COLORS.PENDING)
    .setTitle('Confirmation Required')
    .setDescription(description)
    .setFooter({ text: `Only <@${userId}> can respond. Expires in ${timeout / 1000}s.` })
    .setTimestamp();

  const msg = await channel.send({ embeds: [embed], components: [row] });

  try {
    const interaction = await msg.awaitMessageComponent({
      componentType: ComponentType.Button,
      filter: i => i.user.id === userId,
      time: timeout
    });

    const approved = interaction.customId === 'confirm_yes';
    const disabledRow = disableRow(row);

    const resultEmbed = new EmbedBuilder()
      .setColor(approved ? COLORS.APPROVED : COLORS.REJECTED)
      .setTitle(approved ? 'Approved' : 'Rejected')
      .setDescription(description)
      .setFooter({ text: `${approved ? 'Approved' : 'Rejected'} by ${interaction.user.tag}` })
      .setTimestamp();

    await interaction.update({ embeds: [resultEmbed], components: [disabledRow] });
    return approved;
  } catch (_) {
    // Timeout — no interaction received in time.
    const disabledRow = disableRow(row);

    const expiredEmbed = new EmbedBuilder()
      .setColor(COLORS.EXPIRED)
      .setTitle('Confirmation Expired')
      .setDescription(description)
      .setFooter({ text: `No response within ${timeout / 1000}s. Defaulting to reject.` })
      .setTimestamp();

    try {
      await msg.edit({ embeds: [expiredEmbed], components: [disabledRow] });
    } catch (_editErr) {
      // Message may have been deleted; nothing we can do.
    }

    return false;
  }
}

module.exports = { requestConfirmation };

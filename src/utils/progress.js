const { EmbedBuilder } = require('discord.js');

const STATUS_ICONS = {
  pending: '⬜',
  in_progress: '🔄',
  completed: '✅',
  failed: '❌'
};

const COLORS = {
  IN_PROGRESS: 0x5865f2,
  COMPLETE: 0x2ecc71,
  FAILED: 0xe74c3c
};

class ProgressTracker {
  constructor(message, title, steps) {
    this.message = message;
    this.title = title;
    this.steps = steps.map(s => ({ text: s, status: 'pending' }));
    this._updateTimeout = null;
    this._finished = false;
  }

  /**
   * Build the embed reflecting current step states.
   * @param {object} [overrides] - Optional color/footer/description overrides for final states.
   */
  _buildEmbed(overrides = {}) {
    const stepLines = this.steps.map(s => `${STATUS_ICONS[s.status]} ${s.text}`);

    const embed = new EmbedBuilder()
      .setColor(overrides.color ?? COLORS.IN_PROGRESS)
      .setTitle(this.title)
      .setDescription(stepLines.join('\n'));

    if (overrides.footer) {
      embed.setFooter({ text: overrides.footer });
    }

    if (overrides.extraField) {
      embed.addFields(overrides.extraField);
    }

    embed.setTimestamp();
    return embed;
  }

  /**
   * Schedule a batched Discord message edit (rate-limit protection).
   * Multiple calls within 1 second collapse into a single edit.
   */
  _scheduleUpdate(overrides) {
    // If the tracker is already finished, flush immediately — don't debounce final states.
    if (this._finished) {
      return this._flush(overrides);
    }

    // Store the latest overrides so the eventual flush uses them.
    this._pendingOverrides = overrides;

    if (!this._updateTimeout) {
      this._updateTimeout = setTimeout(() => this._flush(this._pendingOverrides), 1000);
    }
  }

  async _flush(overrides) {
    clearTimeout(this._updateTimeout);
    this._updateTimeout = null;
    this._pendingOverrides = null;

    try {
      const embed = this._buildEmbed(overrides);
      await this.message.edit({ embeds: [embed] });
    } catch (err) {
      console.error('Progress embed update failed:', err.message);
    }
  }

  /**
   * Update a single step's status.
   * @param {number} index - Zero-based step index.
   * @param {'pending'|'in_progress'|'completed'|'failed'} status
   */
  updateStep(index, status) {
    if (index < 0 || index >= this.steps.length) return;
    this.steps[index].status = status;
    this._scheduleUpdate();
  }

  /**
   * Mark every step as completed and display a final summary.
   * @param {string} summary - Final text shown in an embed field.
   */
  async complete(summary) {
    this._finished = true;
    this.steps.forEach(s => { s.status = 'completed'; });

    const overrides = {
      color: COLORS.COMPLETE,
      footer: 'Completed'
    };

    if (summary) {
      overrides.extraField = { name: 'Summary', value: summary, inline: false };
    }

    await this._scheduleUpdate(overrides);
  }

  /**
   * Mark the current (first non-completed) step as failed and show an error.
   * @param {string} error - Error description.
   */
  async fail(error) {
    this._finished = true;

    // Mark the first in_progress or pending step as failed.
    const active = this.steps.find(s => s.status === 'in_progress' || s.status === 'pending');
    if (active) active.status = 'failed';

    const overrides = {
      color: COLORS.FAILED,
      footer: 'Failed'
    };

    if (error) {
      overrides.extraField = { name: 'Error', value: error, inline: false };
    }

    await this._scheduleUpdate(overrides);
  }
}

/**
 * Create a progress tracker embed in the given channel.
 * @param {import('discord.js').TextBasedChannel} channel
 * @param {string} title - Embed title.
 * @param {string[]} steps - Array of step descriptions.
 * @returns {Promise<ProgressTracker>}
 */
async function createProgress(channel, title, steps) {
  const tracker = new ProgressTracker(null, title, steps);
  const embed = tracker._buildEmbed();
  const message = await channel.send({ embeds: [embed] });
  tracker.message = message;
  return tracker;
}

module.exports = { createProgress, ProgressTracker };

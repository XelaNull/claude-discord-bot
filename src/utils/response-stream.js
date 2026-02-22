const { ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } = require('discord.js');

const MAX_MSG_LENGTH = 1900;
const EDIT_DEBOUNCE_MS = 1500;

/**
 * Edit-in-place response accumulator.
 * Sends ONE initial message and edits it progressively as Claude produces output.
 * Follows the debounced-edit pattern from progress.js.
 */
class ResponseStream {
  /**
   * @param {import('discord.js').TextBasedChannel} channel
   * @param {object} [opts]
   * @param {import('discord.js').ChatInputCommandInteraction} [opts.interaction] — slash command interaction
   * @param {boolean} [opts.suppressEmbeds]
   */
  constructor(channel, opts = {}) {
    this._channel = channel;
    this._interaction = opts.interaction || null;
    this._interactionReplied = false;
    this._message = null;            // current Discord message being edited
    this._messages = [];             // all messages sent (for overflow)
    this._buffer = '';               // accumulated text content
    this._toolStatus = '';           // current "Running tool_name..." line
    this._updateTimer = null;
    this._finalized = false;
    this._stopCallback = null;
    this._stopCollector = null;
    this._deleted = false;
  }

  /**
   * Send the initial "Thinking..." message with a Stop button.
   * @param {string} initialText
   */
  async init(initialText) {
    const stopRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('stop_request')
        .setLabel('Stop')
        .setEmoji('\u23F9')
        .setStyle(ButtonStyle.Danger)
    );

    try {
      if (this._interaction) {
        await this._interaction.editReply({ content: initialText, components: [stopRow] });
        this._message = await this._interaction.fetchReply();
        this._interactionReplied = true;
      } else {
        this._message = await this._channel.send({ content: initialText, components: [stopRow] });
      }
      this._messages.push(this._message);
    } catch (err) {
      console.error('[response-stream] Failed to send initial message:', err.message);
      // Fallback: try sending without components
      try {
        if (this._interaction) {
          await this._interaction.editReply({ content: initialText });
          this._message = await this._interaction.fetchReply();
          this._interactionReplied = true;
        } else {
          this._message = await this._channel.send(initialText);
        }
        this._messages.push(this._message);
      } catch (_) {}
    }

    this._buffer = initialText;
  }

  /**
   * Register a stop callback. Sets up a component collector on the initial message.
   * @param {Function} callback — called when user clicks Stop
   */
  onStop(callback) {
    this._stopCallback = callback;
    if (!this._message) return;

    try {
      this._stopCollector = this._message.createMessageComponentCollector({
        componentType: ComponentType.Button,
        filter: i => i.customId === 'stop_request',
        max: 1,
        time: 5 * 60 * 1000 // 5 minute timeout
      });

      this._stopCollector.on('collect', async (interaction) => {
        try {
          await interaction.deferUpdate();
          if (this._stopCallback) this._stopCallback();
        } catch (_) {}
      });
    } catch (_) {}
  }

  /**
   * Append text to the response. Schedules a debounced edit.
   * @param {string} text
   */
  async append(text) {
    if (this._finalized || this._deleted) return;
    this._buffer = text;
    this._scheduleUpdate();
  }

  /**
   * Show a "Running tool_name..." status line during tool execution.
   * @param {string} toolName
   */
  async setToolStatus(toolName) {
    if (this._finalized || this._deleted) return;
    this._toolStatus = `\n\n\u2699\uFE0F Running \`${toolName}\`...`;
    this._scheduleUpdate();
  }

  /**
   * Clear tool status (called between tool executions).
   */
  clearToolStatus() {
    this._toolStatus = '';
  }

  /**
   * Final edit — remove thinking indicator, add footer, remove Stop button.
   * @param {string} [footerText]
   */
  async finalize(footerText) {
    this._finalized = true;
    this._toolStatus = '';

    if (this._updateTimer) {
      clearTimeout(this._updateTimer);
      this._updateTimer = null;
    }

    if (this._stopCollector) {
      try { this._stopCollector.stop(); } catch (_) {}
      this._stopCollector = null;
    }

    const finalContent = this._buffer + (footerText || '');
    await this._editMessage(finalContent, []);
  }

  /**
   * Return the current (last) Discord message object — for attaching buttons.
   * @returns {import('discord.js').Message|null}
   */
  getMessage() {
    return this._message;
  }

  // ── Internal methods ─────────────────────────────────────────────

  _scheduleUpdate() {
    if (this._finalized) return;

    if (!this._updateTimer) {
      this._updateTimer = setTimeout(() => {
        this._updateTimer = null;
        this._flush();
      }, EDIT_DEBOUNCE_MS);
    }
  }

  async _flush() {
    if (this._deleted) return;

    const displayText = this._buffer + this._toolStatus + ' ...';
    await this._editMessage(displayText);
  }

  /**
   * Edit the current message. Handles overflow by freezing the current
   * message and starting a new one.
   * @param {string} content
   * @param {Array} [components] — if provided, overrides the message components
   */
  async _editMessage(content, components) {
    if (!this._message) return;

    // Overflow: if content exceeds limit, freeze current and start new message
    if (content.length > MAX_MSG_LENGTH) {
      // Freeze current message with the buffer content (truncated if needed)
      const freezeContent = this._buffer.substring(0, MAX_MSG_LENGTH);
      try {
        await this._message.edit({ content: freezeContent, components: [] });
      } catch (_) {}

      // Start a new message for the overflow
      try {
        const overflowContent = content.substring(0, MAX_MSG_LENGTH);
        if (this._interaction) {
          this._message = await this._interaction.followUp({ content: overflowContent });
        } else {
          this._message = await this._channel.send(overflowContent);
        }
        this._messages.push(this._message);
        return;
      } catch (err) {
        console.error('[response-stream] Overflow message failed:', err.message);
        return;
      }
    }

    const editPayload = { content };
    if (components !== undefined) {
      editPayload.components = components;
    }

    try {
      if (this._interaction && !this._finalized) {
        await this._interaction.editReply(editPayload);
      } else if (this._message) {
        await this._message.edit(editPayload);
      }
    } catch (err) {
      // Message was deleted or interaction expired — create a new message
      if (err.code === 10008 || err.code === 10062) {
        this._deleted = true;
        try {
          this._message = await this._channel.send({ content });
          this._messages.push(this._message);
          this._deleted = false;
        } catch (_) {
          console.error('[response-stream] Failed to recover after deleted message');
        }
      } else {
        console.error('[response-stream] Edit failed:', err.message);
      }
    }
  }
}

module.exports = { ResponseStream };

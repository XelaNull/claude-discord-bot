import { config } from './config.js';

/**
 * Manages per-channel conversation history for Claude API context.
 * Automatically trims old messages to stay within token budget.
 */
class ConversationManager {
  constructor() {
    // Map<channelId, Message[]>
    this.histories = new Map();
  }

  /**
   * Get conversation history for a channel.
   */
  getHistory(channelId) {
    return this.histories.get(channelId) || [];
  }

  /**
   * Add a user message to channel history.
   */
  addUserMessage(channelId, content, username) {
    this._ensure(channelId);
    const history = this.histories.get(channelId);
    history.push({
      role: 'user',
      content: `[${username}]: ${content}`,
    });
    this._trim(channelId);
  }

  /**
   * Add an assistant message to channel history.
   */
  addAssistantMessage(channelId, content) {
    this._ensure(channelId);
    const history = this.histories.get(channelId);
    history.push({
      role: 'assistant',
      content,
    });
    this._trim(channelId);
  }

  /**
   * Add a full tool-use exchange to history.
   * This stores the assistant's tool_use block and the tool result.
   */
  addToolExchange(channelId, assistantMessage, toolResults) {
    this._ensure(channelId);
    const history = this.histories.get(channelId);

    // Store the full assistant response (may include text + tool_use blocks)
    history.push({
      role: 'assistant',
      content: assistantMessage.content,
    });

    // Store tool results
    history.push({
      role: 'user',
      content: toolResults,
    });

    this._trim(channelId);
  }

  /**
   * Clear history for a channel.
   */
  clearHistory(channelId) {
    this.histories.delete(channelId);
  }

  /**
   * Clear all conversation histories.
   */
  clearAll() {
    this.histories.clear();
  }

  _ensure(channelId) {
    if (!this.histories.has(channelId)) {
      this.histories.set(channelId, []);
    }
  }

  _trim(channelId) {
    const history = this.histories.get(channelId);
    if (!history) return;

    // Keep only the last N messages
    while (history.length > config.maxHistoryMessages) {
      history.shift();
    }

    // Ensure the first message is always a 'user' role
    // (Claude API requires user message first)
    while (history.length > 0 && history[0].role !== 'user') {
      history.shift();
    }
  }
}

export const conversationManager = new ConversationManager();

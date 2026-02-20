import Anthropic from '@anthropic-ai/sdk';
import { config } from './utils/config.js';
import { allToolDefinitions, executeTool } from './tools/index.js';

const client = new Anthropic({ apiKey: config.anthropicApiKey });

/**
 * Run Claude with the tool-use loop.
 * Keeps calling Claude until it returns a text-only response (no more tool calls).
 *
 * @param {Array} messages - Conversation history in Claude API format
 * @param {object} context - Execution context passed to tools { discordUserId }
 * @param {Function} onToolUse - Callback when a tool is being used (for status updates)
 * @param {Function} onText - Callback for streaming text chunks (optional)
 * @returns {{ response: string, messages: Array, toolsUsed: string[] }}
 */
export async function runClaudeLoop(messages, context, onToolUse, onText) {
  let iterations = 0;
  const toolsUsed = [];

  while (iterations < config.maxToolIterations) {
    iterations++;

    const response = await client.messages.create({
      model: config.model,
      max_tokens: config.maxTokens,
      system: config.systemPrompt,
      tools: allToolDefinitions,
      messages,
    });

    // Extract text blocks and tool_use blocks
    const textBlocks = response.content.filter(b => b.type === 'text');
    const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');

    // If no tool calls, we're done — return the text
    if (toolUseBlocks.length === 0) {
      const finalText = textBlocks.map(b => b.text).join('\n');
      return { response: finalText, messages, toolsUsed };
    }

    // There are tool calls — execute them
    // First, add the assistant response to messages
    messages.push({ role: 'assistant', content: response.content });

    // Execute each tool and collect results
    const toolResults = [];
    for (const toolUse of toolUseBlocks) {
      toolsUsed.push(toolUse.name);

      if (onToolUse) {
        onToolUse(toolUse.name, toolUse.input);
      }

      let result;
      try {
        result = await executeTool(toolUse.name, toolUse.input, context);
      } catch (err) {
        result = { error: err.message };
      }

      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: JSON.stringify(result, null, 2).slice(0, 50000),
      });
    }

    // Add tool results as a user message
    messages.push({ role: 'user', content: toolResults });

    // If there was text alongside tool calls, emit it
    if (textBlocks.length > 0 && onText) {
      onText(textBlocks.map(b => b.text).join('\n'));
    }
  }

  // Hit max iterations
  return {
    response: '(Reached maximum tool iterations. Here is what I have so far — please rephrase if you need me to continue.)',
    messages,
    toolsUsed,
  };
}

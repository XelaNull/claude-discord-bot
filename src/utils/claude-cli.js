/**
 * Claude CLI Proxy — SDK-compatible wrapper around `claude -p`.
 *
 * Enables using Claude Max subscription for ALL API calls by routing through
 * the Claude Code CLI. Full tool support via text-based tool call protocol.
 *
 * The wrapper implements the same interface as the Anthropic Node SDK's
 * client.messages.create(), so callers don't need to know whether they're
 * talking to the API or the CLI.
 *
 * Adapted from ClaudeLife's claude_proxy.py:
 *   - claude -p --output-format json --no-session-persistence
 *   - Prompt piped via stdin (avoids OS arg length limits)
 *   - Text-based tool use with <tool_call> markers
 *   - SDK-compatible response objects
 *   - Timeout with retry on first failure
 */

const { spawn, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

// CLI call timeout — 5 minutes default
const CLI_TIMEOUT_MS = parseInt(process.env.CLAUDE_CLI_TIMEOUT_MS || '300000');

// Tool call markers — XML-like tags the model outputs to indicate tool use
const TOOL_CALL_OPEN = '<tool_call>';
const TOOL_CALL_CLOSE = '</tool_call>';
const TOOL_CALL_RE = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;

// Credential paths — Docker mounts read-only, so we copy to a writable dir
const CLAUDE_RO_MOUNT = '/root/.claude';
const CLAUDE_CONFIG_DIR = path.join(os.tmpdir(), '.codebot-claude-cli');

let _configReady = false;

function _prepareCredentials() {
  if (_configReady) return true;

  try {
    fs.mkdirSync(CLAUDE_CONFIG_DIR, { recursive: true });

    // Look for credentials in the read-only mount or home directory
    const candidates = [
      path.join(CLAUDE_RO_MOUNT, '.credentials.json'),
      path.join(os.homedir(), '.claude', '.credentials.json')
    ];

    for (const src of candidates) {
      if (fs.existsSync(src)) {
        const dest = path.join(CLAUDE_CONFIG_DIR, '.credentials.json');
        fs.copyFileSync(src, dest);

        // Also copy settings.json if it exists (CLI may need it)
        const settingsSrc = path.join(path.dirname(src), 'settings.json');
        if (fs.existsSync(settingsSrc)) {
          fs.copyFileSync(settingsSrc, path.join(CLAUDE_CONFIG_DIR, 'settings.json'));
        }

        _configReady = true;
        console.log(`[claude-cli] Credentials prepared from ${src}`);
        return true;
      }
    }

    console.warn('[claude-cli] No credentials found in mount or home directory');
    return false;
  } catch (err) {
    console.error(`[claude-cli] Credential prep failed: ${err.message}`);
    return false;
  }
}

// ===== CLI availability check =====

let _cliAvailable = null;

function isCliAvailable() {
  if (_cliAvailable !== null) return _cliAvailable;

  try {
    execFileSync('claude', ['--version'], {
      timeout: 10000,
      stdio: 'pipe',
      windowsHide: true
    });
    _cliAvailable = true;
  } catch {
    _cliAvailable = false;
  }

  return _cliAvailable;
}

// ===== Tool definitions → text instructions =====

function buildToolInstructions(tools) {
  if (!tools || tools.length === 0) return '';

  const lines = ['\n\n## Available Tools\n'];

  for (const tool of tools) {
    const name = tool.name || '';
    const desc = tool.description || '';
    const schema = tool.input_schema || {};
    const props = schema.properties || {};
    const required = schema.required || [];

    lines.push(`### ${name}`);
    lines.push(desc);

    if (Object.keys(props).length > 0) {
      lines.push('Parameters:');
      for (const [pname, pdef] of Object.entries(props)) {
        const req = required.includes(pname) ? ' **(required)**' : '';
        const ptype = pdef.type || 'string';
        const pdesc = pdef.description || '';
        lines.push(`  - \`${pname}\` (${ptype}${req}): ${pdesc}`);
      }
    }
    lines.push('');
  }

  lines.push('## How to Use Tools');
  lines.push(
    'When you need to use a tool, output a tool_call block with valid JSON inside:'
  );
  lines.push('');
  lines.push(TOOL_CALL_OPEN);
  lines.push('{"name": "tool_name", "input": {"param": "value"}}');
  lines.push(TOOL_CALL_CLOSE);
  lines.push('');
  lines.push(
    'You may output text before tool calls. You may call multiple tools in one ' +
    'response. After all tool_call blocks, STOP and wait for results. Tool ' +
    'results will appear in the next message.'
  );

  return lines.join('\n');
}

// ===== Parse tool calls from response =====

function parseToolCalls(text) {
  const toolCalls = [];
  const cleanParts = [];
  let lastEnd = 0;

  // Reset regex state
  TOOL_CALL_RE.lastIndex = 0;

  let match;
  while ((match = TOOL_CALL_RE.exec(text)) !== null) {
    cleanParts.push(text.slice(lastEnd, match.index));
    lastEnd = match.index + match[0].length;

    try {
      const callData = JSON.parse(match[1]);
      toolCalls.push({
        name: callData.name || '',
        id: `cli_tool_${toolCalls.length}`,
        input: callData.input || {}
      });
    } catch {
      // JSON parse failed — keep raw text
      cleanParts.push(match[0]);
    }
  }

  cleanParts.push(text.slice(lastEnd));
  const cleanText = cleanParts.join('').trim();

  return { cleanText, toolCalls };
}

// ===== Prompt building =====

function buildPrompt(system, messages, tools) {
  const parts = [];

  // System prompt
  if (system) {
    if (Array.isArray(system)) {
      for (const block of system) {
        if (typeof block === 'object' && block.type === 'text') {
          parts.push(block.text);
        } else if (typeof block === 'string') {
          parts.push(block);
        }
      }
    } else if (typeof system === 'string') {
      parts.push(system);
    }
    parts.push('');
  }

  // Tool definitions as text instructions
  if (tools && tools.length > 0) {
    parts.push(buildToolInstructions(tools));
    parts.push('');
  }

  // Message history
  for (const msg of messages) {
    const role = msg.role === 'user' ? 'Human' : 'Assistant';
    const content = msg.content;

    if (typeof content === 'string') {
      parts.push(`${role}: ${content}`);
    } else if (Array.isArray(content)) {
      const textParts = [];
      for (const block of content) {
        if (typeof block === 'object') {
          if (block.type === 'text') {
            textParts.push(block.text);
          } else if (block.type === 'tool_result') {
            const toolId = block.tool_use_id || '';
            const resultContent = block.content || '';
            textParts.push(`[Tool Result for ${toolId}]: ${resultContent}`);
          } else if (block.type === 'tool_use') {
            textParts.push(
              `[Tool Call: ${block.name || ''}(${JSON.stringify(block.input || {})})]`
            );
          }
        } else {
          textParts.push(String(block));
        }
      }
      if (textParts.length > 0) {
        parts.push(`${role}: ${textParts.join(' ')}`);
      }
    }
    parts.push('');
  }

  return parts.join('\n');
}

// ===== CLI execution =====

function callCliAsync(prompt, timeout = CLI_TIMEOUT_MS, isRetry = false) {
  return new Promise((resolve, reject) => {
    if (!_prepareCredentials()) {
      reject(new Error('Claude CLI credentials not available'));
      return;
    }

    const env = { ...process.env };
    // Strip API key so CLI uses Max subscription (OAuth credentials)
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    // Point CLI to writable config directory (credentials copied from read-only mount)
    env.CLAUDE_CONFIG_DIR = CLAUDE_CONFIG_DIR;

    const args = [
      '-p',
      '--output-format', 'json',
      '--no-session-persistence',
      '--tools', ''  // Disable CLI built-in tools; we use our own text-based protocol
    ];

    const promptKB = Math.round(prompt.length / 1024);
    console.log(`[claude-cli] Spawning CLI — prompt ~${promptKB}KB (${prompt.length} chars)`);

    const proc = spawn('claude', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      windowsHide: true
    });

    let stdout = '';
    let stderr = '';
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      proc.kill('SIGKILL');
    }, timeout);

    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });

    // Write prompt to stdin and close
    proc.stdin.write(prompt);
    proc.stdin.end();

    proc.on('close', (code) => {
      clearTimeout(timer);

      if (killed) {
        const promptKB = Math.round(prompt.length / 1024);
        if (!isRetry) {
          console.warn(
            `[claude-cli] Timed out after ${timeout}ms (prompt ~${promptKB}KB) — retrying once...`
          );
          callCliAsync(prompt, timeout, true).then(resolve, reject);
          return;
        }
        reject(new Error(
          `Claude CLI timed out after ${timeout}ms on retry (prompt ~${promptKB}KB)`
        ));
        return;
      }

      if (stderr.trim()) {
        console.warn(`[claude-cli] stderr: ${stderr.trim().substring(0, 500)}`);
      }

      if (code !== 0) {
        const error = stderr.trim() || 'Unknown CLI error';
        if (error.toLowerCase().includes('not authenticated')) {
          reject(new Error(
            "Claude CLI not authenticated. Run 'claude login' on host."
          ));
        } else {
          reject(new Error(`Claude CLI error (exit ${code}): ${error}`));
        }
        return;
      }

      // Parse JSON response
      let text = stdout.trim();
      let inputTokens = 0;
      let outputTokens = 0;

      try {
        const responseData = JSON.parse(stdout);
        text = responseData.result || text;
        inputTokens = responseData.input_tokens || 0;
        outputTokens = responseData.output_tokens || 0;
        const usage = responseData.usage || {};
        if (usage) {
          inputTokens = inputTokens || usage.input_tokens || 0;
          outputTokens = outputTokens || usage.output_tokens || 0;
        }
      } catch {
        // Fall back to raw text, 0/0 tokens
      }

      resolve({ text, inputTokens, outputTokens });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Claude CLI spawn error: ${err.message}`));
    });
  });
}

// ===== SDK-compatible response types =====

class CLIContentBlock {
  constructor(text) {
    this.type = 'text';
    this.text = text;
  }
}

class CLIToolUseBlock {
  constructor(id, name, input) {
    this.type = 'tool_use';
    this.id = id;
    this.name = name;
    this.input = input;
  }
}

class CLIUsage {
  constructor(inputTokens = 0, outputTokens = 0) {
    this.input_tokens = inputTokens;
    this.output_tokens = outputTokens;
  }
}

class CLIMessage {
  constructor(text, model = '', inputTokens = 0, outputTokens = 0, toolCalls = null) {
    this.content = [];
    if (text) {
      this.content.push(new CLIContentBlock(text));
    }
    if (toolCalls && toolCalls.length > 0) {
      for (const tc of toolCalls) {
        this.content.push(new CLIToolUseBlock(tc.id, tc.name, tc.input));
      }
    }
    this.stop_reason = (toolCalls && toolCalls.length > 0) ? 'tool_use' : 'end_turn';
    this.usage = new CLIUsage(inputTokens, outputTokens);
    this.model = model;
    this.id = 'cli_msg';
    this.type = 'message';
    this.role = 'assistant';
  }
}

function buildMessage(rawText, model, inputTokens, outputTokens, hasTools) {
  if (hasTools) {
    const { cleanText, toolCalls } = parseToolCalls(rawText);
    return new CLIMessage(
      cleanText, model, inputTokens, outputTokens,
      toolCalls.length > 0 ? toolCalls : null
    );
  }
  return new CLIMessage(rawText, model, inputTokens, outputTokens);
}

// ===== SDK-compatible client =====

class CLIMessages {
  async create({ model = '', max_tokens = 4096, messages = [], system = null, tools = null } = {}) {
    const hasTools = !!(tools && tools.length > 0);
    const prompt = buildPrompt(system, messages, tools);

    const { text, inputTokens, outputTokens } = await callCliAsync(prompt);

    console.log(
      `[claude-cli] ${model || 'cli'} — ${inputTokens} in / ${outputTokens} out` +
      (hasTools ? ` (${tools.length} tools)` : '')
    );

    return buildMessage(text, model, inputTokens, outputTokens, hasTools);
  }
}

class CLIClient {
  constructor() {
    this.messages = new CLIMessages();
  }
}

// ===== Exports =====

module.exports = {
  CLIClient,
  isCliAvailable,
  // Exposed for testing
  buildToolInstructions,
  parseToolCalls,
  buildPrompt
};

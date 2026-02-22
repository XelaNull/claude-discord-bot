// ============================================================
//  Log Analyzer — streaming parser for large log files
//  Zero tokens: all work is programmatic (readline + fingerprinting)
// ============================================================

const fs = require('fs');
const readline = require('readline');
const { createHash } = require('crypto');

// ── FS25-Specific Patterns ──────────────────────────────────

const PATTERNS = {
  timestamp:       /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\s+/,
  error:           /\bError:\s/i,
  warning:         /\bWarning(?:\s*\([^)]+\))?:\s/i,
  luaStackHeader:  /\bLUA call stack:/i,
  luaStackEntryA:  /^\s*=?([^\s(]+\.lua)\s*[:(]\s*(\d+)\s*[):]?\s*:?\s*(\w+)?/,  // Format A: filepath (line) : func
  luaStackEntryB:  /^\s*=([^\s:]+\.lua):(\d+)\s+(\w+)?/,                           // Format B: =filepath:line func
  luaError:        /^(.+\.lua)[:(]\s*(\d+)\s*[):]?\s*:\s*(.+)/,
  modLoad:         /\b(?:Load mod|Available mod):\s+(\S+)/i,
  saveEvent:       /\b(?:Saving|Loading savegame|Save game|career)\b/i,
  engineVersion:   /^GIANTS Engine Runtime\s+(.+)/,
  nilIndex:        /attempt to (?:index|call|perform arithmetic on) a? ?nil value/i,
};

// ── Ring Buffer for context lines ───────────────────────────

class RingBuffer {
  constructor(size) {
    this.size = size;
    this.buffer = [];
    this.pos = 0;
    this.count = 0;
  }

  push(item) {
    if (this.buffer.length < this.size) {
      this.buffer.push(item);
    } else {
      this.buffer[this.pos] = item;
    }
    this.pos = (this.pos + 1) % this.size;
    this.count++;
  }

  toArray() {
    if (this.buffer.length < this.size) return [...this.buffer];
    // Reorder from oldest to newest
    return [
      ...this.buffer.slice(this.pos),
      ...this.buffer.slice(0, this.pos)
    ];
  }
}

// ── Error fingerprinting for deduplication ──────────────────

function fingerprint(errorLine, stackFrames) {
  // Hash on structural content: error message core + stack file:line:func
  const parts = [errorLine.replace(/\d+/g, 'N')]; // Normalize numbers
  for (const frame of stackFrames) {
    parts.push(`${frame.file}:${frame.line}:${frame.func || ''}`);
  }
  return createHash('md5').update(parts.join('|')).digest('hex').substring(0, 12);
}

// ── Main streaming analyzer ─────────────────────────────────

async function analyzeLog(filePath, modName, options = {}) {
  const contextBefore = options.contextBefore ?? 3;
  const contextAfter = options.contextAfter ?? 5;

  if (!fs.existsSync(filePath)) {
    throw new Error(`Log file not found: ${filePath}`);
  }

  const stats = fs.statSync(filePath);
  if (stats.size > 100 * 1024 * 1024) {
    throw new Error(`Log file too large: ${(stats.size / 1024 / 1024).toFixed(1)}MB (max 100MB)`);
  }

  const modPattern = modName ? new RegExp(modName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') : null;

  // Result accumulators
  const result = {
    filePath,
    fileSizeBytes: stats.size,
    modName: modName || '(any)',
    engineVersion: null,
    totalLines: 0,
    modsLoaded: [],
    errors: new Map(),      // fingerprint → { message, count, firstLine, lastLine, contextBefore, contextAfter, stackFrames }
    warnings: new Map(),    // fingerprint → { message, count, firstLine, lastLine }
    luaStacks: new Map(),   // fingerprint → { frames, count, firstLine }
    saveEvents: [],
    modMentions: 0,
  };

  // State machine for LUA stack trace parsing
  let inLuaStack = false;
  let currentStackFrames = [];
  let currentStackStartLine = 0;
  let currentErrorForStack = null;

  // After-context collection
  let afterContextNeeded = 0;
  let afterContextTarget = null;
  let afterContextLines = [];

  // Ring buffer for before-context
  const beforeBuffer = new RingBuffer(contextBefore);

  const rl = readline.createInterface({
    input: fs.createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity
  });

  let lineNum = 0;

  for await (const line of rl) {
    lineNum++;
    result.totalLines = lineNum;

    // ── Collect after-context lines ───────────────────────
    if (afterContextNeeded > 0 && afterContextTarget) {
      afterContextLines.push(line);
      afterContextNeeded--;
      if (afterContextNeeded === 0) {
        afterContextTarget.contextAfter = [...afterContextLines];
        afterContextTarget = null;
        afterContextLines = [];
      }
    }

    // ── Engine version ────────────────────────────────────
    if (!result.engineVersion) {
      const engineMatch = line.match(PATTERNS.engineVersion);
      if (engineMatch) {
        result.engineVersion = engineMatch[1].trim();
      }
    }

    // ── Mod loading ───────────────────────────────────────
    const modLoadMatch = line.match(PATTERNS.modLoad);
    if (modLoadMatch) {
      const loadedMod = modLoadMatch[1];
      if (!result.modsLoaded.includes(loadedMod)) {
        result.modsLoaded.push(loadedMod);
      }
    }

    // ── Save events mentioning the mod ────────────────────
    if (PATTERNS.saveEvent.test(line)) {
      if (!modPattern || modPattern.test(line)) {
        if (result.saveEvents.length < 20) {
          result.saveEvents.push({ line: lineNum, text: line.trim().substring(0, 200) });
        }
      }
    }

    // ── Mod mention counter ───────────────────────────────
    if (modPattern && modPattern.test(line)) {
      result.modMentions++;
    }

    // ── LUA stack trace state machine ─────────────────────
    if (inLuaStack) {
      // Try to parse as stack frame
      const frameA = line.match(PATTERNS.luaStackEntryA);
      const frameB = line.match(PATTERNS.luaStackEntryB);
      const frame = frameA || frameB;

      if (frame) {
        currentStackFrames.push({
          file: frame[1],
          line: parseInt(frame[2]),
          func: (frame[3] || '').trim() || null
        });
      } else {
        // End of stack trace (empty line, new timestamp, or non-matching line)
        if (currentStackFrames.length > 0) {
          const fp = fingerprint('lua_stack', currentStackFrames);

          if (result.luaStacks.has(fp)) {
            result.luaStacks.get(fp).count++;
          } else {
            // Check if any frame references the target mod
            const modRelevant = !modPattern || currentStackFrames.some(f => modPattern.test(f.file));
            result.luaStacks.set(fp, {
              frames: [...currentStackFrames],
              count: 1,
              firstLine: currentStackStartLine,
              modRelevant
            });
          }

          // Attach stack to the preceding error if applicable
          if (currentErrorForStack && result.errors.has(currentErrorForStack)) {
            const err = result.errors.get(currentErrorForStack);
            if (!err.stackFingerprint) {
              err.stackFingerprint = fp;
            }
          }
        }

        inLuaStack = false;
        currentStackFrames = [];
        currentErrorForStack = null;
      }
      // Don't skip other processing — the line might also be an error
      if (inLuaStack) {
        beforeBuffer.push({ lineNum, text: line });
        continue;
      }
    }

    // ── LUA call stack header ─────────────────────────────
    if (PATTERNS.luaStackHeader.test(line)) {
      inLuaStack = true;
      currentStackFrames = [];
      currentStackStartLine = lineNum;
      beforeBuffer.push({ lineNum, text: line });
      continue;
    }

    // ── Error lines ───────────────────────────────────────
    if (PATTERNS.error.test(line)) {
      // Check mod relevance
      const relevant = !modPattern || modPattern.test(line);
      // Also check the before-context for mod mentions
      const contextRelevant = !modPattern || beforeBuffer.toArray().some(b => modPattern.test(b.text));

      if (relevant || contextRelevant) {
        const msgCore = line.replace(PATTERNS.timestamp, '').trim();
        const fp = fingerprint(msgCore, []);

        if (result.errors.has(fp)) {
          const existing = result.errors.get(fp);
          existing.count++;
          existing.lastLine = lineNum;
        } else {
          const entry = {
            message: msgCore.substring(0, 300),
            count: 1,
            firstLine: lineNum,
            lastLine: lineNum,
            contextBefore: beforeBuffer.toArray().map(b => b.text),
            contextAfter: [],
            stackFingerprint: null
          };
          result.errors.set(fp, entry);

          // Start collecting after-context
          afterContextNeeded = contextAfter;
          afterContextTarget = entry;
          afterContextLines = [];
        }

        // Track for stack association
        currentErrorForStack = fp;
      }
    }

    // ── Warning lines ─────────────────────────────────────
    if (PATTERNS.warning.test(line)) {
      const relevant = !modPattern || modPattern.test(line);
      if (relevant) {
        const msgCore = line.replace(PATTERNS.timestamp, '').trim();
        const fp = fingerprint(msgCore, []);

        if (result.warnings.has(fp)) {
          result.warnings.get(fp).count++;
          result.warnings.get(fp).lastLine = lineNum;
        } else {
          result.warnings.set(fp, {
            message: msgCore.substring(0, 300),
            count: 1,
            firstLine: lineNum,
            lastLine: lineNum
          });
        }
      }
    }

    // ── Update before-context buffer ──────────────────────
    beforeBuffer.push({ lineNum, text: line });
  }

  // Close any open stack trace
  if (inLuaStack && currentStackFrames.length > 0) {
    const fp = fingerprint('lua_stack', currentStackFrames);
    if (!result.luaStacks.has(fp)) {
      const modRelevant = !modPattern || currentStackFrames.some(f => modPattern.test(f.file));
      result.luaStacks.set(fp, {
        frames: [...currentStackFrames],
        count: 1,
        firstLine: currentStackStartLine,
        modRelevant
      });
    }
  }

  return result;
}

// ── Render structured result for LLM consumption ────────────

function renderForLLM(result) {
  const lines = [];

  lines.push(`## Log Analysis: ${result.modName}`);
  if (result.engineVersion) {
    lines.push(`Engine: ${result.engineVersion}`);
  }
  lines.push(`Total log lines: ${result.totalLines.toLocaleString()}`);
  lines.push(`File size: ${(result.fileSizeBytes / 1024 / 1024).toFixed(1)}MB`);
  if (result.modMentions > 0) {
    lines.push(`Mod mentioned ${result.modMentions.toLocaleString()} times in log`);
  }
  lines.push('');

  // Mod loading
  if (result.modsLoaded.length > 0) {
    const modPattern = result.modName !== '(any)' ? new RegExp(result.modName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') : null;
    const relevant = modPattern
      ? result.modsLoaded.filter(m => modPattern.test(m))
      : result.modsLoaded.slice(0, 10);

    if (relevant.length > 0) {
      lines.push('### Mod Loading');
      for (const mod of relevant) {
        lines.push(`- ${mod}`);
      }
      if (!modPattern && result.modsLoaded.length > 10) {
        lines.push(`- ... and ${result.modsLoaded.length - 10} more mods`);
      }
      lines.push('');
    }
  }

  // Errors — sorted by count descending
  const errors = Array.from(result.errors.values()).sort((a, b) => b.count - a.count);
  const totalErrorOccurrences = errors.reduce((sum, e) => sum + e.count, 0);
  lines.push(`### Errors (${errors.length} unique, ${totalErrorOccurrences.toLocaleString()} total occurrences)`);

  if (errors.length === 0) {
    lines.push(`- No errors found${result.modName !== '(any)' ? ` mentioning "${result.modName}"` : ''}`);
  } else {
    // Show top 10 errors
    for (const err of errors.slice(0, 10)) {
      const range = err.firstLine === err.lastLine
        ? `L${err.firstLine.toLocaleString()}`
        : `L${err.firstLine.toLocaleString()}-${err.lastLine.toLocaleString()}`;
      lines.push(`- ${range}: ${err.message} [x${err.count}]`);
    }
    if (errors.length > 10) {
      lines.push(`- ... and ${errors.length - 10} more unique errors`);
    }
  }
  lines.push('');

  // Warnings — summary only
  const warnings = Array.from(result.warnings.values()).sort((a, b) => b.count - a.count);
  const totalWarnings = warnings.reduce((sum, w) => sum + w.count, 0);
  if (warnings.length > 0) {
    lines.push(`### Warnings (${warnings.length} unique, ${totalWarnings.toLocaleString()} total)`);
    for (const warn of warnings.slice(0, 5)) {
      lines.push(`- L${warn.firstLine.toLocaleString()}: ${warn.message} [x${warn.count}]`);
    }
    if (warnings.length > 5) {
      lines.push(`- ... and ${warnings.length - 5} more unique warnings`);
    }
    lines.push('');
  }

  // LUA Stack Traces — only mod-relevant ones
  const stacks = Array.from(result.luaStacks.values())
    .filter(s => s.modRelevant)
    .sort((a, b) => b.count - a.count);

  if (stacks.length > 0) {
    lines.push(`### LUA Call Stacks (${stacks.length} unique, mod-relevant)`);
    for (const stack of stacks.slice(0, 5)) {
      lines.push(`Stack at L${stack.firstLine.toLocaleString()} [x${stack.count}]:`);
      for (const frame of stack.frames) {
        const funcStr = frame.func ? ` ${frame.func}` : '';
        lines.push(`  ${frame.file}:${frame.line}${funcStr}`);
      }
      lines.push('');
    }
    if (stacks.length > 5) {
      lines.push(`... and ${stacks.length - 5} more unique stacks`);
      lines.push('');
    }
  }

  // Error context — show before/after for the top 3 most frequent errors
  const topErrors = errors.slice(0, 3).filter(e => e.contextBefore.length > 0 || e.contextAfter.length > 0);
  if (topErrors.length > 0) {
    lines.push('### Error Context (top errors)');
    for (const err of topErrors) {
      lines.push(`**L${err.firstLine}**: ${err.message.substring(0, 100)}`);
      if (err.contextBefore.length > 0) {
        lines.push('Before:');
        for (const ctx of err.contextBefore) {
          lines.push(`  ${ctx.substring(0, 200)}`);
        }
      }
      if (err.contextAfter.length > 0) {
        lines.push('After:');
        for (const ctx of err.contextAfter) {
          lines.push(`  ${ctx.substring(0, 200)}`);
        }
      }
      // Show associated stack if available
      if (err.stackFingerprint && result.luaStacks.has(err.stackFingerprint)) {
        const stack = result.luaStacks.get(err.stackFingerprint);
        lines.push('Stack:');
        for (const frame of stack.frames) {
          const funcStr = frame.func ? ` ${frame.func}` : '';
          lines.push(`  ${frame.file}:${frame.line}${funcStr}`);
        }
      }
      lines.push('');
    }
  }

  // Save events
  if (result.saveEvents.length > 0) {
    lines.push('### Save Events');
    for (const evt of result.saveEvents.slice(0, 5)) {
      lines.push(`- L${evt.line}: ${evt.text}`);
    }
    if (result.saveEvents.length > 5) {
      lines.push(`- ... and ${result.saveEvents.length - 5} more`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

module.exports = { analyzeLog, renderForLLM };

# Plan: Codebot v3.0 — Feature Expansion + UX Overhaul

## Current State Assessment

### Already Implemented (No Work Needed)
These features from the request **already exist** in the codebase:

| Feature | Where | Status |
|---------|-------|--------|
| Per-user workspace isolation | `src/utils/workspace.js` | Full — `workspaces/users/{userId}/{owner}--{repo}/` |
| PAT encryption (AES-256-GCM) | `src/utils/token-store.js` | Full — per-user PBKDF2-derived keys, audit logging |
| Token tracking per user | `src/utils/usage.js` | Full — API calls, input/output tokens, cost calc |
| Auto-threading | `src/bot.js` | Full — action intents create threads, chat mode |
| Typing indicator loop | `src/bot.js` | Full — 8-second refresh during tool-use loops |
| PAT modal (secure input) | `src/slash-commands.js` | Full — `/codepat` opens modal |
| Ephemeral responses | `src/slash-commands.js` | Partial — status/help are ephemeral |
| Confirmation prompts | `src/utils/confirmation.js` | Full — button-based approve/deny |
| Progress tracking embeds | `src/utils/progress.js` | Full — step-based progress with live embed edits |

### Needs Implementation (This Plan)

---

## Phase 1 — Core New Features (Highest Impact)

### 1.1 Groq/OpenAI-Compatible Backend for Free-Tier Users
**Goal**: Non-owner users without Anthropic API keys get a free LLM option via Groq (or any OpenAI-compatible endpoint like Ollama).

**Files**: `src/utils/config.js`, `src/claude.js` (new provider abstraction), NEW `src/providers/groq.js`

**Design**:
- Add `GROQ_API_KEY` and `GROQ_MODEL` to config (e.g., `llama-3.3-70b-versatile`)
- Add `FREE_TIER_MODEL` env var — which provider/model non-owner users get
- Groq uses OpenAI-compatible API — use `openai` npm package with custom `baseURL`
- Provider selection logic in `claude.js`:
  - If user is bot owner (new `BOT_OWNER_ID` env var) → always use Claude
  - If user has `ANTHROPIC_API_KEY` set as their preference → use Claude
  - Otherwise → use Groq free tier
- Groq provider implements same interface: `callLLM(messages, systemPrompt, tools, context)` returning `{ response, usage }`
- **Tool support**: Groq supports function calling — pass same tool definitions
- **Token tracking**: Track under model name (e.g., `groq/llama-3.3-70b`) in usage.js — add Groq pricing (free tier = $0)
- **Streaming**: Groq supports streaming — can use same message-edit pattern

**Config additions**:
```
GROQ_API_KEY=gsk_xxxx
GROQ_MODEL=llama-3.3-70b-versatile
BOT_OWNER_ID=your_discord_user_id
FREE_TIER_ENABLED=true
```

### 1.2 Programmatic Auto-Clone + Issue Detail on Thread Open
**Goal**: When a user mentions an issue URL and a thread is created, automatically (a) clone the repo and (b) fetch issue details — before the LLM even starts. This saves 2-3 tool iterations.

**Files**: `src/bot.js` (thread creation path), `src/utils/issue-preprocessor.js` (already exists — enhance it)

**Design**:
- In `createChatThread()`, detect GitHub issue/PR URLs in the query using regex
- If URL detected:
  1. **Parse** owner/repo/number from URL
  2. **Fetch issue details** via GitHub API (using user's PAT if available, or unauthenticated)
  3. **Clone repo** to scratch space (non-blocking, `execFileSync` with timeout)
  4. **Inject context** into the thread's opening message as an embed:
     - Issue title, body (truncated), labels, assignee
     - "Repo cloned to scratch — ready for analysis"
  5. **Prepend to Claude's prompt**: Issue details + "The repo has been cloned to scratch. The issue details are above."
- This is programmatic — no LLM calls, no tokens spent
- If clone fails (timeout, private repo without PAT), gracefully degrade — just note it in the embed

### 1.3 "Stop" Command — Interrupt In-Progress Responses
**Goal**: User types "stop" in a thread to cancel an ongoing tool-use loop.

**Files**: `src/bot.js`, `src/claude.js`

**Design**:
- Add an `AbortController` per active request, stored in a `Map<channelId, AbortController>`
- In `handleClaudeRequest()`: create controller, store in map, pass `signal` to the tool-use loop
- In `callClaude()`: check `signal.aborted` before each iteration; if aborted, break loop and return partial results
- In `messageCreate` handler: if message is "stop" and channel has an active controller, call `controller.abort()`
- Send confirmation: "Stopped. Here's what I found so far:" + partial results
- Clean up controller from map on request completion (success, error, or abort)

### 1.4 Show Tool Usage Summary in Responses
**Goal**: Every bot response shows which tools were called and how many times, so users understand what the bot did.

**Files**: `src/claude.js` (return tool summary), `src/bot.js` (render in footer)

**Design**:
- In `callClaude()`: track a `toolCounts` map (tool name → call count)
- Return `toolCounts` alongside `{ response, iterations, totalUsage }`
- In `bot.js` response rendering: append a compact footer line:
  ```
  📊 4 iterations | 12.3K tokens ($0.04) | Tools: github_get_issue, repo_clone, repo_read ×2, file_edit
  ```
- Format: tool names in call order, with `×N` suffix if called more than once
- Keep it on one line — this goes in the existing token footer area

---

## Phase 2 — UX Improvements (from VISION.md)

### 2.1 Simulated Streaming via Message Edits
**Goal**: Instead of silence → wall of text, show progressive output with a `▌` typing cursor.

**Files**: `src/bot.js` (new `streamToDiscord()` helper), `src/claude.js` (callback hook)

**Design**:
- Currently, intermediate text is sent as separate messages via `onText` callback
- New approach: send ONE placeholder message (`"⚙️ Thinking..."`), then edit it as text arrives
- Edit throttling: max 1 edit/second OR every 150 chars, whichever comes first (Discord rate limit safe)
- Append `▌` cursor during streaming, remove on final edit
- For tool-use loops: show tool names as they execute (e.g., "🔧 Running `github_get_issue`... ▌")
- Final message: remove cursor, append token footer
- **Chunking**: If response exceeds ~1900 chars during streaming, freeze current message and start a new one
- Falls back gracefully if edit fails (e.g., message deleted)

### 2.2 Context Menus — Right-Click Actions
**Goal**: Users can right-click any message to trigger "Debug This", "Explain This", or "Review PR".

**Files**: `src/slash-commands.js` (register context menu commands), `src/bot.js` (handle interactions)

**Design**:
- Register 3 message context menu commands:
  - `Debug This` — extracts error/stacktrace from message, opens debug thread
  - `Explain This` — extracts code from message, explains it
  - `Review PR` — extracts PR URL from message, runs review
- These are registered via `ContextMenuCommandBuilder` (discord.js v14)
- Each creates a thread off the target message and streams the response into it
- Ephemeral acknowledgment → thread creation → streaming response

### 2.3 Post-Response Action Buttons
**Goal**: After every substantive bot response, show contextual buttons.

**Files**: `src/bot.js` (attach buttons to final message)

**Design**:
- After a Claude response in a thread, attach an `ActionRow` with:
  - **"Follow Up"** (primary) — opens a modal for a follow-up question
  - **"Resolved"** (success) — archives the thread
  - **"Save"** (secondary) — saves the answer to user's snippets (future feature hook)
- For PR reviews, different buttons:
  - **"Re-review"** — re-run the review
  - **"Approve PR"** — calls GitHub API to approve
  - **"Request Changes"** — calls GitHub API to request changes
- Buttons timeout after 5 minutes (Discord default 15 min, but we want snappier cleanup)
- Only attach to the LAST message in multi-message responses

### 2.4 Model Select Dropdown
**Goal**: Users can choose their preferred model via `/codemodel` slash command.

**Files**: `src/slash-commands.js`, `src/utils/user-profiles.js`

**Design**:
- New `/codemodel` slash command that shows a select menu
- Options populated dynamically based on configured providers:
  - `Groq Llama 70B` — free, fast, good for quick questions (only if GROQ_API_KEY set)
  - `Claude Haiku` — cheap, smart, good for reviews
  - `Claude Sonnet` — most capable, complex tasks
- Selection stored in user profile (`preferredModel` field)
- Model preference feeds into provider selection in `claude.js`
- Ephemeral response confirming selection

---

## Phase 3 — Advanced Features

### 3.1 Subagent Support
**Goal**: Allow the main Claude instance to spawn sub-tasks that run in parallel with their own tool access.

**Files**: NEW `src/utils/subagent.js`, `src/claude.js`, `src/tools/index.js`

**Design**:
- Add a new tool `spawn_subagent` to the tool catalog:
  ```
  spawn_subagent({ task: "Analyze the test suite", tools: ["repo_list", "repo_read"] })
  ```
- Subagent runs as a separate `callClaude()` invocation with:
  - Restricted tool set (only the tools specified)
  - Lower iteration budget (max 5)
  - Separate token tracking (attributed to same user but tagged as "subagent")
  - Smaller model option (Haiku for simple sub-tasks)
- Results returned to parent agent as tool result
- **Guard rails**:
  - Max 3 concurrent subagents per request
  - Subagents cannot spawn further subagents (depth limit = 1)
  - Total token budget shared with parent (subagent tokens count toward parent's budget)
- Token tracking: subagent usage rolled into parent request's total, but logged separately for visibility

### 3.2 Autocomplete for PR/Branch Selection
**Goal**: When typing `/codereview`, show a dropdown of open PRs from the user's default repo.

**Files**: `src/slash-commands.js`

**Design**:
- Add autocomplete handler for the `pr_url` option on `/codereview`
- When user types, query GitHub API for open PRs matching the input
- Return up to 25 choices formatted as `#123: Fix login bug`
- Requires user's PAT — falls back to manual URL entry if no PAT
- Cache PR list for 60 seconds to avoid hammering API

---

## Implementation Order

| Priority | Feature | Est. Complexity | Files Touched |
|----------|---------|----------------|---------------|
| **P0** | 1.4 Tool usage summary in responses | Small | claude.js, bot.js |
| **P0** | 1.2 Auto-clone + issue detail on thread open | Medium | bot.js, issue-preprocessor.js |
| **P0** | 1.3 "Stop" command | Medium | bot.js, claude.js |
| **P1** | 2.1 Simulated streaming | Medium | bot.js, claude.js |
| **P1** | 1.1 Groq free-tier backend | Large | config.js, claude.js, NEW providers/groq.js |
| **P1** | 2.3 Post-response action buttons | Medium | bot.js |
| **P2** | 2.2 Context menus | Medium | slash-commands.js, bot.js |
| **P2** | 2.4 Model select dropdown | Small | slash-commands.js, user-profiles.js |
| **P3** | 3.1 Subagent support | Large | NEW subagent.js, claude.js, tools/index.js |
| **P3** | 3.2 Autocomplete for PR/branch | Medium | slash-commands.js |

---

## Token Budget Impact

| Feature | Impact on per-request tokens |
|---------|------------------------------|
| Auto-clone + issue detail | **Saves 1000-3000 tokens** (2-3 fewer tool iterations) |
| Tool usage summary | **+50 tokens** (footer line) |
| Stop command | **Saves variable** (user-controlled early exit) |
| Streaming | **Net zero** (same tokens, better UX) |
| Groq free tier | **Saves $$$** (free for non-owner users) |
| Subagents | **+500-2000** per subagent spawn, but enables parallel work |

---

## Files Created/Modified Summary

### New Files
- `src/providers/groq.js` — Groq/OpenAI-compatible provider
- `src/utils/subagent.js` — Subagent orchestration

### Modified Files
- `src/utils/config.js` — New env vars (GROQ_API_KEY, BOT_OWNER_ID, etc.)
- `src/claude.js` — Provider abstraction, abort support, tool tracking, streaming hooks
- `src/bot.js` — Stop command, streaming, action buttons, context menus, auto-clone integration
- `src/slash-commands.js` — Context menus, model select, autocomplete
- `src/utils/user-profiles.js` — `preferredModel` field
- `src/utils/usage.js` — Groq pricing, subagent tracking
- `src/utils/issue-preprocessor.js` — Enhanced with auto-clone logic
- `.env.example` — New config vars documented

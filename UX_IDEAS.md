# DevBot UX Design Reference
> Research-backed Discord UX patterns for an AI coding assistant bot with GitHub integration.  
> Use this as a feature ideation and implementation guide.

---

## Project Context

**DevBot** is a self-hosted Discord bot combining AI coding assistance (Anthropic Claude + Groq) with GitHub integration. It targets dev teams who want PR reviews, code explanations, debugging help, and GitHub event notifications — all inside Discord.

Core stack: `discord.py` · `Anthropic SDK` · `Groq SDK` · `PyGithub` · `FastAPI (webhooks)` · `aiosqlite`

---

## 1. Simulated LLM Streaming — Highest Priority

Discord does not natively support token streaming (feature request is open but unimplemented). The production workaround is **streaming via message edits in a loop**, used by Chorus, llmcord, and other production LLM bots.

### Why it matters
Waiting 10–30 seconds for a silent bot then getting a wall of text is the #1 UX killer. Streaming via edits turns that into a ChatGPT-style live-typing experience that users find engaging rather than frustrating.

### Implementation pattern

```python
async def stream_response(ctx, prompt: str, system: str = ""):
    """Stream LLM response by editing a placeholder message in chunks."""
    # Send placeholder immediately — eliminates perceived latency
    msg = await ctx.send("⚙️ Thinking...")
    
    buffer = ""
    last_edit = time.time()
    EDIT_INTERVAL = 1.0   # seconds between edits (stay under rate limit)
    EDIT_CHAR_MIN = 150   # also edit after this many new chars

    async with anthropic_client.messages.stream(
        model="claude-haiku-4-5",
        max_tokens=2048,
        system=system,
        messages=[{"role": "user", "content": prompt}]
    ) as stream:
        async for text in stream.text_stream:
            buffer += text
            now = time.time()
            chars_since_edit = len(buffer) - len(getattr(msg, '_last_content', ''))
            
            if (now - last_edit >= EDIT_INTERVAL) or (chars_since_edit >= EDIT_CHAR_MIN):
                await msg.edit(content=buffer + " ▌")  # ▌ = typing cursor
                msg._last_content = buffer
                last_edit = now

    # Final edit — remove cursor, apply any formatting
    await msg.edit(content=buffer)
    return msg
```

### Typing indicator loop
`async with channel.typing()` only lasts 10 seconds. For long operations, loop it:

```python
async def keep_typing(channel: discord.TextChannel, stop_event: asyncio.Event):
    while not stop_event.is_set():
        await channel.trigger_typing()
        await asyncio.sleep(8)  # re-trigger before Discord's 10s timeout

# Usage
stop = asyncio.Event()
asyncio.create_task(keep_typing(ctx.channel, stop))
try:
    result = await long_llm_call()
finally:
    stop.set()
```

### Rate limit budget
Discord allows ~5 message edits/second. Safe pattern: edit every ~1 second **or** every ~150–200 characters — whichever comes first. Never edit every token.

---

## 2. Auto-Threading — Keep Channels Clean

Every `/ask` invocation should spawn a dedicated thread. This is the difference between a channel that becomes unusable after 20 questions vs one that stays clean indefinitely.

### Pattern

```python
@bot.slash_command(name="ask")
async def ask(ctx, question: str):
    # Post a seed message in the main channel
    seed = await ctx.send(embed=discord.Embed(
        title=f"💬 {question[:80]}",
        color=0x5865F2
    ))
    
    # Create thread off that message
    thread = await seed.create_thread(
        name=f"🤖 {question[:45]}...",
        auto_archive_duration=60  # 60 | 1440 | 4320 | 10080 minutes
    )
    
    # Store context for continuations
    await db.execute(
        "INSERT INTO sessions (thread_id, user_id, history) VALUES (?, ?, ?)",
        (thread.id, ctx.author.id, json.dumps([]))
    )
    
    # Stream response into the thread
    async with thread.typing():
        response = await stream_response(thread, question)
    
    # Append action buttons
    await thread.send(view=PostResponseView(thread_id=thread.id))
```

### Thread naming conventions
- `/ask` → `🤖 How do I debounce in React...`
- `/review` → `📋 PR #142: Add OAuth flow`
- `/debug` → `🐛 NullPointerException in auth...`
- Webhook PR opened → `🔔 PR #143 opened: Fix rate limiting`

### Auto-archive behavior
- Quick Q&A sessions: 60 minutes
- Active PR reviews: 1440 minutes (24h)
- Lock + archive on user button press "✅ Resolved"

### Reply-chain branching
Users can reply to any bot message to branch into a sub-conversation. Parse `message.reference` to reconstruct the correct conversation branch:

```python
@bot.listen("on_message")
async def on_reply(message):
    if message.reference and not message.author.bot:
        parent = await message.channel.fetch_message(message.reference.message_id)
        if parent.author == bot.user:
            # Continue that conversation branch
            history = await db.get_history_for_message(parent.id)
            await continue_conversation(message, history)
```

---

## 3. Components V2 — Modern Message Layout

Discord released Components V2 in mid-2025. `discord.py` 2.6+ supports it. This replaces the old embed system with a proper composable layout model.

### What's available
| Component | Use case |
|---|---|
| `TextDisplay` | Markdown text block, placeable anywhere |
| `Container` | Rounded card with optional accent color bar |
| `Section` | Text + thumbnail or button side-by-side |
| `Separator` | Visual divider, small or large spacing |
| `MediaGallery` | 1–10 images in a gallery |
| `ActionRow` | Buttons and select menus (unchanged, now nestable) |

### Enable it
Add `flags=MessageFlags.IS_COMPONENTS_V2` to message sends. **Note:** once set, `content` and `embeds` fields are disabled — use `TextDisplay` and `Container` instead.

### PR review card example

```python
import discord

def build_review_card(pr_data: dict, review: dict) -> discord.ui.LayoutView:
    class ReviewCard(discord.ui.LayoutView):
        # Header
        header = discord.ui.Container(
            discord.ui.Section(
                discord.ui.TextDisplay(f"## PR #{pr_data['number']}: {pr_data['title']}"),
                discord.ui.TextDisplay(
                    f"**Author:** {pr_data['author']}  |  "
                    f"**+{pr_data['additions']}** / **-{pr_data['deletions']}**  |  "
                    f"**{pr_data['files_changed']} files**"
                ),
            ),
            accent_color=review['color']  # green=approved, red=changes, yellow=comment
        )
        
        sep1 = discord.ui.Separator()
        
        summary_section = discord.ui.TextDisplay(
            f"### Summary\n{review['summary']}"
        )
        
        sep2 = discord.ui.Separator()
        
        issues_section = discord.ui.TextDisplay(
            f"### Issues Found\n{review['issues_formatted']}"
        )
        
        sep3 = discord.ui.Separator()
        
        # Action buttons
        actions = discord.ui.ActionRow()

    return ReviewCard()
```

### Accent color semantics
- `0x57F287` (green) — approved, no issues
- `0xFEE75C` (yellow) — approved with comments
- `0xED4245` (red) — changes requested
- `0x5865F2` (blurple) — informational / in-progress

---

## 4. Context Menus — Zero-Friction Native Actions

Right-click (or long-press on mobile) any message → **Apps** → bot commands appear inline. No slash command typing. Feels completely native.

### Recommended context menu commands

```python
@bot.message_command(name="🐛 Debug This")
async def debug_this(ctx, message: discord.Message):
    """Right-click any error message to debug it."""
    await ctx.defer(ephemeral=True)  # only visible to requester
    # ... extract code/traceback from message.content
    thread = await message.create_thread(name="🐛 Debug session")
    await stream_response(thread, f"Debug this error:\n{message.content}")


@bot.message_command(name="📖 Explain This")  
async def explain_this(ctx, message: discord.Message):
    """Right-click any code snippet to explain it."""
    await ctx.defer()
    thread = await message.create_thread(name="📖 Code explanation")
    await stream_response(thread, f"Explain this code:\n{message.content}")


@bot.message_command(name="🔍 Review PR")
async def review_from_message(ctx, message: discord.Message):
    """Right-click a message containing a PR URL."""
    pr_url = extract_pr_url(message.content)
    if not pr_url:
        await ctx.respond("No PR URL found in that message.", ephemeral=True)
        return
    await ctx.defer()
    await run_pr_review(ctx, pr_url)


@bot.message_command(name="🧵 Continue in Thread")
async def continue_in_thread(ctx, message: discord.Message):
    """Right-click any bot response to branch into a thread."""
    thread = await message.create_thread(name="💬 Follow-up discussion")
    await ctx.respond(f"Thread created: {thread.mention}", ephemeral=True)
```

---

## 5. Button Flows After Every Response

Every bot response should have contextual action buttons. This eliminates the "wall of text → dead end" pattern.

### After `/ask` response
```python
class PostAskView(discord.ui.View):
    def __init__(self, thread_id: int):
        super().__init__(timeout=300)
        self.thread_id = thread_id

    @discord.ui.button(label="Ask Follow-up", emoji="💬", style=discord.ButtonStyle.primary)
    async def followup(self, interaction, button):
        await interaction.response.send_modal(FollowUpModal(self.thread_id))

    @discord.ui.button(label="Save Answer", emoji="📌", style=discord.ButtonStyle.secondary)
    async def save(self, interaction, button):
        await db.save_snippet(self.thread_id, interaction.user.id)
        await interaction.response.send_message("Saved to your snippets!", ephemeral=True)

    @discord.ui.button(label="✅ Resolved", emoji="✅", style=discord.ButtonStyle.success)
    async def resolve(self, interaction, button):
        thread = interaction.channel
        await thread.edit(name=f"✅ {thread.name}", archived=True)
        await interaction.response.send_message("Thread archived.", ephemeral=True)
```

### After `/review` response
```python
class PostReviewView(discord.ui.View):
    @discord.ui.button(label="Re-review", emoji="🔁", style=discord.ButtonStyle.secondary)
    async def rerun(self, interaction, button): ...

    @discord.ui.button(label="Ask About PR", emoji="💬", style=discord.ButtonStyle.primary)
    async def ask_pr(self, interaction, button): ...

    @discord.ui.button(label="Approve PR", emoji="✅", style=discord.ButtonStyle.success)
    async def approve(self, interaction, button):
        # Actually call GitHub API to approve
        await github.approve_pr(self.pr_number)
        await interaction.response.send_message("PR approved on GitHub!", ephemeral=True)

    @discord.ui.button(label="Request Changes", emoji="❌", style=discord.ButtonStyle.danger)
    async def request_changes(self, interaction, button): ...
```

### After `/debug` response
```python
class PostDebugView(discord.ui.View):
    @discord.ui.button(label="Fixed It ✅", style=discord.ButtonStyle.success)
    async def fixed(self, interaction, button):
        await interaction.channel.edit(archived=True)

    @discord.ui.button(label="Still Broken", style=discord.ButtonStyle.danger)
    async def still_broken(self, interaction, button):
        await interaction.response.send_modal(StillBrokenModal())

    @discord.ui.button(label="Try Different Approach", style=discord.ButtonStyle.secondary)
    async def alternate(self, interaction, button):
        await stream_response(interaction.channel, "Give me a completely different approach to fix this.")
```

---

## 6. Modals — Form Input for Complex Commands

Pop-up multi-field forms. Up to 5 `TextInput` fields per modal. Use instead of cramming all options into a slash command.

### PR review modal

```python
class PRReviewModal(discord.ui.Modal, title="Review a Pull Request"):
    pr_url = discord.ui.TextInput(
        label="PR URL or PR Number",
        placeholder="https://github.com/org/repo/pull/142  or just  142",
        required=True
    )
    focus = discord.ui.TextInput(
        label="Focus areas (optional)",
        placeholder="security, performance, error handling...",
        required=False
    )
    severity = discord.ui.TextInput(
        label="Min severity to report (minor/major/critical)",
        placeholder="minor",
        default="minor",
        required=False,
        max_length=10
    )

    async def on_submit(self, interaction: discord.Interaction):
        await interaction.response.defer()
        await run_pr_review(interaction, self.pr_url.value, 
                           focus=self.focus.value,
                           severity=self.severity.value)


@bot.slash_command(name="review")
async def review(ctx):
    await ctx.send_modal(PRReviewModal())
```

### Ask modal (for multi-line questions)

```python
class AskModal(discord.ui.Modal, title="Ask DevBot"):
    question = discord.ui.TextInput(
        label="Your question",
        style=discord.TextStyle.paragraph,
        placeholder="Describe your problem in detail...",
        max_length=2000
    )
    context = discord.ui.TextInput(
        label="Code context (optional)",
        style=discord.TextStyle.paragraph,
        placeholder="Paste relevant code here...",
        required=False,
        max_length=2000
    )
```

---

## 7. Autocomplete — Live GitHub Data in Slash Commands

Query GitHub API as the user types to populate PR/branch/repo dropdowns.

```python
@bot.slash_command(name="review")
async def review(
    ctx,
    pr: discord.Option(str, "PR to review", autocomplete=True)
):
    ...

@review.autocomplete("pr")
async def pr_autocomplete(ctx, current: str):
    repo = await db.get_user_repo(ctx.author.id) or DEFAULT_REPO
    prs = await github_client.get_open_prs(repo)
    return [
        discord.OptionChoice(
            name=f"#{pr.number}: {pr.title[:60]}",
            value=str(pr.number)
        )
        for pr in prs
        if current.lower() in pr.title.lower() or current in str(pr.number)
    ][:25]  # Discord limit: 25 choices


@bot.slash_command(name="commits")
async def commits(
    ctx,
    branch: discord.Option(str, "Branch to inspect", autocomplete=True)
):
    ...

@commits.autocomplete("branch")
async def branch_autocomplete(ctx, current: str):
    repo = await db.get_user_repo(ctx.author.id)
    branches = await github_client.list_branches(repo)
    return [
        discord.OptionChoice(name=b.name, value=b.name)
        for b in branches
        if current.lower() in b.name.lower()
    ][:25]
```

---

## 8. Select Menus — Model and Repo Pickers

Dropdowns are better than typed parameters for bounded choices.

```python
class ModelSelectView(discord.ui.View):
    @discord.ui.select(
        placeholder="Choose AI model...",
        options=[
            discord.SelectOption(
                label="⚡ Groq + Llama 70B",
                value="groq/llama-70b",
                description="400–600 tok/s · free tier · best for quick questions"
            ),
            discord.SelectOption(
                label="🧠 Claude Haiku",
                value="claude/haiku",
                description="Smart · cheap · best for PR reviews"
            ),
            discord.SelectOption(
                label="🔬 Claude Sonnet",
                value="claude/sonnet",
                description="Most capable · 200K context · complex architecture"
            ),
            discord.SelectOption(
                label="📦 DeepSeek R1 (Groq)",
                value="groq/deepseek-r1",
                description="Deep reasoning · free · slow"
            ),
        ]
    )
    async def model_select(self, select, interaction):
        await db.set_user_model(interaction.user.id, select.values[0])
        await interaction.response.send_message(
            f"Model set to `{select.values[0]}`", ephemeral=True
        )
```

---

## 9. Ephemeral Messages — When to Use Them

Ephemeral messages are **only visible to the user who triggered the interaction**. Use them to keep channels clean.

| Scenario | Public or Ephemeral? |
|---|---|
| PR review result | **Public** — whole team benefits |
| Code explanation | **Public** — shareable knowledge |
| `/model` change confirmation | **Ephemeral** |
| Error messages | **Ephemeral** |
| Snippet saved confirmation | **Ephemeral** |
| `/standup` draft (before posting) | **Ephemeral** → user confirms → then public |
| "Still thinking..." status updates | **Ephemeral** |
| GitHub token invalid warning | **Ephemeral** |

```python
# Ephemeral pattern
await ctx.respond("Model updated.", ephemeral=True)

# Deferred ephemeral (for slow operations)
await ctx.defer(ephemeral=True)
result = await do_slow_thing()
await ctx.followup.send(result, ephemeral=True)
```

---

## 10. Forum Channel Integration (Advanced)

For teams wanting a persistent knowledge base, use a dedicated **Forum Channel** (`#dev-questions`). Requires Community server mode.

### Setup
- Channel type: Forum
- Tags to create manually in Discord: `🔴 Open`, `🟡 In Progress`, `✅ Solved`, `🐛 Bug`, `❓ Question`, `📋 PR Review`
- Bot listens to `on_thread_create` events in this channel

### Bot behavior

```python
@bot.listen("on_thread_create")
async def on_forum_post(thread: discord.Thread):
    if thread.parent_id != FORUM_CHANNEL_ID:
        return
    
    # Apply initial tag
    open_tag = get_tag(thread.parent, "🔴 Open")
    await thread.edit(applied_tags=[open_tag])
    
    # Post welcome + start streaming answer
    await thread.send(
        "👋 I'll take a look at this. One moment...",
        view=ForumPostView(thread.id)
    )
    await stream_response(thread, thread.name + "\n" + thread.starter_message.content)

class ForumPostView(discord.ui.View):
    @discord.ui.button(label="✅ Mark Solved", style=discord.ButtonStyle.success)
    async def mark_solved(self, interaction, button):
        thread = interaction.channel
        solved_tag = get_tag(thread.parent, "✅ Solved")
        open_tag = get_tag(thread.parent, "🔴 Open")
        new_tags = [t for t in thread.applied_tags if t != open_tag] + [solved_tag]
        await thread.edit(applied_tags=new_tags, archived=True)
        await interaction.response.send_message("Marked as solved!", ephemeral=True)
```

---

## 11. Proactive Webhook Notifications (UX Design)

When GitHub events fire, notifications should be actionable — not just informational.

### PR opened notification

```python
async def notify_pr_opened(channel: discord.TextChannel, pr_data: dict):
    class PRNotificationView(discord.ui.View):
        @discord.ui.button(label="🔍 Review Now", style=discord.ButtonStyle.primary)
        async def review_now(self, interaction, button):
            await run_pr_review(interaction, pr_data['number'])

        @discord.ui.button(label="📋 View on GitHub", style=discord.ButtonStyle.link,
                           url=pr_data['url'])
        async def view_github(self, interaction, button): ...

        @discord.ui.button(label="🔕 Ignore", style=discord.ButtonStyle.secondary)
        async def ignore(self, interaction, button):
            await interaction.message.delete()

    embed = discord.Embed(
        title=f"🔔 PR #{pr_data['number']} Opened",
        description=pr_data['title'],
        color=0x5865F2,
        url=pr_data['url']
    )
    embed.add_field(name="Author", value=pr_data['author'])
    embed.add_field(name="Changes", value=f"+{pr_data['additions']} / -{pr_data['deletions']}")
    embed.add_field(name="Files", value=str(pr_data['files_changed']))

    await channel.send(embed=embed, view=PRNotificationView())
```

### CI failure notification — always ephemeral to avoid alarm fatigue

```python
async def notify_ci_failure(channel, run_data):
    # Only ping if it was passing before (avoid spam on repeated failures)
    if run_data['was_passing_before']:
        content = f"<@&{DEV_ROLE_ID}>"  # ping the dev role
    else:
        content = None  # silent follow-up failure
    
    await channel.send(content=content, embed=build_ci_embed(run_data),
                      view=CIFailureView(run_data))
```

---

## 12. Conversation Architecture — SQLite Schema

```sql
-- Sessions: one per thread
CREATE TABLE sessions (
    thread_id     INTEGER PRIMARY KEY,
    user_id       INTEGER NOT NULL,
    created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    model         TEXT DEFAULT 'groq/llama-70b',
    pr_context    TEXT,  -- JSON: PR data if session is PR-focused
    history       TEXT NOT NULL DEFAULT '[]'  -- JSON: message list
);

-- Snippets: saved code/answers
CREATE TABLE snippets (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER NOT NULL,
    name          TEXT NOT NULL,
    content       TEXT NOT NULL,
    language      TEXT,
    source_thread INTEGER,  -- thread_id it came from
    created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- User preferences
CREATE TABLE user_prefs (
    user_id       INTEGER PRIMARY KEY,
    default_model TEXT DEFAULT 'groq/llama-70b',
    default_repo  TEXT,
    ephemeral     BOOLEAN DEFAULT FALSE  -- prefer private responses
);
```

---

## Implementation Priority Order

Build in this sequence — each phase is independently useful:

### Phase 1 — Core Experience
1. Streaming response via message edits + `▌` cursor
2. Auto-threading on `/ask`
3. Typing indicator loop for long operations
4. Ephemeral errors and confirmations

### Phase 2 — Interaction Quality  
5. Post-response button flows (follow-up, save, resolve)
6. Context menus: "Debug This", "Explain This", "Review PR"
7. Model select menu (`/model`)

### Phase 3 — GitHub Intelligence
8. PR review with Components V2 card layout
9. Autocomplete for PR/branch selection
10. Webhook notifications with action buttons
11. Modals for complex command input

### Phase 4 — Knowledge Base
12. Forum channel integration with auto-tagging
13. Snippet storage and retrieval
14. `/standup` command (24h commit summary)

---

## Key Discord API Constraints to Design Around

| Constraint | Value | Implication |
|---|---|---|
| Max message length | 2000 chars | Chunk long responses; use threads for continuation |
| Max embed fields | 25 | Split large PR reviews across multiple embeds |
| Message edit rate limit | ~5/sec | Edit every 1s or 150 chars minimum |
| Slash command response timeout | 3 seconds | Always `defer()` before any LLM call |
| Typing indicator timeout | 10 seconds | Loop `trigger_typing()` every 8s |
| Components V2 max components | 40 | Plan layout carefully for complex cards |
| TextDisplay max chars | 4000 total | Split across multiple TextDisplay components |
| Autocomplete max choices | 25 | Filter to top 25 matches |
| Buttons per ActionRow | 5 | Max 5 buttons in a row, up to 5 rows = 25 buttons |
| Thread member limit | 1000 | Not a real constraint for dev teams |
| Active threads per guild | Limited (Discord-managed) | Archive completed sessions promptly |

---

## Notes for Claude Code

- All examples use `discord.py` 2.6+ API (current as of late 2025)
- Components V2 requires `discord.py >= 2.6` — use `discord.ui.LayoutView` instead of `discord.ui.View` for V2 layouts
- The streaming pattern works with both Anthropic's streaming SDK and Groq's OpenAI-compatible streaming endpoint
- Context menus register as `@bot.message_command()` or `@bot.user_command()` — separate from slash commands
- Modals can only be triggered from slash commands or button clicks — not from `on_message` events
- Thread creation requires the `CREATE_PUBLIC_THREADS` permission
- Forum channel bot interaction requires `MANAGE_THREADS` for tag management
- `defer()` must be called within 3 seconds of receiving an interaction or Discord shows an error to the user
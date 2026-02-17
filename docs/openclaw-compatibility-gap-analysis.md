# OpenClaws Gateway — Full Feature Mapping

Every OpenClaws gateway feature mapped against Lobu, with status and alternatives.

## Legend

| Status | Meaning |
|--------|---------|
| **HAVE** | Lobu already has this |
| **REQUIRED** | Must implement for OpenClaws compatibility |
| **NICE-TO-HAVE** | Useful but not blocking; implement when time allows |
| **SKIP** | Not needed — we have a better alternative or it doesn't fit our architecture |

---

## 1. Workspace Bootstrap Files

OpenClaws loads 8 markdown files from `~/.openclaw/workspace/` at session start into the system prompt. Per-file max 20KB, total max 150KB. Frontmatter stripped.

| # | Feature | OpenClaws | Lobu | Status | Alternative |
|---|---------|-----------|------|--------|-------------|
| 1.1 | **AGENTS.md** — Agent instructions, coding conventions | Loaded from workspace dir, user-editable | `InstructionProvider` system, not user-editable markdown | **HAVE (partial)** | Agent settings page allows some config. Could add a free-text instructions field. |
| 1.2 | **SOUL.md** — Agent persona, tone, boundaries | Loaded every session. Defines personality. | Nothing equivalent | **REQUIRED** | Add `soulMd` text field to agent settings. Inject via `SoulInstructionProvider`. |
| 1.3 | **USER.md** — Per-user name, pronouns, timezone, notes | Per-user file giving agent continuity about the person | No per-user context | **REQUIRED** | Redis-backed per `{agentId}:{userId}`. Agent can read/write it. |
| 1.4 | **IDENTITY.md** — Name, emoji, creature, vibe, avatar | Used for message prefixes, reactions, UI | No agent identity beyond name | **NICE-TO-HAVE** | Simple name+emoji field in agent settings covers 90% of this. |
| 1.5 | **TOOLS.md** — Tool usage guidance (not availability) | User-editable tool tips | Hardcoded in instruction providers | **SKIP** | Fold into SOUL.md or agent instructions. Separate file adds no value. |
| 1.6 | **HEARTBEAT.md** — Idle behavior definition | Defines what agent does during heartbeat | "is running" status indicator | **SKIP** | Workers are ephemeral (scale to zero). No persistent heartbeat. |
| 1.7 | **BOOTSTRAP.md** — Extra session start instructions | Organizational separation from AGENTS.md | No equivalent | **SKIP** | Fold into SOUL.md. |
| 1.8 | **MEMORY.md** — Curated long-term memory file | Loaded at session start, searchable | No memory system | **REQUIRED** | See Memory section below. |
| 1.9 | **Bootstrap size limits** — Per-file 20KB, total 150KB, frontmatter stripping | Prevents context bloat | No limits on instruction size | **REQUIRED** | Add truncation to instruction building when implementing 1.2/1.3/1.8. |

---

## 2. Memory System

OpenClaws has ~75 source files in `src/memory/`. This is the single biggest feature gap.

### 2.1 Architecture Overview

**Data flow:** User writes MEMORY.md → file watcher detects change → file chunked (256 tokens, 32 overlap) → chunks embedded (batch API) → stored in SQLite (chunks + chunks_fts + chunks_vec) → agent calls `memory_search(query)` → hybrid BM25+vector search → MMR reranking → results returned with path, line numbers, snippets.

**Database schema:** 4 tables — `meta` (sync state), `files` (path + hash for change detection), `chunks` (id, path, start_line, end_line, text, embedding), `embedding_cache` (LRU cache keyed by hash).

**Virtual tables:** `chunks_fts` (FTS5 for BM25 full-text search), `chunks_vec` (sqlite-vec for cosine similarity).

| # | Feature | OpenClaws | Lobu | Status | Notes |
|---|---------|-----------|------|--------|-------|
| 2.1 | **memory_search tool** | Hybrid search: FTS5 BM25 + vector cosine similarity. Returns `{path, startLine, endLine, score, snippet, source, citation}`. System prompt mandates: "Before answering about prior work, decisions, preferences — run memory_search." | Nothing | **REQUIRED** | Phase 1: File-based grep search. Phase 2: SQLite FTS5. Phase 3: Vector embeddings. Expose as MCP tool. |
| 2.2 | **memory_get tool** | Read specific lines from memory file by `{path, from?, lines?}`. Safe path validation (must be .md, no symlinks, within workspace). | Nothing | **REQUIRED** | Paired with memory_search. Simple file read with line slicing. |
| 2.3 | **FTS5 BM25 search** | SQLite FTS5. Query: quoted tokens joined with AND. Score: `1 / (1 + abs(bm25_rank))`. Per-keyword search with result merging. | Nothing | **REQUIRED** (Phase 2) | SQLite FTS5 is lightweight and needs no API keys. Good enough alone. |
| 2.4 | **Vector embeddings** | OpenAI text-embedding-3-large (3072d), Gemini text-embedding-004 (768d), Voyage voyage-3 (1024d), local node-llama. Batch API with retry. LRU embedding cache. | Nothing | **NICE-TO-HAVE** (Phase 3) | FTS5 alone handles 80% of use cases. Vectors add semantic matching. |
| 2.5 | **Hybrid merge** | `score = vectorWeight × vectorScore + textWeight × textScore`. Default weights 0.5/0.5. Union by chunk ID. | Nothing | **NICE-TO-HAVE** (Phase 3) | Only matters when vectors are added. |
| 2.6 | **MMR reranking** | Maximal Marginal Relevance. `MMR = λ × relevance - (1-λ) × max_jaccard_similarity_to_selected`. Default λ=0.7. Greedy iterative selection for diverse results. | Nothing | **NICE-TO-HAVE** (Phase 3) | Prevents redundant results (3 chunks from same section). |
| 2.7 | **Temporal decay** | `score' = score × e^(-λ × ageInDays)` where `λ = ln(2) / halfLifeDays`. Dated filenames parsed (memory/2024-12-15.md). MEMORY.md = evergreen (no decay). | Nothing | **NICE-TO-HAVE** | Simple to implement: check file mtime or parse filename date. |
| 2.8 | **File sync** | chokidar file watcher, hash-based change detection, debounced sync (1s). Triggers: file change, session start, before search, periodic (60 min). | Nothing | **REQUIRED** | At minimum: sync on session start and before search. |
| 2.9 | **Atomic reindex** | Creates temp DB, seeds embedding cache from old DB, indexes all files, atomic swap (rename), deletes old. Never corrupts live DB. | Nothing | **NICE-TO-HAVE** | Important for production reliability but not for v1. |
| 2.10 | **Session transcript indexing** | Optionally indexes conversation transcripts into memory DB. Source: "sessions". Delta-based sync (N bytes or N messages). | Nothing | **NICE-TO-HAVE** | Powerful for continuity but adds complexity. |
| 2.11 | **Context compaction memory flush** | Before context window compacted, agent writes durable memories to MEMORY.md. Prevents knowledge loss on long conversations. | Nothing | **REQUIRED** | System prompt instruction: "Before context is compacted, write important facts to MEMORY.md." |
| 2.12 | **Query expansion** | Converts conversational queries to keywords for FTS. "that thing about the API" → ["API"]. | Nothing | **NICE-TO-HAVE** | Improves FTS recall. Simple keyword extraction. |

---

## 3. Skills System

| # | Feature | OpenClaws | Lobu | Status | Alternative |
|---|---------|-----------|------|--------|-------------|
| 3.1 | **SKILL.md format** — Rich metadata | `name`, `description`, `user-invocable`, `disable-model-invocation`, `command-dispatch`, `command-tool`, plus `metadata.openclaw` block: `requires` (bins/anyBins/env/config), `primaryEnv`, `os`, `always`, `emoji`, `homepage`, `skillKey`, `install` specs | Simple `name`, `description` only | **REQUIRED** | Extend `parseSkillContent()` to parse full metadata. |
| 3.2 | **Progressive disclosure** | Only skill name+description in prompt (~100 tokens each). Model reads full SKILL.md on demand via `read` tool. XML `<available_skills>` list. Budget: max 150 skills, ~30KB. | Full SKILL.md content dumped into prompt for every enabled skill | **REQUIRED** | Current approach doesn't scale past 5-10 skills. Switch to metadata-only listing. |
| 3.3 | **Multi-source local loading** | 5 sources with precedence: workspace/skills/ > ~/.openclaw/skills > bundled > ~/.agents/skills > project/.agents/skills. File watcher for hot-reload. | GitHub-only fetching | **NICE-TO-HAVE** | Support `workspace/skills/` loading for worker-local skills. |
| 3.4 | **Eligibility gates** | OS check, binary existence, env var check, config path check, `always` override | All enabled skills included | **NICE-TO-HAVE** | Parse `requires` metadata. Check env/OS. Skip binary checks (workers sandboxed). |
| 3.5 | **Skill slash commands** | Auto-generates `/<skill-name>` from `user-invocable: true`. `command-dispatch: tool` for direct tool invocation. | No skill commands | **NICE-TO-HAVE** | More relevant for CLI/IDE than messaging. Could add for power users. |
| 3.6 | **Per-skill env injection** | Skills require env vars/API keys. Config provides per-skill `apiKey` and `env` overrides, injected at runtime, scoped per-agent-run. | Workers get global env only | **NICE-TO-HAVE** | Add skill env config to agent settings. |
| 3.7 | **ClawHub registry** | clawhub.com marketplace, 5700+ skills, versioned install, publish | skills.sh registry | **SKIP** | Both use SKILL.md format. Keep skills.sh, optionally add ClawHub as second source. |
| 3.8 | **Skill companion dirs** | `scripts/` (executable), `references/` (on-demand docs), `assets/` (templates). Progressive loading. | SKILL.md content only | **NICE-TO-HAVE** | Most popular skills are instruction-only. |
| 3.9 | **Per-agent skill filtering** | Agent config `skills: ["github", "slack"]` allowlist | Per-agent skills list in settings, enable/disable per skill | **HAVE** | Already implemented. |
| 3.10 | **Install specs** | Declarative: brew/node/go/uv/download per platform with binary names and archive formats | Manual | **SKIP** | Workers are sandboxed. Can't install system packages. Skills should be self-contained. |

---

## 4. Agent Tools (Exposed to Model)

### 4.1 Tools We Already Have

| # | OpenClaws Tool | Lobu Equivalent | Status |
|---|---------------|-----------------|--------|
| 4.1 | `read`, `write`, `edit`, `grep`, `find`, `ls` | Claude SDK built-in file tools | **HAVE** |
| 4.2 | `exec` (shell commands) | Claude SDK `Bash` tool | **HAVE** |
| 4.3 | `process` (background processes) | Claude SDK background process support | **HAVE** |
| 4.4 | `web_search` | Available via MCP (BrowseWeb) | **HAVE** |
| 4.5 | `web_fetch` | Available via MCP (BrowseWeb) | **HAVE** |
| 4.6 | `cron` (scheduled jobs) | `ScheduleReminder`/`CancelReminder`/`ListReminders` via BullMQ+Redis | **HAVE** |
| 4.7 | `tts` (text-to-speech) | `GenerateAudio` tool (OpenAI/Gemini/ElevenLabs) | **HAVE** |
| 4.8 | `image` (vision analysis) | Claude natively sees images in conversation | **HAVE (implicit)** |

### 4.2 Tools We Need

| # | OpenClaws Tool | What It Does | Status | Notes |
|---|---------------|--------------|--------|-------|
| 4.9 | `memory_search` | Search MEMORY.md + memory/*.md | **REQUIRED** | See Memory section. |
| 4.10 | `memory_get` | Read specific lines from memory file | **REQUIRED** | See Memory section. |

### 4.3 Tools We Don't Need

| # | OpenClaws Tool | What It Does | Status | Alternative |
|---|---------------|--------------|--------|-------------|
| 4.11 | `browser` | Playwright-based browser control (start/stop/navigate/screenshot/click/type/upload/dialogs) | **SKIP** | Vercel browser skill or browser MCP server. Not a gateway concern. |
| 4.12 | `canvas` | A2UI rendering — present/hide/navigate/eval/snapshot windows on paired nodes | **SKIP** | No companion devices. |
| 4.13 | `nodes` | Physical device control — camera/screen/location/notifications on iOS/Android/macOS | **SKIP** | No companion devices. |
| 4.14 | `gateway` | Gateway self-management — restart, config.get/apply/patch, update.run | **SKIP** | Workers shouldn't control the gateway. Admin API exists separately. |
| 4.15 | `sessions_spawn` | Spawn sub-agent in isolated session with different agent/model | **NICE-TO-HAVE** | Useful for complex multi-step tasks. Not blocking. |
| 4.16 | `sessions_send` | Send message to another session (cross-session messaging) | **NICE-TO-HAVE** | Requires multi-session architecture. |
| 4.17 | `sessions_list` | List sessions with filtering and last messages | **NICE-TO-HAVE** | Paired with sessions_send. |
| 4.18 | `sessions_history` | Fetch conversation history from another session | **NICE-TO-HAVE** | Paired with sessions_send. |
| 4.19 | `subagents` | List/kill/steer running sub-agent sessions | **NICE-TO-HAVE** | Only useful after sessions_spawn is implemented. |
| 4.20 | `session_status` | Current session usage, cost, model info, queue depth | **NICE-TO-HAVE** | Good for cost awareness. Simple to add. |
| 4.21 | `agents_list` | List agent IDs available for spawning | **NICE-TO-HAVE** | Only useful after sessions_spawn. |
| 4.22 | `apply_patch` | Multi-file patch format (*** Begin/End Patch markers) | **SKIP** | Claude SDK has `Edit` tool. Not needed. |
| 4.23 | `message` (40+ actions) | Cross-platform messaging: send, react, edit, delete, pin, search, polls, thread management, Discord guild ops, moderation | **NICE-TO-HAVE** | Our platform adapters handle response delivery. Agent-initiated messaging (proactive sends, reactions) would be an enhancement. |

---

## 5. Message Processing Pipeline

| # | Feature | OpenClaws | Lobu | Status | Alternative |
|---|---------|-----------|------|--------|-------------|
| 5.1 | **Draft streaming** | Throttled partial response streaming to chat. Sends/edits messages progressively (100ms throttle). | `ResponseRenderer` with `handleDelta()` — Slack streams via message edits, WhatsApp/Telegram buffer until completion | **HAVE** | Already implemented per-platform. |
| 5.2 | **Message chunking** | Smart splitting: "length" mode (hard limit) and "newline" mode (paragraph boundaries). Markdown-aware — doesn't break code fences. Per-provider limits. | Slack block builder handles code blocks. Platform-specific formatting. | **HAVE (partial)** | Could improve: add newline-aware chunking and configurable per-platform limits. |
| 5.3 | **Inbound debounce** | Buffers rapid messages, flushes together. Per-thread debouncing. Configurable per channel. | Message consumer processes messages sequentially per thread via BullMQ queue | **HAVE (different)** | BullMQ queue naturally serializes per-thread. Not identical but achieves same goal. |
| 5.4 | **Command detection** | `/stop`, `/model`, `/think`, `/status`, `/verbose`, skill commands. Inline directive parsing. | No slash commands in chat | **NICE-TO-HAVE** | `/stop` is most valuable. Others can be natural language. |
| 5.5 | **Reply tags** | `[[reply_to_current]]` and `[[reply_to:<id>]]` stripped before sending | Platform adapters reply to originating message by default | **HAVE (implicit)** | Already works. |
| 5.6 | **Link understanding** | Auto-detect URLs, run CLI tools to extract content, inject context before agent processes message. Per-channel scope. | No link preprocessing. Agent uses web tools on demand. | **NICE-TO-HAVE** | Saves a tool call but not critical. Workers with web_fetch handle it. |
| 5.7 | **Media understanding** | Pre-process images/audio/video before agent sees message. Multi-provider (Claude, GPT-4V, Gemini vision). Configurable per media type and channel scope. | STT for voice messages. Images passed to Claude directly. No video processing. | **HAVE (mostly)** | Images: Claude handles natively. Audio: STT implemented. Video: gap but niche. |
| 5.8 | **Mention gating** | Require @mention in groups, bypass for DMs and control commands. Platform-specific detection. | Telegram requires @mention in groups. WhatsApp has mention handling. | **HAVE** | Already implemented per-platform. |

---

## 6. Scheduling & Automation

| # | Feature | OpenClaws | Lobu | Status | Alternative |
|---|---------|-----------|------|--------|-------------|
| 6.1 | **Cron expressions** | 5-field cron, `at` (one-shot), `every` (interval) | BullMQ cron expressions + one-time reminders (1-1440 min) | **HAVE** | |
| 6.2 | **Delivery modes** | Announce (post to channel), webhook, none | Runs in existing session, posts to thread | **HAVE (partial)** | No webhook mode. Minor gap. |
| 6.3 | **Isolated execution** | Cron can run in clean agent session (isolated from main) | All reminders run in existing thread session | **NICE-TO-HAVE** | Would need new worker spawning for cron. |
| 6.4 | **Job persistence** | JSON file (`~/.openclaw/cron/jobs.json`) | Redis via BullMQ | **HAVE** | Redis is better than JSON file. |
| 6.5 | **Active hours** | Skip execution outside configured time windows | Not implemented | **NICE-TO-HAVE** | Simple time check before job execution. |
| 6.6 | **CLI management** | `openclaw cron add/list/remove` | API routes + worker tools only | **HAVE (different)** | Agent tools + API cover the use case. |

---

## 7. Platform Channels

| # | Platform | OpenClaws | Lobu | Status | Alternative |
|---|----------|-----------|------|--------|-------------|
| 7.1 | Slack | Plugin | Built-in module | **HAVE** | |
| 7.2 | WhatsApp | Plugin | Built-in module | **HAVE** | |
| 7.3 | Telegram | Plugin | Built-in module (Grammy, long-polling) | **HAVE** | |
| 7.4 | Discord | Plugin (full guild management, voice, moderation, roles, events, components) | Not implemented | **NICE-TO-HAVE** | High-value addition. |
| 7.5 | Signal | Plugin | Not implemented | **NICE-TO-HAVE** | Niche. |
| 7.6 | iMessage | Plugin (via BlueBubbles) | Not implemented | **SKIP** | Requires macOS host or BlueBubbles server. Very niche. |
| 7.7 | IRC | Plugin | Not implemented | **SKIP** | Niche. |
| 7.8 | LINE | Plugin | Not implemented | **SKIP** | Regional (Japan/Asia). |
| 7.9 | Matrix | Plugin | Not implemented | **SKIP** | Niche. |
| 7.10 | Mattermost | Plugin | Not implemented | **SKIP** | Niche. |
| 7.11 | MS Teams | Plugin | Not implemented | **NICE-TO-HAVE** | Enterprise value. |
| 7.12 | Google Chat | Plugin | Not implemented | **SKIP** | Low adoption. |
| 7.13 | Web Chat | Built-in | Not implemented | **NICE-TO-HAVE** | Public endpoint exists in gateway. Could add web UI. |
| 7.14 | Bluesky | Plugin | Not implemented | **SKIP** | Social media, not messaging. |

---

## 8. Exec & Security

| # | Feature | OpenClaws | Lobu | Status | Alternative |
|---|---------|-----------|------|--------|-------------|
| 8.1 | **Exec approval system** | Three-tier: deny / allowlist / full. Ask modes: off / on-miss / always. Safe binary auto-approval (jq, grep, sort, etc). Socket-based approval communication. Per-agent overrides. | Claude SDK handles tool approval. Anthropic Sandbox Runtime for OS isolation. | **HAVE (different)** | Claude SDK has its own tool approval flow. Sandbox Runtime provides OS-level isolation. Different but equivalent. |
| 8.2 | **Sandbox modes** | Docker with fine-grained controls: read-only root, tmpfs, capability dropping, seccomp, AppArmor, memory/CPU/PID limits | Anthropic Sandbox Runtime + Docker containers + K8s pods with resource limits | **HAVE** | Our sandboxing is production-grade. |
| 8.3 | **Elevated exec** | Escalation: sandboxed → elevated (host exec with approval). Toggle with `/elevated on/off/ask/full`. | Not implemented (workers always sandboxed) | **SKIP** | Workers should never escape sandbox. Security by design. |
| 8.4 | **Tool allowlists/denylists** | Per-agent, per-channel, global. Tool profiles: minimal/coding/messaging/full. | Per-agent tool config in settings | **HAVE (partial)** | Could add tool profiles preset. |

---

## 9. Session & Routing

| # | Feature | OpenClaws | Lobu | Status | Alternative |
|---|---------|-----------|------|--------|-------------|
| 9.1 | **DM scope modes** | `main` (one session for all DMs), `per-peer` (per user), `per-channel-peer` | One session per thread/conversation | **HAVE (different)** | Per-thread model works for messaging platforms. |
| 9.2 | **Binding-based routing** | Tiered: peer > parent-peer > guild+roles > guild > team > account > channel > default. Maps binding → agent. | Route by agent per channel/team | **NICE-TO-HAVE** | Multi-agent per-user routing could be added later. |
| 9.3 | **Sub-agent sessions** | `sessions_spawn` + `sessions_send` + `subagents` for managing child runs | Each thread = one worker session | **NICE-TO-HAVE** | Useful for complex orchestration. |
| 9.4 | **Session cost tracking** | Per-session: input/output tokens, cache tokens, per-model costs, tool counts, latency, per-day aggregation | No cost tracking | **NICE-TO-HAVE** | Important for billing. Add token counting to worker responses. |
| 9.5 | **Session archival** | Archive inactive sessions with history preservation | PVC cleanup after thread inactivity | **HAVE (different)** | We clean up, they archive. Both handle inactive sessions. |
| 9.6 | **Sender identity** | Cross-platform identity validation (ID, name, username, E164 phone). Group chats require at least one identifier. | Platform-specific user extraction | **HAVE** | Already extract sender per platform. |
| 9.7 | **Conversation labels** | Priority: explicit label > thread label > sender name > channel/subject. Auto-appends ID suffix. | Thread identified by platform ID | **NICE-TO-HAVE** | Cosmetic improvement for thread naming. |

---

## 10. Configuration & Management

| # | Feature | OpenClaws | Lobu | Status | Alternative |
|---|---------|-----------|------|--------|-------------|
| 10.1 | **Config file** | `~/.openclaw/openclaw.json` — YAML/JSON with env var substitution, includes, schema validation, legacy migration | `.env` file + agent settings in Redis | **HAVE (different)** | .env + Redis is simpler. No migration needed. |
| 10.2 | **Hot config reload** | chokidar file watcher, per-component reload (hooks, channels, cron, heartbeat, browser). Debounced 300ms. | Gateway restarts on .env change. `bun --watch` for dev. | **HAVE (partial)** | Hot reload of agent settings works. .env requires restart. |
| 10.3 | **Model aliases** | Short names for models (e.g., "opus" → "anthropic/claude-opus-4-6") | Direct model names | **NICE-TO-HAVE** | Convenience feature. |
| 10.4 | **Model override** | `/model gpt-4` command to switch models mid-conversation | Not implemented | **NICE-TO-HAVE** | Would require command detection first. |
| 10.5 | **Thinking/reasoning modes** | Levels: off/minimal/low/medium/high/xhigh. Display: off/tokens/full. Streaming reasoning. | Claude's extended thinking via API | **HAVE (partial)** | Claude SDK controls thinking. No user-facing toggle. |

---

## 11. Communication Architecture

| # | Feature | OpenClaws | Lobu | Status | Alternative |
|---|---------|-----------|------|--------|-------------|
| 11.1 | **WebSocket control plane** | WS RPC server (ws://127.0.0.1:18789), 90+ methods, broadcast events, presence tracking, auth challenge | HTTP REST + SSE + BullMQ queues | **SKIP** | Different architecture. Our multi-service design uses queues. |
| 11.2 | **OpenAI-compatible API** | `POST /v1/chat/completions` drop-in endpoint | No API compatibility layer | **SKIP** | We're a messaging gateway, not an LLM proxy. Use LiteLLM if needed. |
| 11.3 | **Node pairing** | Application-level device trust + capability auth on top of network transport | No companion devices | **SKIP** | Server-side only. Headscale handles network-level auth. |
| 11.4 | **TUI dashboard** | Interactive terminal UI with session management, command handling, themes | No TUI | **SKIP** | We use messaging platforms as the UI. |
| 11.5 | **Control UI** | Browser-based dashboard for agents, sessions, config | Settings web page | **SKIP** | Messaging platforms are our primary interface. |

---

## 12. Hooks & Extensibility

| # | Feature | OpenClaws | Lobu | Status | Alternative |
|---|---------|-----------|------|--------|-------------|
| 12.1 | **Hook system** | HOOK.md format. 4 event types: command/session/agent/gateway. Bundled hooks: session-memory, bootstrap-extra-files, boot-md, command-logger. | No hooks | **NICE-TO-HAVE** | `InstructionProvider` pattern covers agent:bootstrap. Other hooks could be added incrementally. |
| 12.2 | **Plugin SDK** | `registerTool/Hook/HttpHandler/Channel/GatewayMethod/Command/Service/Provider`. NPM-based install. 39+ extensions. | No plugin system. Built-in platform modules. | **SKIP** | MCP servers are our extensibility layer for tools. Platform modules are built-in. |
| 12.3 | **Channel plugins** | Each platform is a plugin with standardized adapters (messaging, auth, config, streaming, threading, etc.) | Built-in modules per platform in gateway | **HAVE (different)** | Same pattern, different packaging. |

---

## 13. Audio, Media & TTS

| # | Feature | OpenClaws | Lobu | Status |
|---|---------|-----------|------|--------|
| 13.1 | **Speech-to-text** | Whisper, Deepgram | OpenAI Whisper, Gemini, ElevenLabs. Auto-transcribes WhatsApp voice. | **HAVE** |
| 13.2 | **Text-to-speech** | ElevenLabs, Edge TTS | OpenAI, Gemini, ElevenLabs. `GenerateAudio` tool. Voice messages on WhatsApp. | **HAVE** |
| 13.3 | **Vision/image** | `image` tool with multi-provider (Claude, GPT-4V, Gemini) | Claude sees images natively in conversation | **HAVE (implicit)** |
| 13.4 | **Video understanding** | Frame extraction, transcription, multi-provider | Videos extracted but no processing | **NICE-TO-HAVE** |
| 13.5 | **Media scoping** | Per-channel, per-chat-type (DM vs group) enable/disable | Global enable/disable per provider | **NICE-TO-HAVE** |

---

## 14. Other Features

| # | Feature | OpenClaws | Lobu | Status | Alternative |
|---|---------|-----------|------|--------|-------------|
| 14.1 | **Reactions** | Per-channel guidance (minimal/extensive). Agent can add emoji reactions. | Telegram reactions partially supported | **NICE-TO-HAVE** | Add configurable reaction guidance to system prompt. |
| 14.2 | **Polls** | `message` tool `action=poll` | No polls | **NICE-TO-HAVE** | Low priority. |
| 14.3 | **llms.txt** | Check `/llms.txt` and `/.well-known/llms.txt` on URLs | Not implemented | **NICE-TO-HAVE** | One-line system prompt addition when web tools available. |
| 14.4 | **Human delay** | Configurable typing speed simulation | No delay | **SKIP** | Users know it's a bot. |
| 14.5 | **Provider usage tracking** | Fetch quota from Anthropic/OpenAI/Gemini APIs. Show remaining %. Reset times. | No usage tracking | **NICE-TO-HAVE** | Display: "📊 Anthropic 42% left (resets 2d 14h)". |
| 14.6 | **Channel capabilities** | Channels declare supported features (inline buttons, file upload, threading, message edit) | Platform-specific hardcoded capabilities | **HAVE (implicit)** | Each platform adapter knows its capabilities. Could formalize. |
| 14.7 | **Browser automation** | Playwright-based with CDP, profiles, tabs, snapshots, sandbox bridge | No built-in browser | **SKIP** | Use Vercel browser skill or browser MCP. |
| 14.8 | **Canvas/A2UI** | Real-time UI rendering via WebSocket with file watching | Not applicable | **SKIP** | No companion devices. |

---

## Implementation Roadmap

### Phase 1: Core Compatibility

| Priority | Feature | Effort | Impact |
|----------|---------|--------|--------|
| **P0** | SOUL.md — Agent persona field in settings + instruction provider | Small | High — gives agents personality |
| **P0** | USER.md — Per-user context in Redis + instruction provider | Medium | High — cross-conversation continuity |
| **P0** | MEMORY.md + memory_search/memory_get tools (file-based grep) | Medium | Critical — biggest gap |
| **P0** | Progressive skill disclosure — metadata-only prompt, on-demand read | Medium | High — enables scaling to 50+ skills |
| **P0** | Rich SKILL.md parsing — full OpenClaws metadata format | Small | Required for skill compatibility |
| **P0** | Instruction size limits — per-section and total char budgets | Small | Prevents context bloat |

### Phase 2: Enhanced Features

| Priority | Feature | Effort | Impact |
|----------|---------|--------|--------|
| **P1** | Memory FTS5 — SQLite full-text search for memory | Medium | High — better search quality |
| **P1** | Context compaction memory flush — write memories before compaction | Small | High — prevents knowledge loss |
| **P1** | Session cost tracking — token counting per worker | Medium | High — billing/cost awareness |
| **P1** | Command detection — `/stop` at minimum | Small | Medium — user control |
| **P1** | Local workspace skills — scan workspace/skills/ at session start | Small | Medium — power user feature |
| **P1** | Skill eligibility gates — OS/env checks from metadata | Small | Medium — ClawHub compat |

### Phase 3: Extended Features

| Priority | Feature | Effort | Impact |
|----------|---------|--------|--------|
| **P2** | Vector embeddings for memory — multi-provider semantic search | Large | Medium — semantic matching |
| **P2** | MMR reranking + temporal decay | Medium | Medium — search quality |
| **P2** | Discord channel | Large | Medium — community demand |
| **P2** | Sub-agent spawning — sessions_spawn/send | Large | Medium — complex orchestration |
| **P2** | Reactions guidance — configurable per-channel | Small | Low |
| **P2** | Model override command — `/model` | Small | Low |
| **P2** | Video understanding | Medium | Low |
| **P2** | Link understanding | Medium | Low |
| **P2** | Per-skill env injection | Small | Low |
| **P2** | Skill slash commands | Small | Low |
| **P2** | Session transcript indexing | Medium | Low |
| **P2** | MS Teams channel | Large | Medium — enterprise |
| **P2** | Provider usage tracking | Small | Low |
| **P2** | Active hours for cron | Small | Low |

### Skip (Architecture Mismatch)

| Feature | Reason |
|---------|--------|
| WebSocket control plane | We use HTTP + BullMQ queues |
| Node pairing | No companion devices. Headscale for network auth. |
| OpenAI-compatible API | We're a messaging gateway, not an LLM proxy |
| Plugin SDK | MCP servers are our extensibility layer |
| Browser automation | Use Vercel browser skill |
| Canvas/A2UI | No companion devices |
| TUI dashboard | Messaging platforms are the UI |
| Control UI dashboard | Settings page covers it |
| Elevated exec | Workers should never escape sandbox |
| Human delay simulation | Users know it's a bot |
| iMessage/IRC/LINE/Matrix/Mattermost/Google Chat/Bluesky | Too niche |
| TOOLS.md / HEARTBEAT.md / BOOTSTRAP.md | Fold into SOUL.md or agent instructions |
| Install specs for skills | Workers are sandboxed, can't install system packages |
| apply_patch tool | Claude SDK has Edit tool |

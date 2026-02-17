# OpenClaws Gateway Compatibility Gap Analysis

Comprehensive feature-by-feature comparison between OpenClaws gateway and Lobu gateway.
Each feature is marked with priority and whether we already have it, need it, or can skip it.

## Legend

| Status | Meaning |
|--------|---------|
| **HAVE** | Lobu already has this (possibly with different implementation) |
| **REQUIRED** | Must implement for OpenClaws compatibility |
| **NICE-TO-HAVE** | Useful but not blocking; implement when time allows |
| **SKIP** | Not needed; we have a better alternative or it's not relevant to our architecture |

---

## 1. Bootstrap File System (Workspace Context)

OpenClaws loads 8 markdown files from `~/.openclaw/workspace/` at session start and injects them into the system prompt. Each serves a specific role.

### 1.1 AGENTS.md — Agent Instructions

| | |
|---|---|
| **OpenClaws** | Loaded from workspace dir. User-editable agent instructions, rules, coding conventions. |
| **Lobu** | We have `InstructionProvider` system with platform/network/skills providers. No user-editable AGENTS.md equivalent per workspace. |
| **Status** | **HAVE (partial)** — Our instruction providers serve the same purpose but aren't user-editable markdown files. Agent settings page allows some config. |
| **Gap** | No file-based workspace instructions that users can directly edit. |

### 1.2 SOUL.md — Agent Persona/Identity

| | |
|---|---|
| **OpenClaws** | Defines agent personality, tone, communication style, boundaries. Loaded every session. Example: "You are a helpful but snarky coding assistant who prefers functional programming." |
| **Lobu** | Nothing equivalent. |
| **Status** | **REQUIRED** |
| **Implementation** | Add a `soulMd` field to agent settings. Store as markdown text. Inject via new `SoulInstructionProvider` at high priority (early in prompt). Users edit via settings page. |

### 1.3 USER.md — Per-User Context/Preferences

| | |
|---|---|
| **OpenClaws** | Per-user file with name, pronouns, timezone, preferences, notes. Gives agent continuity about the *person* across conversations. |
| **Lobu** | No per-user memory or context. |
| **Status** | **REQUIRED** |
| **Implementation** | Store per-user markdown in Redis or agent settings keyed by `{agentId}:{userId}`. Inject via `UserContextProvider`. Users can edit via settings or the agent itself can update it. |

### 1.4 IDENTITY.md — Agent Visual Identity

| | |
|---|---|
| **OpenClaws** | Structured fields: Name, Emoji, Creature, Vibe, Theme, Avatar URL. Used for message prefixes, reactions, UI rendering. |
| **Lobu** | No agent identity system beyond name. |
| **Status** | **NICE-TO-HAVE** |
| **Alternative** | Agent name/emoji could be a simple field in agent settings. Full IDENTITY.md structure is overkill for messaging platforms. |

### 1.5 MEMORY.md + memory/*.md — Long-Term Memory

| | |
|---|---|
| **OpenClaws** | Curated `MEMORY.md` + daily append-only `memory/YYYY-MM-DD.md` logs. Backed by SQLite with FTS5 + vector embeddings. Hybrid search (BM25 + vectors + MMR reranking). Multiple embedding providers (OpenAI, Gemini, Voyage, local llama). `memory_search` and `memory_get` tools available to agents. Session transcripts optionally indexed. Memory flush before context compaction. ~75 source files in `src/memory/`. |
| **Lobu** | No memory system at all. |
| **Status** | **REQUIRED** — This is the single biggest gap. |
| **Implementation** | Phase 1: File-based MEMORY.md per agent/workspace (simple grep search). Phase 2: SQLite FTS5 for full-text search. Phase 3: Vector embeddings (optional). Expose `memory_search` and `memory_get` as worker tools. |

### 1.6 TOOLS.md — Tool Usage Guidance

| | |
|---|---|
| **OpenClaws** | User-editable file describing how to use external tools (not tool availability, just guidance). |
| **Lobu** | No equivalent. Tool instructions are hardcoded in instruction providers. |
| **Status** | **NICE-TO-HAVE** |
| **Alternative** | Can be folded into SOUL.md or AGENTS.md as a section. No need for a separate file. |

### 1.7 HEARTBEAT.md — Idle Behavior

| | |
|---|---|
| **OpenClaws** | Defines what agent does during heartbeat/idle cycles. Configurable heartbeat intervals. |
| **Lobu** | We have "is running" status indicator with rotating messages, but no configurable idle behavior. |
| **Status** | **SKIP** — Different architecture. Lobu workers are ephemeral (scale to zero), not persistent. Heartbeat doesn't apply. |

### 1.8 BOOTSTRAP.md — Session Start Instructions

| | |
|---|---|
| **OpenClaws** | Extra instructions loaded at session bootstrap. Separate from AGENTS.md for organizational purposes. |
| **Lobu** | No equivalent. |
| **Status** | **SKIP** — Can be folded into SOUL.md or agent instructions. Separate file adds complexity without clear benefit for our architecture. |

### 1.9 Bootstrap Loading with Limits

| | |
|---|---|
| **OpenClaws** | Loads all workspace files with intelligent truncation: per-file max 20KB, total max 150KB. Strips frontmatter before injection. |
| **Lobu** | No file loading limits. Skills content dumped fully. |
| **Status** | **REQUIRED** (when implementing SOUL.md/USER.md/MEMORY.md) |
| **Implementation** | Add truncation limits to instruction building. Apply per-section and total character budget. |

---

## 2. Skills System

### 2.1 Skill Format (SKILL.md)

| | |
|---|---|
| **OpenClaws** | Rich YAML frontmatter: `name`, `description`, `user-invocable`, `disable-model-invocation`, `command-dispatch`, `command-tool`, `command-arg-mode`, plus `metadata.openclaw` block with `requires` (bins, anyBins, env, config), `primaryEnv`, `os`, `always`, `emoji`, `homepage`, `skillKey`, `install` specs. |
| **Lobu** | Simple frontmatter: `name`, `description` only. |
| **Status** | **REQUIRED** — Need to parse the full OpenClaws metadata format for compatibility with ClawHub skills. |
| **Implementation** | Extend `parseSkillContent()` in `skills-fetcher.ts` to parse full OpenClaws metadata. Use for eligibility gates. |

### 2.2 Progressive Disclosure (Token Efficiency)

| | |
|---|---|
| **OpenClaws** | Only skill name + description in prompt (~100 tokens each). Model reads full SKILL.md on demand via `read` tool when it decides to use a skill. XML-formatted `<available_skills>` list. Budget: max 150 skills, ~30KB prompt chars. |
| **Lobu** | Dumps full SKILL.md content into prompt for every enabled skill. No token budget. |
| **Status** | **REQUIRED** — Current approach doesn't scale past 5-10 skills. |
| **Implementation** | Switch to metadata-only listing in prompt. Store full skill content in workspace files that agent can read on demand. Add configurable token budget. |

### 2.3 Multi-Source Local Skill Loading

| | |
|---|---|
| **OpenClaws** | 5 load sources with precedence: workspace/skills/ > ~/.openclaw/skills > bundled > ~/.agents/skills > project/.agents/skills. Extra dirs via config. File watcher for hot-reload. |
| **Lobu** | Skills fetched only from GitHub. No local skill loading. |
| **Status** | **NICE-TO-HAVE** — Workers already have workspace dirs. Could support `workspace/skills/` loading. |
| **Implementation** | Scan worker workspace for `skills/*/SKILL.md` at session start. Merge with remotely configured skills. |

### 2.4 Skill Eligibility Gates

| | |
|---|---|
| **OpenClaws** | OS check, binary existence (`hasBinary`), env var check, config path check, `always` override. All gates must pass for skill to be available. |
| **Lobu** | No eligibility checking. All enabled skills are included. |
| **Status** | **NICE-TO-HAVE** — Most skills from ClawHub are instruction-based and don't need binary gates. |
| **Implementation** | Parse `requires` metadata. Check env vars and OS at skill load time. Skip binary checks (workers are sandboxed). |

### 2.5 Skill Commands (Slash Commands)

| | |
|---|---|
| **OpenClaws** | Auto-generates `/<skill-name>` commands from `user-invocable: true` skills. Supports `command-dispatch: tool` for direct tool invocation. |
| **Lobu** | No skill-based commands. |
| **Status** | **NICE-TO-HAVE** |
| **Alternative** | Users interact via natural language on messaging platforms. Slash commands are more relevant for CLI/IDE. Could implement for power users later. |

### 2.6 Per-Skill Environment Injection

| | |
|---|---|
| **OpenClaws** | Skills can require env vars and API keys. Config provides per-skill `apiKey` and `env` overrides injected at runtime. Scoped per-agent-run. |
| **Lobu** | No per-skill env injection. Workers get global env vars only. |
| **Status** | **NICE-TO-HAVE** |
| **Implementation** | Add skill env config to agent settings. Inject into worker env at job creation. |

### 2.7 ClawHub Registry

| | |
|---|---|
| **OpenClaws** | ClawHub marketplace (clawhub.com) with search, versioned install, publish. 5,705+ skills. |
| **Lobu** | Uses skills.sh registry (API search + GitHub fetch). |
| **Status** | **SKIP** — skills.sh and ClawHub both work with SKILL.md format. Supporting both registries is fine. No need to switch. |
| **Alternative** | Keep skills.sh. Add ClawHub as second search source if needed. Both use SKILL.md. |

### 2.8 Skill Scripts/References/Assets Directories

| | |
|---|---|
| **OpenClaws** | Skills can bundle `scripts/` (executable code), `references/` (on-demand docs), `assets/` (templates). Progressive loading: references read only when needed. |
| **Lobu** | Only SKILL.md content. No bundled directories. |
| **Status** | **NICE-TO-HAVE** — Most popular skills are instruction-only. Script-heavy skills are rare. |
| **Implementation** | When loading from local workspace, support reading companion directories. For remote skills, fetch specific files on demand. |

### 2.9 Per-Agent Skill Filtering

| | |
|---|---|
| **OpenClaws** | Agent config has `skills: ["github", "slack"]` allowlist. Only listed skills available for that agent. |
| **Lobu** | Each agent has its own skills list in settings (`skillsConfig.skills`). Skills are enabled/disabled per agent. |
| **Status** | **HAVE** — Our per-agent skill config already does this. |

---

## 3. Memory System

### 3.1 memory_search Tool

| | |
|---|---|
| **OpenClaws** | Agent tool that searches MEMORY.md + memory/*.md + optional session transcripts. Hybrid search: FTS5 BM25 + vector cosine similarity + MMR reranking. Returns ranked snippets with file paths and line numbers. |
| **Lobu** | No memory search. |
| **Status** | **REQUIRED** |
| **Implementation** | Phase 1: Simple grep-based search over memory files. Phase 2: SQLite FTS5. Expose as MCP tool alongside existing UploadUserFile/AskUserQuestion. |

### 3.2 memory_get Tool

| | |
|---|---|
| **OpenClaws** | Reads specific lines from a memory file by path and line range. |
| **Lobu** | No equivalent. |
| **Status** | **REQUIRED** (paired with memory_search) |

### 3.3 Vector Embeddings

| | |
|---|---|
| **OpenClaws** | Multiple providers: OpenAI (`text-embedding-3-small`), Gemini, Voyage, local (node-llama). SQLite-vec extension. Batch embedding with retry/backoff. Cache layer. |
| **Lobu** | None. |
| **Status** | **NICE-TO-HAVE** — FTS5 is good enough for v1. Vectors are a Phase 3 enhancement. |

### 3.4 Memory Sync & Session Indexing

| | |
|---|---|
| **OpenClaws** | Auto-sync on file changes, session start, before search. Session transcripts optionally indexed into memory DB. File watcher with debounce. |
| **Lobu** | None. |
| **Status** | **NICE-TO-HAVE** for session indexing. **REQUIRED** for file sync (memory files must be indexed when changed). |

### 3.5 Context Compaction Memory Flush

| | |
|---|---|
| **OpenClaws** | Before context window is compacted, agent writes durable memories to MEMORY.md. Prevents knowledge loss. |
| **Lobu** | No compaction awareness. |
| **Status** | **REQUIRED** (for effective memory system) |
| **Implementation** | Instruction in system prompt: "Before context is compacted, write important facts to MEMORY.md." Claude SDK may support compaction hooks. |

---

## 4. Scheduling & Cron

| | |
|---|---|
| **OpenClaws** | Full cron system: `at` (one-shot), `every` (interval), `cron` (5-field expressions). Two execution models: main session (heartbeat) and isolated (clean agent run). Delivery modes: announce (post to channel), webhook, none. Persistent storage in `~/.openclaw/cron/jobs.json`. Retry with backoff. CLI management (`openclaw cron add/list/remove`). |
| **Lobu** | `ScheduledWakeupService` with BullMQ + Redis. One-time reminders (1-1440 min) and CRON expressions. Max 10 per deployment, 100 iterations. Worker tools: `ScheduleReminder`, `CancelReminder`, `ListReminders`. API routes for management. |
| **Status** | **HAVE** — Our implementation covers the core use cases. |
| **Gap** | No isolated execution mode (all reminders run in existing session). No webhook delivery mode. No CLI management (only API + agent tools). These are minor. |

---

## 5. Audio & Media

### 5.1 Speech-to-Text (Transcription)

| | |
|---|---|
| **OpenClaws** | Whisper, Deepgram integration. Multi-provider fallback. |
| **Lobu** | Multi-provider STT: OpenAI Whisper, Google Gemini, ElevenLabs. Auto-transcribes WhatsApp voice messages. Provider selection via `TRANSCRIPTION_PROVIDER` env. |
| **Status** | **HAVE** |

### 5.2 Text-to-Speech

| | |
|---|---|
| **OpenClaws** | ElevenLabs, Edge TTS. Voice responses. |
| **Lobu** | Multi-provider TTS: OpenAI, Gemini, ElevenLabs. `GenerateAudio` worker tool. Voice messages on WhatsApp. |
| **Status** | **HAVE** |

### 5.3 Vision / Image Understanding

| | |
|---|---|
| **OpenClaws** | `image` tool that analyzes images with configured vision model. |
| **Lobu** | Images are extracted from messages and passed to workers, but no explicit vision tool or instruction. Claude inherently handles images in conversation. |
| **Status** | **HAVE (implicit)** — Claude natively understands images in messages. No separate `image` tool needed since the model sees the image directly. |

### 5.4 Video Understanding

| | |
|---|---|
| **OpenClaws** | Video frame extraction, transcription. Multi-provider. |
| **Lobu** | Videos extracted from WhatsApp but no processing/understanding. |
| **Status** | **NICE-TO-HAVE** |
| **Alternative** | Could be implemented as a skill rather than core gateway feature. |

---

## 6. Link Understanding

| | |
|---|---|
| **OpenClaws** | Auto-detects URLs in messages, runs configurable CLI tools to extract content, injects context before agent processes the message. Configurable per-channel scope. Timeout handling. |
| **Lobu** | No link preprocessing. Agent can use web tools if available. |
| **Status** | **NICE-TO-HAVE** |
| **Alternative** | Workers with web_fetch MCP can read links on demand. Pre-processing saves a tool call but isn't critical. |

---

## 7. Hook System (Agent Lifecycle Events)

| | |
|---|---|
| **OpenClaws** | Event-driven hooks with HOOK.md format (like SKILL.md). 4 event types: `command`, `session`, `agent`, `gateway`. Sub-actions like `command:new`, `session:start`, `agent:bootstrap`. Hooks can modify bootstrap context, inject messages. Bundled hooks: `session-memory`, `bootstrap-extra-files`, `boot-md`, `command-logger`. Multi-source loading (bundled, managed, workspace, plugin). |
| **Lobu** | No hook system. |
| **Status** | **NICE-TO-HAVE** |
| **Alternative** | Our `InstructionProvider` pattern serves the `agent:bootstrap` use case. Other hooks (command processing, session lifecycle) could be added as needed. A full HOOK.md system is overengineered for our current scale. |

---

## 8. Plugin System

| | |
|---|---|
| **OpenClaws** | Full plugin SDK: `registerTool()`, `registerHook()`, `registerHttpHandler()`, `registerChannel()`, `registerGatewayMethod()`, `registerCommand()`, `registerService()`, `registerProvider()`. Channel plugins for each messaging platform. 39+ extensions. NPM-based installation. |
| **Lobu** | No plugin system. Platforms are built-in modules (Slack, WhatsApp, Telegram). |
| **Status** | **SKIP** |
| **Alternative** | Our dispatcher pattern (platform modules in gateway) works well. Plugins add complexity. MCP servers serve as our extensibility mechanism for tools. |

---

## 9. Communication & Routing

### 9.1 WebSocket Control Plane

| | |
|---|---|
| **OpenClaws** | WS RPC server (`ws://127.0.0.1:18789`) with 90+ methods. Broadcast events. Presence tracking. Auth challenge. Used by CLI, WebChat, macOS app, iOS/Android nodes. |
| **Lobu** | HTTP REST + SSE for worker communication. No WS control plane. |
| **Status** | **SKIP** |
| **Alternative** | Different architecture. Lobu uses HTTP APIs + message queues. WS control plane is for OpenClaws' single-process design. Our multi-service architecture doesn't need it. |

### 9.2 Binding-Based Routing

| | |
|---|---|
| **OpenClaws** | Tiered bindings: peer > parent-peer > guild+roles > guild > team > account > channel > default. Each binding maps to an agent. |
| **Lobu** | Routes by agent per channel/team. One agent per deployment. |
| **Status** | **NICE-TO-HAVE** |
| **Alternative** | Multi-agent routing per-user or per-channel could be added to our orchestration layer without adopting the full binding model. |

### 9.3 Sub-Agent / Multi-Agent Sessions

| | |
|---|---|
| **OpenClaws** | `sessions_spawn` tool for sub-agents. `sessions_list`, `sessions_history`, `sessions_send` for cross-session communication. `subagents` tool for managing child agent runs. |
| **Lobu** | No sub-agent spawning. Each thread = one worker session. |
| **Status** | **NICE-TO-HAVE** — Useful for complex tasks but not needed for OpenClaws compatibility. |

### 9.4 DM Scope Modes

| | |
|---|---|
| **OpenClaws** | `main` (one session for all DMs), `per-peer` (one session per user), `per-channel-peer` (per user per channel). |
| **Lobu** | One session per thread/conversation. WhatsApp self-chat mode. |
| **Status** | **HAVE (different model)** — Our per-thread model is effectively per-peer for WhatsApp/Telegram DMs. |

---

## 10. OpenAI-Compatible API

| | |
|---|---|
| **OpenClaws** | `POST /v1/chat/completions` endpoint. Streaming + non-streaming. Acts as a drop-in OpenAI API replacement so third-party tools (LangChain, IDE plugins, etc.) can use OpenClaws as their LLM backend. |
| **Lobu** | No API compatibility layer. |
| **Status** | **SKIP** |
| **Alternative** | Different use case. Lobu is a messaging-platform gateway, not an LLM API proxy. Users wanting an OpenAI-compatible endpoint should use LiteLLM or similar. |

---

## 11. Node Pairing

| | |
|---|---|
| **OpenClaws** | Companion device approval workflow. Nodes (iOS/Android/macOS) request pairing, gateway approves/rejects. Token-based auth. Separate from Tailscale (Tailscale = network transport, node pairing = application-level trust). |
| **Lobu** | No companion device concept. |
| **Status** | **SKIP** |
| **Alternative** | Lobu is server-side only. No client devices to pair. Users interact via messaging platforms. |

---

## 12. Browser Automation

| | |
|---|---|
| **OpenClaws** | Built-in Chrome DevTools Protocol integration. Browser tool with profiles, tab management, snapshots. Playwright. Sandbox browser bridge. |
| **Lobu** | No built-in browser. |
| **Status** | **SKIP** |
| **Alternative** | Vercel's `browser` agent skill or browser MCP server. Workers can install browser skills from ClawHub/skills.sh. No need for gateway-level browser integration. |

---

## 13. Other Features

### 13.1 Reactions (Emoji Responses)

| | |
|---|---|
| **OpenClaws** | Per-channel reaction guidance (minimal/extensive modes). Agent can react to messages with emojis. |
| **Lobu** | Telegram reactions partially supported. No configurable reaction guidance. |
| **Status** | **NICE-TO-HAVE** |

### 13.2 Reply Tags

| | |
|---|---|
| **OpenClaws** | `[[reply_to_current]]` and `[[reply_to:<id>]]` tags in agent responses. Stripped before sending. |
| **Lobu** | Workers reply to the originating message by default. |
| **Status** | **HAVE (implicit)** — Our platform adapters handle reply threading. |

### 13.3 Human Delay Simulation

| | |
|---|---|
| **OpenClaws** | Configurable typing speed simulation to appear more human. |
| **Lobu** | No delay simulation. |
| **Status** | **SKIP** — Unnecessary for our use case. Users know they're talking to a bot. |

### 13.4 Polls

| | |
|---|---|
| **OpenClaws** | Create polls via `message` tool with `action=poll`. |
| **Lobu** | No poll support. |
| **Status** | **NICE-TO-HAVE** |

### 13.5 llms.txt Discovery

| | |
|---|---|
| **OpenClaws** | When fetching URLs, checks for `/llms.txt` or `/.well-known/llms.txt` for AI interaction guidance. |
| **Lobu** | Not implemented. |
| **Status** | **NICE-TO-HAVE** — Simple instruction to add to system prompt when web tools are available. |

### 13.6 Control UI / Dashboard

| | |
|---|---|
| **OpenClaws** | Browser-based dashboard for managing agents, sessions, config. |
| **Lobu** | No dashboard. Settings via web page. |
| **Status** | **SKIP** — We use messaging platforms as the primary interface. |

### 13.7 Additional Channel Plugins

| | |
|---|---|
| **OpenClaws** | iMessage (BlueBubbles), Signal, IRC, Discord, Google Chat, Line, Matrix, Mattermost, MS Teams |
| **Lobu** | Slack, WhatsApp, Telegram |
| **Status** | **NICE-TO-HAVE** — Discord would be the highest value addition. Others are niche. |

---

## Implementation Priority Summary

### Phase 1: Core Compatibility (Required)

1. **SOUL.md** — Agent persona configuration (agent settings field + instruction provider)
2. **USER.md** — Per-user context/preferences (Redis-backed, per agent+user)
3. **MEMORY.md + memory tools** — Long-term memory with `memory_search` and `memory_get`
4. **Progressive skill disclosure** — Metadata-only in prompt, on-demand full content read
5. **Rich SKILL.md parsing** — Full OpenClaws metadata format support
6. **Instruction size limits** — Per-section and total character budgets

### Phase 2: Enhanced Features (Nice-to-Have, High Value)

7. **Local workspace skills** — Load skills from worker workspace directories
8. **Skill eligibility gates** — OS/env/binary checks from metadata
9. **Memory FTS5** — SQLite full-text search for memory
10. **Context compaction memory flush** — Write memories before compaction
11. **Link understanding** — Pre-process URLs in messages
12. **Reactions guidance** — Configurable per-channel reaction behavior

### Phase 3: Extended Features (Nice-to-Have, Lower Priority)

13. **Vector embeddings for memory** — Multi-provider semantic search
14. **Skill commands** — Auto-generated slash commands from skills
15. **Per-skill environment injection** — Skill-specific env vars/API keys
16. **Skill scripts/references/assets** — Companion directories
17. **Session memory indexing** — Index conversation transcripts
18. **Video understanding** — Frame extraction and analysis
19. **Sub-agent spawning** — Multi-agent sessions
20. **Discord channel** — Additional messaging platform

### Skip (Not Applicable to Lobu Architecture)

- WebSocket control plane (we use HTTP + queues)
- Node pairing (no companion devices)
- OpenAI-compatible API (we're not an LLM proxy)
- Plugin system (MCP servers are our extensibility layer)
- Browser automation (use browser skill instead)
- Heartbeat/idle behavior (workers are ephemeral)
- Human delay simulation
- Dashboard (messaging platforms are the UI)

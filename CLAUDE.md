<!-- Per-repo agent rules loaded into every Claude Code session in this repo. Inlines AGENTS.md (shared project rules) first, then layers local-only notes below. User memory entries live under ~/.claude/projects/.../memory/. -->

@AGENTS.md

## Lobu

The live Lobu MCP server, ClientSDK, sandbox, and tool registry are in `packages/server/` of this repo. Prod runs the bundled Node entry (`packages/server/dist/server.bundle.mjs`, built via `bun run build:server`) — same artifact that `lobu run` invokes. Any question about Lobu behavior — MCP tools, instructions, sandbox, SDK, auth — is answered from that path.

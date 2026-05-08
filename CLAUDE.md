@AGENTS.md

## Local-only references

- `../lobu` (i.e. `/Users/burakemre/Code/lobu`) is the Lobu source repo. The OpenClaw memory plugin published as `@lobu/openclaw-plugin` lives in `packages/openclaw-plugin` there.

## Lobu

The live Lobu MCP server, ClientSDK, sandbox, and tool registry are in `packages/server/` of this repo. Prod runs the bundled Node entry (`packages/server/dist/server.bundle.mjs`, built via `bun run build:server`) — same artifact that `lobu run` invokes. Any question about Lobu behavior — MCP tools, instructions, sandbox, SDK, auth — is answered from that path.

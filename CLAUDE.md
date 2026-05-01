@AGENTS.md

## Local-only references

- `../owletto` (i.e. `/Users/burakemre/Code/owletto`) is the Owletto source repo. The OpenClaw memory plugin published as `@lobu/openclaw-plugin` lives in `packages/openclaw-plugin` there.

## Owletto

The live Owletto MCP server, ClientSDK, sandbox, and tool registry are in `packages/server/` of this repo. Prod runs the bundled Node entry (`packages/server/dist/server.bundle.mjs`, built via `bun run build:server`) — same artifact that `lobu run` invokes. Any question about Owletto behavior — MCP tools, instructions, sandbox, SDK, auth — is answered from that path.

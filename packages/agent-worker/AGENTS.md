# Agent worker package agent rules

Read root `AGENTS.md` first. This package owns agent execution and OpenClaw integration.

## Boundaries
- Agent workers talk only to the gateway/agent APIs. They must not gain platform-specific knowledge or receive real credentials.
- Workers may receive `lobu_secret_<uuid>` placeholders; the gateway proxy performs credential substitution at egress.
- Worker sessions persist under `./workspaces/{agentId}/`.

## Providers, MCP, and tools
- Resolve model refs through provider settings/catalog data passed by the gateway. Do not hardcode provider credentials, base URLs, or model lists in worker code.
- Provider API keys are injected into in-memory auth storage only for the running session; do not write provider auth to disk.
- If the selected provider changes for a persisted session, preserve a system note and reset incompatible provider state rather than mixing provider histories.
- Workers discover MCP tools at startup and call them through the gateway proxy using JWT.
- MCP auth tools (`auth login|check|logout`) route through the gateway/device-auth flow; worker code should refresh MCP context after auth changes.
- Built-in OpenClaw tools are registered in `src/openclaw/custom-tools.ts` and use snake_case names.
- Past channel conversation is read through `search_memory`, which also scans `channel_messages`.

## Network and runtime
- Worker subprocesses use `HTTP_PROXY=http://localhost:8118`.
- `WORKER_ALLOWED_DOMAINS`: empty = no network by default; exact domains or `.wildcard`; `*` means allow all and is not for prod; combine with `WORKER_DISALLOWED_DOMAINS` for blocklist mode.
- Linux prod adds kernel network denial except loopback; risky domains may route through the LLM egress judge.
- SDK sandbox loads the per-Node-major `isolated-vm` optional native build dynamically in `sandbox/run-script.ts`; keep that exception unless there is a static equivalent.

## Validation
- After editing `packages/agent-worker/*`, run `make clean-workers`.
- Relevant validation: `make build-packages`, targeted worker tests, `bun run typecheck` if broad, then `make review` before PR/merge.

# Handoff: core-code blockers for `@lobu/promptfoo-provider`

This PR (`feat/promptfoo-evals`) ships the `@lobu/promptfoo-provider` workspace package and migrates one example (`personal-finance`) to use it. The branch deliberately does **not** touch core CLI/build/release plumbing; those changes are flagged below for a follow-up agent.

## Must-fix before merge / release

1. **release-please does not see the new package.**
   - File: `release-please-config.json`
   - Fix: add an entry under `packages` for `packages/promptfoo-provider` (mirror the `packages/connector-sdk` block). Without this, the new package's version will not be bumped with the rest of the monorepo and will diverge immediately.

2. **`scripts/publish-packages.mjs` skips the new package.**
   - File: `scripts/publish-packages.mjs`
   - Fix: append `'promptfoo-provider'` (or whatever the canonical entry shape is) to the `PACKAGES` array. Without this the package is never published to npm and the personal-finance example's `bun install` will fail to resolve `@lobu/promptfoo-provider` outside the workspace.

3. **`make build-packages` does not build the new package.**
   - File: `Makefile` (the `build-packages` target's `for pkg in ...` list)
   - Fix: add `promptfoo-provider` to the list so `dist/` is produced in CI / production images.

   Same for the root `package.json` `build:packages` script — it's what `scripts/publish-packages.mjs` calls before publishing, so missing it here means the package's `dist/` isn't built before npm publish.

## Should-fix (unblocks the demo use-cases this PR was originally for)

4. **Gateway SSE protocol needs a `tool_use` event type.**
   - Current protocol (from `packages/server/src/gateway/api/response-renderer.ts` + `unified-thread-consumer.ts`): broadcasts only `output` / `complete` / `error` / `status` / `ephemeral` / `question` / `link-button` / `tool-approval` / `suggestion`. No tool-call trace surfaces to clients.
   - Impact on this PR: `LobuProvider.metadata.toolCalls` and `metadata.retrievedContext` are always absent. promptfoo RAG assertions (`context-recall`, `context-faithfulness`, `answer-relevance`) and any custom assertion that inspects retrieved evidence are non-functional.
   - Sketch:
     - Worker emits a structured tool-use record per Claude tool-use block (or aggregated at `complete`) through the existing worker → gateway message bus.
     - Gateway broadcasts `tool_use` SSE events with `{ name, input, result_summary?, messageId }`.
     - For `search_memory` specifically, include the returned event IDs so the provider can fetch event payloads for `retrievedContext`.
   - Once shipped, `LobuProvider` populates the fields with no provider-side config change.

## Background context for the follow-up agent

- The branch deletes `packages/cli/src/eval/` (the in-house YAML runner) and the `lobu eval` command. This is intentional and replaces the runner with `@lobu/promptfoo-provider` + plain `promptfoo` invocation.
- One example project (`examples/personal-finance`) is migrated as proof-of-concept (2 simple evals in `promptfooconfig.yaml`); 4 multi-turn YAMLs remain dormant pending either a provider extension or a flattening port (see that project's `evals/README.md`).
- No other example projects are migrated yet — they had no eval YAMLs to begin with.
- The provider implementation is in `packages/promptfoo-provider/src/provider.ts`; it speaks the gateway's Agent API (`POST /lobu/api/v1/agents` → `/messages` → SSE `/events` → `DELETE`).
- Provider is loaded via promptfoo's `package:` protocol: `id: 'package:@lobu/promptfoo-provider:LobuProvider'`.

## Verification once the must-fixes land

```bash
# From a clean checkout of feat/promptfoo-evals merged with these fixes:
make build-packages          # promptfoo-provider should appear in the build chain
cd examples/personal-finance
bun install                  # workspace:* deps resolve
export LOBU_TOKEN=$(lobu token)
bun run evals                # promptfoo runs ping + tax-year-anchoring scenarios
bun run evals:view           # comparison grid opens
```

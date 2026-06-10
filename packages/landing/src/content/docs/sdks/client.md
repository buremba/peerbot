---
title: Client
description: "Call Lobu agents from TypeScript with @lobu/client: create a session, send a message, stream the reply."
---

[`@lobu/client`](https://www.npmjs.com/package/@lobu/client) is the typed TypeScript wrapper around Lobu's agent API. Create a session against an agent, send messages, and stream the reply, without hand-rolling SSE parsing or token handling. It's the inside-your-app counterpart to the [REST API](/sdks/rest-api/): same endpoints, typed.

## Install

```bash
bun add @lobu/client
# or: npm install @lobu/client
```

Runtime: Node 18+ (anything with a global `fetch`). Works in the browser too, but **mint sessions server-side**; see [Security](#security).

## Quick start

```ts
import { Lobu } from "@lobu/client";

const lobu = new Lobu({
  // Gateway origin. The embedded server mounts the agent API under `/lobu`.
  baseUrl: "http://localhost:8787/lobu",
  // Your Lobu API token (server-side secret).
  token: process.env.LOBU_API_TOKEN!,
});

// 1. Open a session against an agent.
const session = await lobu.sessions.create({ agentId: "my-agent" });

// 2. Ask and await the reply (convenience over send + events).
const { text } = await session.ask("What changed this week?");
console.log(text);
```

`ask` sends a message and resolves with the agent's concatenated reply. For streaming or finer control, use `send` + `events` (below).

## The `Lobu` client

```ts
const lobu = new Lobu({
  baseUrl: "https://app.lobu.ai/lobu",
  token: process.env.LOBU_API_TOKEN!,   // string, or a function/async function
  // fetch,                              // optional custom fetch implementation
  // headers: { "x-trace": "…" },        // optional headers sent on every request
});
```

| Option | Type | Notes |
|--------|------|-------|
| `baseUrl` | `string` | Gateway origin. Endpoints are `<baseUrl>/api/v1/agents/…`. The embedded server and cloud both serve the agent API under the `/lobu` prefix, e.g. `http://localhost:8787/lobu`. Trailing slashes are trimmed. |
| `token` | `string \| () => string \| Promise<string>` | The **API token** used to mint sessions. Pass a function to fetch it lazily (e.g. from a secret store or a short-lived issuer). |
| `fetch` | `typeof fetch` | Override the fetch implementation. Defaults to the global `fetch`. |
| `headers` | `Headers \| Record<string,string> \| [string,string][]` | Extra headers attached to every request. |

There are two tokens in play: the **API token** you pass here mints sessions; each session then carries its own short-lived **worker token** (24h TTL) used to send messages and stream events. The client manages the second one for you.

## Sessions

`lobu.sessions.create(request)` (alias: `lobu.createSession(request)`) returns an `AgentSession`.

```ts
const session = await lobu.sessions.create({
  agentId: "my-agent",
  userId: "u_123",      // optional: scopes the conversation to a user
  thread: "support",    // optional: separate conversation threads
  // provider, model    // optional per-session overrides
  // forceNew: true     // start a fresh conversation instead of resuming
  // dryRun: true       // validate without spawning a worker
});
```

The `AgentSession` exposes:

| Member | Description |
|--------|-------------|
| `session.ask(content, opts?)` | Send a message and await the full reply. Resolves `{ text, messageId }`. |
| `session.send(content, opts?)` | Send a message, return immediately. Resolves `{ messageId, queued, … }`. |
| `session.events(opts?)` | An `AsyncIterable` of the agent's SSE stream. |
| `session.refresh()` | Re-mint the worker token without losing the conversation. Call before `expiresAt`. |
| `session.token` / `session.expiresAt` | Current worker token and its expiry (Unix epoch ms, 24h TTL). |
| `session.conversationId` | Server-side routing id, what `send`/`events` route on. Not the logical `agentId`. |
| `session.sseUrl` / `session.messagesUrl` | The endpoints the server advertised for this session. |

## Streaming a reply

`ask` is request/response. For token-by-token output or interactive events, drive `events` yourself:

```ts
const session = await lobu.sessions.create({ agentId: "my-agent" });

// Subscribe first, then send once the stream is connected.
for await (const event of session.events()) {
  switch (event.event) {
    case "connected":
      await session.send("Summarize the latest incidents.");
      break;
    case "output":
      process.stdout.write(event.data.content); // incremental delta
      break;
    case "complete":
      return; // turn finished
    case "error":
    case "agent-error":
      throw new Error(event.data.error);
  }
}
```

The event union is closed on the common events (`connected`, `output`, `complete`, `error`, `agent-error`, `ping`), so matching on `event.event` narrows `event.data`. Richer interactive events (`question`, `tool-approval`, `suggestion`, …) are present by name with `unknown` data; type one yourself with `session.events<MyPayload>()`.

`events` defaults to **no auto-reconnect** (`maxRetryAttempts: 1`): a 401/404/5xx or network failure rejects the iterator immediately instead of hanging. Raise `maxRetryAttempts` to opt into reconnects for transient failures.

## Long-lived sessions

Worker tokens expire after 24h. For a chat that outlives that, refresh before expiry (there's no background auto-renew):

```ts
if (Date.now() > session.expiresAt - 60_000) {
  await session.refresh(); // updates session.token in place, keeps the conversation
}
```

## Errors

```ts
import { Lobu, LobuApiError, LobuAgentError } from "@lobu/client";

try {
  const { text } = await session.ask("…");
} catch (err) {
  if (err instanceof LobuApiError) {
    // Non-2xx from the gateway (bad token, unknown agent, 5xx).
    console.error(err.response.status, err);
  } else if (err instanceof LobuAgentError) {
    // The agent emitted an `error` / `agent-error` event mid-turn.
    console.error("agent failed:", err.message);
  }
}
```

`ask` also rejects on timeout (default 120s, set `timeoutMs`) and on an aborted `signal`.

## Security

`createSession` accepts **server-trusted** fields: `networkConfig` (the worker's egress allow/blocklist), `mcpServers`, and `nix` packages. These control what the spawned worker can reach and run, so **mint sessions on your server**; never let an untrusted browser pick its own values. If you call the client from the browser, proxy session creation through your backend and hand the browser only the resulting session token.

Note also: under a multi-replica deployment, API/SSE events are not owner-routed across pods, so `ask` can time out even after the agent finished. Single-replica and local runs are reliable; for multi-replica, prefer `send` + your own `events` consumer with reconnect.

## See also

- [REST API](/sdks/rest-api/): the same endpoints over raw HTTP, for any language.
- [Interactive API reference](/reference/api-reference/): every endpoint, generated from the OpenAPI spec.
- [Connectors](/sdks/connectors/) / [Reactions](/sdks/reactions/): the inside-out surface for extending what an agent sees and does.

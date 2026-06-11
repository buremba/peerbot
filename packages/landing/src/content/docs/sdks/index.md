---
title: SDKs
description: "The developer surfaces for building on Lobu: the typed client, the REST API, connectors, and reactions."
---

Lobu ships a handful of developer surfaces. Which one you reach for depends on whether you're **calling** an agent from your own app or **extending** what an agent can see and do.

## Pick a surface

| You want to… | Use | Language |
|--------------|-----|----------|
| Call agents from a TypeScript/Node app: create a session, stream the reply | [`@lobu/client`](/sdks/client/) | TypeScript |
| Call agents from any language, a webhook, or a cron job over HTTP | [REST API](/sdks/rest-api/) | any (HTTP) |
| Feed external events (Slack, GitHub, a custom source) into an agent's memory | [Connectors](/sdks/connectors/) | TypeScript |
| Run code *after* a watcher extracts data: notify, derive, mutate | [Reactions](/sdks/reactions/) | TypeScript |
| Give an OpenClaw / coding agent persistent Lobu memory | [Memory plugin](/sdks/memory-plugin/) | npm + MCP |
| Run automated quality checks against an agent | [Evals](/sdks/evals/) | promptfoo |

The split is **client/REST vs connectors/reactions**:

- **Client and REST API are the outside-in surface**: your code on the outside, talking to a running agent over the wire. The client is the typed wrapper around the same HTTP endpoints the REST API exposes; use it from TypeScript, drop to raw HTTP from anything else.
- **Connectors and reactions are the inside-out surface**: TypeScript you author *into* a Lobu project, compiled and run by the runtime. Connectors bring events in; reactions act on them after a watcher extracts. Both ship from [`@lobu/connector-sdk`](/sdks/connectors-reference/).

## Install

```bash
# Call agents from your own app
bun add @lobu/client

# Author connectors and reactions inside a Lobu project
bun add @lobu/connector-sdk
```

The REST API needs no install; it's HTTP. The connector/reaction packages are authoring-time types; the runtime injects the live `client` at execution.

## See also

- [`lobu.config.ts` reference](/reference/lobu-config/): the declarative config that wires connectors and reactions into agents.
- [CLI reference](/reference/cli/): `lobu apply`, `lobu run`, and friends.
- [Interactive API reference](/reference/api-reference/): every REST endpoint, generated from the gateway's OpenAPI spec.

---
title: Embed in Your App
description: Mount Lobu inside Next.js, Express, Hono, Fastify, or any Node.js framework.
sidebar:
  order: 0
---

Run Lobu inside your application as a library instead of a standalone server. Import `@lobu/gateway`, define your agents in code, and mount the HTTP handler into whatever framework you already use.

## Install

```bash
npm install @lobu/gateway
# or
bun add @lobu/gateway
```

You also need a running Redis instance. Any Redis-compatible server works (Redis, Upstash, Dragonfly, etc.).

## Basic usage

```typescript
import { Lobu } from "@lobu/gateway";

const lobu = new Lobu({
  redis: process.env.REDIS_URL!,
  agents: [
    {
      id: "support",
      name: "Support Agent",
      providers: [{ id: "openai", key: process.env.OPENAI_API_KEY! }],
    },
  ],
});

// Option A: let Lobu start its own HTTP server
await lobu.start();

// Option B: initialize services without starting a server,
// then mount in your framework
await lobu.initialize();
const app = lobu.getApp(); // Hono app with .fetch(Request) → Response
```

`getApp()` returns a [Hono](https://hono.dev) application. Hono implements the Web Standard `fetch(Request) → Response` interface, so it mounts in any framework that speaks Web Standard Request/Response — or adapts to Node.js `IncomingMessage`/`ServerResponse` via `@hono/node-server`'s `getRequestListener`.

---

## Next.js (App Router)

Web Standard `Request`/`Response` — direct `app.fetch(req)`.

```typescript
// app/api/lobu/[...path]/route.ts
import { Lobu } from "@lobu/gateway";

const lobu = new Lobu({ /* ...config... */ });
const initialized = lobu.initialize();

async function handler(req: Request) {
  await initialized;
  return lobu.getApp().fetch(req);
}

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const DELETE = handler;
```

:::note
Call `lobu.initialize()` once and await the returned promise in each request. Services start exactly once regardless of how many requests arrive concurrently.
:::

## Next.js (Pages Router)

Node.js `req`/`res` — use `@hono/node-server`'s `getRequestListener`.

```typescript
// pages/api/lobu/[...path].ts
import type { NextApiRequest, NextApiResponse } from "next";
import { Lobu } from "@lobu/gateway";
import { getRequestListener } from "@hono/node-server";

const lobu = new Lobu({ /* ...config... */ });
const initialized = lobu.initialize();

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  await initialized;
  getRequestListener(lobu.getApp().fetch)(req, res);
}
```

---

## Express

```typescript
import express from "express";
import { Lobu } from "@lobu/gateway";
import { getRequestListener } from "@hono/node-server";

const app = express();
const lobu = new Lobu({ /* ...config... */ });
await lobu.initialize();

app.use("/lobu", getRequestListener(lobu.getApp().fetch));
app.listen(3000);
```

## Hono

Lobu's app is already a Hono instance — mount directly:

```typescript
import { Hono } from "hono";
import { Lobu } from "@lobu/gateway";

const app = new Hono();
const lobu = new Lobu({ /* ...config... */ });
await lobu.initialize();

app.route("/lobu", lobu.getApp());
export default app;
```

## Fastify

```typescript
import Fastify from "fastify";
import { Lobu } from "@lobu/gateway";
import { getRequestListener } from "@hono/node-server";

const fastify = Fastify();
const lobu = new Lobu({ /* ...config... */ });
await lobu.initialize();

const listener = getRequestListener(lobu.getApp().fetch);
fastify.all("/lobu/*", (req, reply) => listener(req.raw, reply.raw));
await fastify.listen({ port: 3000 });
```

## Bun / Deno

Native `fetch` handler — no adapter needed:

```typescript
import { Lobu } from "@lobu/gateway";

const lobu = new Lobu({ /* ...config... */ });
await lobu.initialize();

export default {
  fetch: lobu.getApp().fetch,
  port: 3000,
};
```

---

## Configuration reference

The `LobuConfig` object accepted by `new Lobu()`:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `redis` | `string` | **required** | Redis connection URL |
| `agents` | `LobuAgentConfig[]` | `[]` | Agent definitions |
| `port` | `number` | `8080` | HTTP port (only used with `lobu.start()`) |
| `deploymentMode` | `"embedded" \| "docker"` | `"embedded"` | How workers are spawned |
| `publicUrl` | `string` | `http://localhost:{port}` | Public URL for OAuth callbacks |
| `adminPassword` | `string` | auto-generated | API authentication password |
| `memory` | `string` | — | Memory plugin URL |

Each agent in the `agents` array:

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Unique agent identifier |
| `name` | `string` | Display name |
| `description` | `string` | Agent description |
| `identity` | `string` | Identity prompt (markdown) |
| `soul` | `string` | Soul prompt (markdown) |
| `providers` | `Array<{ id, model?, key? }>` | AI provider configs |
| `connections` | `Array<{ type, ... }>` | Platform connections (Slack, Telegram, etc.) |
| `skills` | `string[]` | Skill IDs to enable |
| `network` | `{ allowed?, denied? }` | Domain allowlist/denylist for workers |
| `nixPackages` | `string[]` | Nix packages available to workers |

## What's included

Embedding gives you the full gateway feature set:

- Agent orchestration and worker lifecycle
- MCP tool proxy
- Provider credential management
- Platform connections (Slack, Telegram, WhatsApp, Discord)
- OpenAPI-documented REST API at `/api/docs`
- Skills and memory support

The only difference from a standalone deployment: your application controls the HTTP server.

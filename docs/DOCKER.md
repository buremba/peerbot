# Docker / Self-hosting

Lobu publishes a single Docker image — `ghcr.io/lobu-ai/lobu-app` — that ships the API gateway, embedded worker runtime, and admin SPA in one process. The same artifact powers Lobu Cloud's k8s deployment; nothing is k8s-specific at the image layer.

For most users we recommend running Lobu via the [`lobu run`](../README.md) CLI (no Docker needed). Self-hosting in Docker is for operators who want a long-lived deployment without orchestrator overhead.

## Quick start (Docker Compose)

```bash
# 1. Copy the example compose file
cp docker-compose.example.yml docker-compose.yml

# 2. Generate two secrets
echo "ENCRYPTION_KEY=$(openssl rand -base64 32)"
echo "BETTER_AUTH_SECRET=$(openssl rand -base64 32)"
# Paste both into docker-compose.yml (and rotate the postgres password)

# 3. Boot
docker compose up -d

# 4. Open
open http://localhost:8787
```

That's it. Sign up via the admin UI, add provider API keys from the settings page, create your first agent.

## What's actually required to boot

| Env var | Required? | Notes |
| --- | --- | --- |
| `DATABASE_URL` | **Yes** | Postgres with `pgvector` extension. Server refuses to start without it. |
| `ENCRYPTION_KEY` | **Yes** | 32-byte base64. Encrypts secrets stored in Postgres (provider keys, OAuth tokens). Loses every encrypted secret if you change it after first boot. |
| `BETTER_AUTH_SECRET` | **Yes** | 32-byte base64. Signs admin session cookies. Auto-generated ephemerally in local dev; required in production. |
| `PUBLIC_WEB_URL` | Recommended | The URL users hit. Affects OAuth callbacks, public-page links, and cookie domain. Defaults to `http://localhost:8787`. |
| `ANTHROPIC_API_KEY` | No | Only needed if (a) you run Anthropic-backed agents, or (b) you configure the optional LLM egress judge. Add it from the admin UI after boot instead. |
| `OPENAI_API_KEY` / `GROQ_API_KEY` / etc. | No | Same as Anthropic — set only the providers you want available, or add them via the admin UI at runtime. |
| `WORKER_ALLOWED_DOMAINS` | Optional | Default empty = workers have no internet. Comma-separated allowlist, or `*` for unrestricted (not recommended in prod). See `.env.example` for the full pattern. |

## Boot errors and how to read them

A failing boot now prints the actual error (type, message, stack, and Zod-validation issues). If you see:

- `DATABASE_URL is required` — set it.
- Postgres connection rejected — check the `?sslmode=disable` suffix on local clusters that don't have TLS.
- `ENCRYPTION_KEY is not set` — generate one with `openssl rand -base64 32`.
- `Migration X.Y.Z not applied` — your image expects a newer schema than the database has; pull the matching DB or set `SKIP_SCHEMA_VERSION_CHECK=1` for emergency forward-flight.

If the error still isn't actionable, open an issue with the full output.

## LLM provider support

Lobu is provider-agnostic. The bundled `config/providers.json` ships 17 providers including:

- Anthropic Claude
- OpenAI (GPT-4, GPT-4o, etc.)
- OpenAI-compatible: Groq, Together AI, Fireworks, OpenRouter, Cerebras, NVIDIA, xAI, DeepSeek, Mistral, Cohere, Perplexity, Z-AI, Gemini
- Specialized: ElevenLabs (STT), OpenCode Zen

Add API keys via the admin UI (Settings → Providers) at runtime. No env-var required. Per-agent model selection picks among configured providers.

**Agent runtimes**: Lobu's worker spawns an agent runtime per task. Today it ships with **OpenClaw** (the default in-process runtime) and the watcher table supports an `agent_kind` field that selects which CLI agent to drive — `claude-code`, `codex`, etc. This is independent from which LLM provider serves the agent — Codex CLI on top of Anthropic Claude works fine, for example.

## What's in the image

The Dockerfile lives at `docker/app/Dockerfile`. Three notable details:

1. **Single process.** Gateway, embedded worker runtime, admin SPA, and embeddings all run in one Node process. Workers spawn as `child_process.spawn` subprocesses on the same host. There's no separate worker container.
2. **Built artifact**, not a workspace install at runtime. The image bundles `dist/server.bundle.mjs` produced by esbuild — fast cold-start, no `bun install` at boot.
3. **No SPA bundled in the public image by default.** The admin SPA sources live in a private submodule (`packages/owletto`); the public image stubs them out so external contributors can build the backend without owletto access. To run the SPA, build from a checkout that has the submodule initialized, or use Lobu Cloud.

## Bumping versions

The `:latest` tag tracks the most recent merged `main` build. For pinned deploys, use a version tag from the [GitHub Releases page](https://github.com/lobu-ai/lobu/releases) — they follow `lobu-vX.Y.Z` and match release-please commits on `main`.

Migrations are applied at boot. If you roll back to an older image whose migrations dir is a strict prefix of what's already applied, set `SKIP_SCHEMA_VERSION_CHECK=1` once to get past the version assertion.

## Running behind a reverse proxy / public URL

`PUBLIC_WEB_URL` is the canonical URL users hit. Set it to your real public URL (e.g. `https://lobu.example.com`) so OAuth callbacks, public-page bootstrap links, and cookie domain attribute match. Behind nginx/Caddy/Cloudflare — proxy `:8787` and terminate TLS at the proxy.

`FRAME_ANCESTORS` lets you embed the admin UI inside another origin if needed (Content-Security-Policy frame-ancestors directive). Set as a comma-separated list of allowed origins; leave unset to deny all framing.

## Production checklist

- [ ] Real `ENCRYPTION_KEY` and `BETTER_AUTH_SECRET` (NOT the example placeholders).
- [ ] Real postgres password.
- [ ] `PUBLIC_WEB_URL` set to the real URL.
- [ ] TLS termination via reverse proxy or platform load balancer.
- [ ] Database backups configured (Lobu writes encrypted secrets there — losing the DB means losing every connected integration).
- [ ] `WORKER_ALLOWED_DOMAINS` reviewed for your use case.
- [ ] Provider API keys added through the admin UI (or env vars) for whichever providers you intend to use.

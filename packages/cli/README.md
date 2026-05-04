# @lobu/cli

CLI tool for running Lobu locally and managing Lobu agents through the same REST API as the web app.

## Quick Start

```bash
npx @lobu/cli@latest init my-bot
cd my-bot
# edit .env to set DATABASE_URL
lobu run
```

Lobu boots as a single Node process. Postgres (with pgvector) is a user-provided external — Docker, managed, or local. `lobu doctor` will tell you if anything is missing.

```bash
docker run -d --name lobu-pg -p 5432:5432 \
  -e POSTGRES_PASSWORD=lobu pgvector/pgvector:pg16
# DATABASE_URL=postgresql://postgres:lobu@localhost:5432/postgres
```

## Commands

### `lobu init [name]`

Scaffold a new Lobu project. Interactive by default; pass `--yes` (and any of the per-prompt flags below) for non-interactive / CI scaffolding.

```bash
# Fully interactive
lobu init my-bot

# Non-interactive, all-defaults
lobu init my-bot --yes

# Mixed: pick provider + platform up front, prompt for the rest
lobu init my-bot --provider anthropic --platform telegram

# Scaffold into the current directory (or `lobu init .`)
lobu init --here --yes
```

Flags:

- `-y, --yes` — skip prompts; use defaults / flag values
- `--here` — scaffold into the current directory (or pass `.` as the name)
- `--port <port>` — gateway port (default `8787`)
- `--public-url <url>` — public gateway URL (OAuth/webhooks)
- `--network <restricted|open|isolated>` — worker network policy
- `--provider <id>` — provider id from `config/providers.json`
- `--provider-key <key>` — provider API key (else read from env)
- `--platform <telegram|slack|discord|whatsapp|teams|gchat>`
- `--memory <none|owletto-cloud|owletto-custom>`
- `--memory-url <url>` — required with `--memory owletto-custom`
- `--otel-endpoint <url>`
- `--sentry` / `--no-sentry` — Sentry error reporting (off by default)

**Generates:** `lobu.toml`, `.env`, `agents/<name>/` (`IDENTITY.md`, `SOUL.md`, `USER.md`, `skills/`, `evals/`), `skills/`, `AGENTS.md`, `TESTING.md`, `README.md`, `.gitignore`.

### `lobu run` (aliases: `lobu dev`, `lobu start`)

Boot the embedded Lobu stack — gateway + workers + embeddings + Owletto memory backend in a single Node process. `lobu.toml` is not required; set `DATABASE_URL` in the environment or `.env`. Ctrl+C cleans up worker subprocesses.

Flags: `--port <n>`, `--quiet`, `--verbose`, `--log-level <level>`. Pre-flights the port and prints a friendly message if it's already in use.

### `lobu chat [prompt]`

With a prompt: send one message, stream the response. With no prompt: open a REPL bound to the agent's session. Useful flags:

- `-C, --continue` — resume the last thread for this (context, agent)
- `--auto-approve` — auto-approve every tool call (trusted environments only)
- `--json` — emit raw SSE events as JSON lines (good for piping into other tools)
- `-t, --thread <id>` — pin a specific thread
- `--new` — force a fresh session

REPL slash-commands: `/exit`, `/help`, `/thread`, `/clear`.

### `lobu doctor`

Runs `node`, `git`, Postgres reachability, **pgvector** extension presence, port availability, provider API keys (read from `lobu.toml` + `.env`), and workspace dir checks.

### `lobu link` / `lobu unlink`

Bind the current directory to a (context, org). Stored at `.lobu/project.json` (auto-gitignored). Once linked, `lobu apply` refuses to push to a different cloud target unless you pass `--force`. Mirrors `vercel link` / `convex dev`.

### `lobu apply` (alias: `lobu deploy`)

Idempotent sync of `lobu.toml` + agent dirs to your Lobu Cloud org. `--dry-run`, `--yes`, `--only agents|memory`, `--force`.

### `lobu telemetry [status|on|off]`

Show or toggle anonymous error reporting. Defaults to **off**.

### `lobu agent scaffold <agentId>`

Add a second (or third…) agent to an existing project — generates `agents/<id>/{IDENTITY,SOUL,USER}.md` + `skills/` + `evals/` and appends `[agents.<id>]` to `lobu.toml`.

### `lobu eval new <name>`

Scaffold a YAML eval into the current agent's `evals/` directory.

## License

Apache-2.0

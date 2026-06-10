# @lobu/cli

CLI for running Lobu locally and managing Lobu agents through the same REST API as the web app.

## Quick Start

```bash
npx @lobu/cli@latest init my-bot
cd my-bot
# edit .env to set DATABASE_URL
lobu run
```

Lobu boots as a single Node process. Postgres (with pgvector) is a user-provided external. `lobu doctor` reports what's missing.

```bash
docker run -d --name lobu-pg -p 5432:5432 \
  -e POSTGRES_PASSWORD=lobu pgvector/pgvector:pg18-trixie
# DATABASE_URL=postgresql://postgres:lobu@localhost:5432/postgres
```

## Commands

`lobu --help` shows the full grouped command list, and `lobu <cmd> --help` lists the per-command flags. The highlights:

- `lobu init [name]` — scaffold a project. Interactive by default; pass `--yes` (with any of `--port` / `--provider` / `--platform` / `--memory` / `--no-sentry` / etc.) for non-interactive / CI scaffolding. `lobu init .` or `--here` scaffolds into the current directory.
- `lobu run` (aliases: `lobu dev`, `lobu start`) — boot the embedded stack. Pre-flights the gateway port and accepts `--port` / `--quiet` / `--verbose` / `--log-level`.
- `lobu chat <prompt>` — send one prompt and stream the response. `-C/--continue` resumes the last thread (per context+agent); `--auto-approve` skips tool prompts in trusted runs; `--json` emits raw SSE events for piping.
- `lobu doctor` — Postgres connectivity, pgvector extension, port availability, provider API keys, workspace dir.
- `lobu link` / `lobu unlink` — bind this directory to a (context, org) at `.lobu/project.json`. `lobu apply` refuses to push mismatched targets unless `--force` is set.
- `lobu apply` (alias: `lobu deploy`) — idempotent sync of `lobu.config.ts` to Lobu Cloud.
- `lobu agent scaffold <id>` — add a second/third agent to an existing project.
- `lobu telemetry {status,on,off}` — Sentry is off by default; toggle here.

> Note: Lobu's in-house YAML eval runner has been removed. Author evals with [promptfoo](https://www.promptfoo.dev) + `@lobu/promptfoo-provider`; see `examples/personal-finance/evals/promptfooconfig.yaml` for the new pattern.

## License

Apache-2.0

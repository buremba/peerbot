---
title: Sync agents from GitHub
description: Manage agent definitions in a git repo and have GitHub Actions apply them to your Lobu org on every push.
---

`lobu apply` is the apply primitive — it diffs a local `lobu.toml` + agent dirs against a Lobu Cloud org and converges the org to match. Any CI runner can call it, and GitHub Actions is the path of least resistance: push to `main` triggers an apply, PRs preview a dry-run diff in the check output.

There is no Lobu-side sync feature. The repo is the source of truth and CI is the cron. That keeps Lobu opinion-free about how you structure branches, reviews, multi-env promotion, secret stores — those are choices you already made for the rest of your stack.

## What you need

1. A git repo with a `lobu.toml` at the root (or in a subdirectory).
2. A `LOBU_TOKEN` secret in the repo (`Settings → Secrets and variables → Actions`). Mint one with `lobu auth tokens create --scope apply` from a logged-in shell.
3. Any provider keys your agents reference (`ANTHROPIC_API_KEY`, etc.) added as repo secrets too — `lobu apply` reads them via `$VAR` interpolation in `lobu.toml`.

## Drop-in workflow

```yaml
# .github/workflows/lobu-apply.yml
name: Sync agents

on:
  push:
    branches: [main]
  pull_request:

permissions:
  contents: read

concurrency:
  group: lobu-apply-${{ github.ref }}
  cancel-in-progress: false

jobs:
  apply:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.3.5
      - name: Apply
        env:
          # CLI reads LOBU_API_TOKEN as the env-var override for stored credentials.
          LOBU_API_TOKEN: ${{ secrets.LOBU_TOKEN }}
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        run: |
          if [ "${{ github.event_name }}" = "pull_request" ]; then
            bunx --bun @lobu/cli apply --dry-run
          else
            bunx --bun @lobu/cli apply --yes
          fi
```

`--dry-run` on PRs gives reviewers the full add/update/delete plan in the check log. `--yes` on push to `main` actually converges the org.

## Recommended repo layout

```
my-agents/
├── lobu.toml
├── agents/
│   ├── support-bot/
│   │   ├── IDENTITY.md
│   │   ├── SOUL.md
│   │   └── USER.md
│   └── ops-bot/
│       └── ...
└── .github/workflows/lobu-apply.yml
```

`lobu.toml` references each agent's directory:

```toml
[agents.support-bot]
name = "support-bot"
description = "Customer support triage"
dir = "./agents/support-bot"

[[agents.support-bot.providers]]
id = "anthropic"
model = "claude/sonnet-4-5"
key = "$ANTHROPIC_API_KEY"
```

See [`lobu apply`](/docs/reference/lobu-apply/) for the full file format and the list of fields that get synced.

## Multiple environments

For `staging` and `prod` orgs, run two jobs (or two workflows) with different `--org` flags and different `LOBU_TOKEN`s:

```yaml
- name: Apply to staging
  env:
    LOBU_API_TOKEN: ${{ secrets.LOBU_TOKEN_STAGING }}
  run: bunx --bun @lobu/cli apply --org my-org-staging --yes

- name: Apply to prod
  if: github.event_name == 'push' && github.ref == 'refs/heads/main'
  env:
    LOBU_API_TOKEN: ${{ secrets.LOBU_TOKEN_PROD }}
  run: bunx --bun @lobu/cli apply --org my-org-prod --yes
```

Stage on push-to-main, prod on tag, prod-on-approval — all standard Actions patterns; nothing Lobu-specific.

## What `lobu apply` will not do

- It will not edit secrets in your provider accounts. `$VAR` references are resolved at apply time from the runner's environment; the values never leave the runner.
- It will not import existing cloud-side agents into your repo. If you've been editing in the admin UI and want to flip to git-managed, run `lobu pull` (planned) or hand-write `lobu.toml` against the current state.
- It will not silently overwrite manual UI edits without showing the diff. Every apply prints the plan; `--dry-run` lets you preview without converging.

## Drift between UI and git

Since the [agents flatten](https://github.com/lobu-ai/lobu/pull/531) landed, definition fields (system prompts, model picker, skills, packages) require admin scope to edit via the API. If your repo is the source of truth, restrict admin access on the org so the only writers are CI tokens and the diff is meaningful.

## See also

- [`lobu apply` reference](/docs/reference/lobu-apply/) — file format, flags, exit codes.
- The [`examples/atlas/`](https://github.com/lobu-ai/lobu/tree/main/examples/atlas) folder in the Lobu monorepo dogfoods this pattern; the workflow at [`.github/workflows/lobu-apply-atlas.yml`](https://github.com/lobu-ai/lobu/blob/main/.github/workflows/lobu-apply-atlas.yml) is the live version of the snippet above.

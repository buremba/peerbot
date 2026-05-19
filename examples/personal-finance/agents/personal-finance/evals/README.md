# Evals

All evals live in [`promptfooconfig.yaml`](./promptfooconfig.yaml) and are run via [promptfoo](https://www.promptfoo.dev) + [`@lobu/promptfoo-provider`](../../../../../packages/promptfoo-provider).

```bash
cd examples/personal-finance
bun install
export LOBU_TOKEN=$(lobu token)
bun run evals
bun run evals:view
```

## Coverage

Six checks, two shapes:

- **Single-turn** (`vars.query`): `ping`, `tax-year-anchoring` (2024-25 boundary, 2025-26 boundary).
- **Multi-turn** (`vars.transcript` — sequential user turns replayed in one Lobu thread; assertions evaluate the final response): `gap-surfacing`, `sa102-employment`, `sa105-property`, `sa108-cgt`. See `packages/promptfoo-provider/README.md` for the transcript protocol.

## Dormant YAML files

`ping.yaml` and `tax-year-anchoring.yaml` still exist alongside `promptfooconfig.yaml` for reference. They are not run by `bun run evals` — promptfoo only reads the single config file. Drop them in a follow-up cleanup.

# Evals

The active evals live in [`promptfooconfig.yaml`](./promptfooconfig.yaml) and are run via [promptfoo](https://www.promptfoo.dev) + [`@lobu/promptfoo-provider`](../../../../../packages/promptfoo-provider).

```bash
cd examples/personal-finance
bun install
export LOBU_TOKEN=$(lobu token)
bun run evals
bun run evals:view
```

## Dormant YAML files

`ping.yaml` and `tax-year-anchoring.yaml` have been **migrated** into `promptfooconfig.yaml` above and can be deleted in a follow-up.

The remaining YAMLs — `gap-surfacing.yaml`, `sa102-employment.yaml`, `sa105-property.yaml`, `sa108-cgt.yaml` — are still on the old format and **not currently executable**. They are multi-turn conversational tests (e.g. `gap-surfacing.yaml` relies on context established in turn 1 to evaluate turn 2's behaviour) and promptfoo's parametric `tests:` model is single-turn by default. Porting needs either:

- Provider extension: `LobuProvider` learns to replay a `vars.transcript` array as multiple messages in one Lobu thread, returning the final turn's response for assertions. ~30 LOC change.
- Or: flatten each conversation into a single richer prompt ("user said earlier: X; now they say: Y"). Loses fidelity but works today.

Tracked as a follow-up migration.

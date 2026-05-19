# Migration pending

These YAML files were authored against Lobu's in-house eval runner (`packages/cli/src/eval/`), which has been **removed** in favour of [promptfoo](https://www.promptfoo.dev) via [`@lobu/promptfoo-provider`](../../../../../packages/promptfoo-provider). They are not currently executable.

They are kept here as the source for a follow-up migration. Each YAML is a multi-turn conversational test (e.g. `gap-surfacing.yaml` relies on context from turn 1 to evaluate turn 2's behaviour), and promptfoo's parametric `tests:` model is single-turn by default. Porting needs either:

- Provider extension: `LobuProvider` learns to replay a `vars.turns` array as multiple messages in one Lobu thread, returning the final turn's response for assertions. ~30 LOC change.
- Or: flatten each conversation into a single richer prompt ("user said earlier: X; now they say: Y"). Loses fidelity but works today.

See [`examples/qmsum-demo/agents/qmsum/evals/promptfooconfig.yaml`](../../../../qmsum-demo/agents/qmsum/evals/promptfooconfig.yaml) for the new authoring pattern.

---
name: lobu
description: Build, run, and maintain Lobu agent projects. Use this skill when working with lobu.toml, prompt files, local skills, evals, providers, connections, or optional Owletto-backed memory inside a Lobu workspace.
---

# Lobu

Use this skill when the user is working on a Lobu project or wants to scaffold one.

## Core Model

- **Lobu** is the agent framework, runtime, and deployment layer.
- **Owletto** is a separate memory and integrations product. Install the Owletto skill separately when the user needs direct Owletto memory workflows.
- Keep framework configuration in `lobu.toml`.
- Keep agent identity and behavior in `IDENTITY.md`, `SOUL.md`, and `USER.md`.
- Keep reusable capability bundles in `skills/<name>/SKILL.md` or `agents/<agent>/skills/<name>/SKILL.md`.

## Project Checklist

1. Read `lobu.toml` first.
2. Read the active agent files under `agents/<id>/`.
3. Check local skills under `skills/` and `agents/<id>/skills/`.
4. Use `lobu validate` after config changes.
5. Use `lobu eval` when prompt or behavior changes.

## Common Commands

```bash
npx @lobu/cli@latest init my-agent
npx @lobu/cli@latest run -d
npx @lobu/cli@latest validate
npx @lobu/cli@latest eval
```

## Owletto In Lobu

If a Lobu project should use Owletto for shared memory, configure `[memory.owletto]` in `lobu.toml`. That wiring is separate from this skill.

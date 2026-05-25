---
title: Agent Workspace
description: How agent files are organized across prompt files, local skills, evals, and lobu.config.ts.
---

Every Lobu agent has a workspace directory such as `agents/my-agent/`. `lobu.config.ts` points each agent at that directory with `dir: "./agents/my-agent"`. A **single-agent** project can set `dir: "."` to keep the prompt files at the project root instead (the bundled examples do this); multi-agent projects give each agent its own directory.

The workspace contains the agent's prompt files plus any agent-local skills and evals. Operator-controlled configuration such as providers, connections, network policy, tool policy, and enabled registry skills lives in [`lobu.config.ts`](/reference/lobu-config/).

At runtime, Lobu gives each user, DM, or channel its own isolated sandbox workspace. The files in `agents/<agent>/` are templates for that sandbox, so every new workspace starts from the same `IDENTITY.md`, `SOUL.md`, `USER.md`, skills, and eval setup for that agent.

## Workspace layout

```text
lobu.config.ts
agents/
  my-agent/
    IDENTITY.md
    SOUL.md
    USER.md
    skills/
      my-skill/
        SKILL.md
    evals/
      smoke.yaml
skills/
  shared-skill/
    SKILL.md
```

## What lives where

| Concern | File or directory | Notes |
|--------|-------------------|-------|
| Agent identity | `agents/<agent>/IDENTITY.md` | Short description of who the agent is |
| Agent behavior | `agents/<agent>/SOUL.md` | Rules, workflows, constraints, tone |
| User or deployment context | `agents/<agent>/USER.md` | Shared context injected into every conversation |
| Skill files | `agents/<agent>/skills/<name>/SKILL.md` or `skills/<name>/SKILL.md` | Referenced from `lobu.config.ts` with `skillFromFile(...)`; not auto-loaded |
| Evaluations | `agents/<agent>/evals/` | Test cases for behavior and quality |
| Providers, connections, network, tool policy, enabled registry skills | `lobu.config.ts` | Operator-controlled runtime config |

## Runtime model

- `agents/<agent>/...` is the source template checked into your project
- each user, DM, or channel gets its own runtime workspace and filesystem
- new sandboxes start from the agent template files, then diverge as the agent works
- files created inside one sandbox do not appear in another sandbox unless you explicitly move data somewhere shared

## Prompt files

| File | Purpose | Analogy |
|------|---------|---------|
| `IDENTITY.md` | Who the agent is — name, role, personality | A job title and bio |
| `SOUL.md` | How the agent behaves — instructions, rules, constraints | A playbook |
| `USER.md` | Context about the user or environment | A briefing doc |

All three prompt files are loaded into the agent's system prompt at runtime.

## IDENTITY.md

Defines the agent's identity. Keep it short and concrete.

```markdown
You are Aria, a customer support agent for Acme Corp. You specialize in
billing questions, account management, and product troubleshooting.
```

A minimal identity also works:

```markdown
You are a helpful AI assistant.
```

## SOUL.md

`SOUL.md` holds the agent's behavioral instructions. Put rules, constraints, workflows, and tone guidance here.

```markdown
# Instructions

## Tone
- Be concise and professional
- Never use emojis unless the user does first
- Ask clarifying questions when the request is ambiguous

## Workflow
1. Greet the user by name if known
2. Understand their issue before suggesting solutions
3. Always confirm before taking actions (cancellations, refunds, etc.)

## Constraints
- Never share internal pricing or discount codes
- Escalate to a human if the user asks for a manager
- Do not make up information — say "I don't know" when unsure
```

Tips:
- Use markdown headers and lists for structure
- Be specific — "be helpful" is vague, "ask one clarifying question before answering" is actionable
- Test different instructions with [evals](/guides/evals/) to measure their impact

## USER.md

`USER.md` stores background context about the user, team, or deployment environment.

```markdown
# User Context

- Timezone: US/Pacific
- Company: Acme Corp
- Plan: Enterprise
- Preferred language: English
```

This file is optional and can be left empty.

## Skills

A skill is declared on the agent in `lobu.config.ts`, either inline with `defineSkill(...)` or loaded from a `SKILL.md` with `skillFromFile(...)`. There is no folder auto-discovery, so a `SKILL.md` can live anywhere you reference it from. The conventional spots are `agents/<agent>/skills/<name>/SKILL.md` (kept next to one agent) and `skills/<name>/SKILL.md` (shared, referenced by more than one agent).

See [Skills](/getting-started/skills/) for declaring them and the [`SKILL.md` Reference](/reference/skill-md/) for the file format, frontmatter, packages, MCP servers, and network declarations.

## lobu.config.ts

`lobu.config.ts` is the runtime wiring layer for the workspace. It tells Lobu:

- which agent directories exist
- which providers and connections to use
- which registry skills are enabled
- which custom MCP servers are attached directly to the agent
- what network and tool policy applies

Use the [`lobu.config.ts` Reference](/reference/lobu-config/) for the exact schema. Keep operator policy there rather than spreading it into prompt files or `SKILL.md`.

## Memory

The sandbox filesystem is short-term working memory: drafts, scripts, downloaded files, generated artifacts, and intermediate results for one user or channel workspace.

When you use Lobu, it adds long-term memory across workspaces. The filesystem stays local to one sandbox, while Lobu stores durable knowledge that other sessions, users, or agents can recall later.

See [Memory](/getting-started/memory/) for the full model.

## Multi-agent layout

With multiple agents in `lobu.config.ts`, each one gets its own workspace:

```ts
import { defineAgent, defineConfig } from "@lobu/cli/config";

const support = defineAgent({
  id: "support",
  name: "support",
  dir: "./agents/support",
});

const sales = defineAgent({
  id: "sales",
  name: "sales",
  dir: "./agents/sales",
});

export default defineConfig({ agents: [support, sales] });
```

```
agents/
  support/
    IDENTITY.md   # "You are a support agent..."
    SOUL.md       # Support-specific instructions
    USER.md
  sales/
    IDENTITY.md   # "You are a sales assistant..."
    SOUL.md       # Sales-specific instructions
    USER.md
```

## Related docs

- [SKILL.md Reference](/reference/skill-md/)
- [`lobu.config.ts` Reference](/reference/lobu-config/)
- [Evaluations](/guides/evals/)

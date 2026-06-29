---
title: SKILL.md Reference
description: Reference for Lobu skill files and supported frontmatter.
sidebar:
  order: 2
---

`SKILL.md` is the skill file format used by Lobu. It combines optional YAML frontmatter with markdown instructions.

Use it for:

- Skill metadata such as `name` and `description`
- Capability declarations such as MCP servers, packages, and network domains
- Instruction text that is injected into the agent's system prompt when the skill is active

Tool policy does **not** live in `SKILL.md`. Configure that in [`lobu.config.ts`](/reference/lobu-config/) via the agent `tools` field; see [Tool Policy](/guides/tool-policy/).

## Where Skills Live

A `SKILL.md` is loaded when an agent references it from [`lobu.config.ts`](/reference/lobu-config/) with `skillFromFile`:

```ts
import { defineAgent, skillFromFile } from "@lobu/cli/config";

defineAgent({
  id: "support",
  skills: [skillFromFile("./agents/support/skills/internal-api")],
});
```

The path is a folder holding a `SKILL.md` (or a `.md` file directly), resolved relative to `lobu.config.ts`. There is no folder auto-discovery. To declare a skill without a file, use `defineSkill({ name, content, ... })` instead; see [Skills](/getting-started/skills/).

## Minimal example

```markdown
---
name: PDF Processing
description: Extract text and metadata from PDF files
---

# PDF Processing

When asked to work with PDFs, use `pdftotext` first.
```

## Full example

```markdown
---
name: My Skill
description: What this skill does

nixPackages:
  - jq
  - ripgrep
  - pandoc

network:
  allow:
    - api.readonly.example.com
  deny: []
  # Domains routed through the LLM egress judge instead of a flat allow/deny.
  # A bare string uses the "default" policy; an object names a policy below.
  judge:
    - "*.slack.com"
    - { domain: user-content.x.com, judge: strict }

judges:
  default: "Allow only reads to channels in the agent's context."
  strict: "Only GET for file IDs from the current session."
---

# My Skill

Instructions and behavioral rules for the agent go here as Markdown.
The body acts as a system prompt extension.
```

## Frontmatter Reference

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Display name shown in settings and search results |
| `description` | string | Short summary for the skill registry |
| `nixPackages` | string[] | System packages to install in the worker |
| `network.allow` | string[] | Domains the worker sandbox can reach |
| `network.deny` | string[] | Domains to block |
| `network.judge` | array | Domains routed through the LLM egress judge. Each entry is a bare domain string (uses the `default` judge policy) or an object `{ domain, judge }` naming a policy in the top-level `judges` map |
| `judges` | object | Named judge policies (string → policy text) referenced by `network.judge[].judge`; the `default` key applies when an entry omits `judge` |

## Markdown Body

The markdown body after the frontmatter is appended to the agent's prompt when the skill is active. Use it for workflows, rules, conventions, and domain-specific instructions.

## Notes

- `SKILL.md` frontmatter does not configure tool approval or `preApproved` grants.
- `contracts.tools` belongs in an OpenClaw plugin manifest (`openclaw.plugin.json`), not in `SKILL.md` frontmatter — the skill parser ignores it.
- When both a skill and the agent declare egress-judge rules, the `lobu.config.ts` policy wins on named judges and judged-domain rules.
- Install service integrations as connectors, not as skill-local MCP servers.

## Related Docs

- [Skills](/getting-started/skills/)
- [Tool Policy](/guides/tool-policy/)
- [`lobu.config.ts` Reference](/reference/lobu-config/)

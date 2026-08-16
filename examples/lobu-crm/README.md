# lobu-crm — Reference example

A funnel CRM agent that tracks GitHub stars, X mentions, HN posts, and npm pulls.
Use this as a starting point for new projects. It shows every Lobu concept in one place.

## Structure

```
lobu-crm/                                  # single agent → dir: "." keeps it flat
├── lobu.config.ts                         # Agent, entities, relationships, Automations, connections, auth profiles
├── SOUL.md                                # Agent personality
├── IDENTITY.md                            # Agent identity
├── USER.md                                # User context
├── npm-downloads.connector.ts             # Custom connector (connectorFromFile)
├── inbound-triage.reaction.ts             # Notification side effect only
├── funnel-digest.reaction.ts              # Notification side effect only
└── skills/crm-ops/SKILL.md                # Agent skill (skillFromFile)
```

The built-in GitHub, X, Hacker News, and website connections are declared inline in
`lobu.config.ts` with `defineConnection` (and `defineAuthProfile` for their OAuth wiring).

## Key files to read

| File | What it shows |
|------|--------------|
| `lobu.config.ts` | Agent config, providers, network allowlist, entity + relationship + Automation definitions, connections, auth profiles |
| `npm-downloads.connector.ts` | Custom connector with typed checkpoint + config against a live no-auth API (listed via `connectorFromFile`) |
| `inbound-triage.reaction.ts` | Notification-only reaction; events come from declared Automation outputs |

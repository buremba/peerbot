# lobu-crm — Reference example

A funnel CRM agent that tracks GitHub stars, X mentions, and HN posts.
Use this as a starting point for new projects. It shows every Lobu concept in one place.

## Structure

```
lobu-crm/                                  # single agent → dir: "." keeps it flat
├── lobu.config.ts                         # Agent, entities, relationships, watchers, connections, auth profiles
├── SOUL.md                                # Agent personality
├── IDENTITY.md                            # Agent identity
├── USER.md                                # User context
├── inbound-triage.reaction.ts             # Runs after watcher extraction
├── funnel-digest.reaction.ts              # Runs after watcher extraction
└── skills/crm-ops/SKILL.md                # Agent skill (skillFromFile)
```

The built-in GitHub, X, Hacker News, and website connections are declared inline in
`lobu.config.ts` with `defineConnection` (and `defineAuthProfile` for their OAuth wiring).

## Key files to read

| File | What it shows |
|------|--------------|
| `lobu.config.ts` | Agent config, providers, network allowlist, entity + relationship + watcher definitions, connections, auth profiles |
| `inbound-triage.reaction.ts` | Reaction script with typed `ReactionClient` |

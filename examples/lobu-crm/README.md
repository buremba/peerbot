# lobu-crm — Reference example

A funnel CRM agent that tracks GitHub stars, X mentions, HN posts, and demo-form submissions.
Use this as a starting point for new projects — it shows every Lobu concept in one place.

## Structure

```
lobu-crm/
├── lobu.toml                              # Agent + memory config
├── connectors/
│   ├── github.yaml                        # Built-in connector (just config)
│   ├── x.yaml                             # Built-in connector
│   ├── hackernews.yaml                    # Built-in connector
│   ├── changelog-watch.yaml               # Built-in connector (website)
│   ├── funnel-form.yaml                   # Custom connector manifest
│   └── funnel-form.connector.ts           # Custom connector implementation
├── models/
│   ├── schema.yaml                        # Entities, relationships, watchers
│   └── reactions/
│       ├── inbound-triage.reaction.ts     # Runs after watcher extraction
│       └── funnel-digest.reaction.ts      # Runs after watcher extraction
└── agents/crm/
    ├── SOUL.md                            # Agent personality
    ├── IDENTITY.md                        # Agent identity
    ├── USER.md                            # User context
    └── skills/crm-ops/SKILL.md            # Agent skill
```

## Key files to read

| File | What it shows |
|------|--------------|
| `lobu.toml` | Agent config, providers, network allowlist |
| `models/schema.yaml` | Entity definitions + watcher cron + extraction schema |
| `connectors/funnel-form.connector.ts` | Custom connector with typed checkpoint + config |
| `models/reactions/inbound-triage.reaction.ts` | Reaction script with typed `ReactionClient` |

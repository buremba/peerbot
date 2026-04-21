# owletto

CLI for running Owletto locally, installing Owletto starter skills, configuring MCP clients, and operating Owletto directly.

## Quick Start

```bash
# Install the Owletto starter skill into a local skills/ directory
npx owletto@latest skills add owletto

# Configure supported clients to use Owletto
npx owletto@latest init
```

Use the OpenClaw-specific starter skill when needed:

```bash
npx owletto@latest skills add owletto-openclaw
```

## Common Commands

```bash
npx owletto@latest start
npx owletto@latest skills list
npx owletto@latest login https://app.lobu.ai/mcp
npx owletto@latest run search_knowledge '{"query":"Acme"}'
```

## Lobu Relationship

Owletto and Lobu are separate products:

- **Owletto** provides shared memory, knowledge tools, connectors, and watchers.
- **Lobu** builds and runs agents, and can optionally use Owletto as its memory backend.

Use `npx @lobu/cli@latest skills add lobu` to install the Lobu starter skill separately.

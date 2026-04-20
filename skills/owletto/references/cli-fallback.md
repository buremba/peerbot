# Owletto CLI Fallback

Use these commands when the target client cannot complete browser OAuth (headless environments, CI, remote agents).

## Device Code Login

Authenticate without a local callback server — prints a code to enter in the browser:

```bash
owletto login --device <mcp-url>
owletto org
owletto health
```

## Browser Login

If you have local browser access, the default login opens a browser callback:

```bash
owletto login <mcp-url>
```

## Organization Management

After login, set the default org:

```bash
owletto org set <org-slug>
```

Override per-command with `--org <slug>` or `OWLETTO_ORG` env var. For multi-server setups, use `--url` or `OWLETTO_URL`.

## Running Tools

All commands use the active session (no need to pass the URL again):

```bash
owletto run                                          # List available tools
owletto run search_knowledge '{"query":"spotify"}'   # Call a tool
owletto run --org other-org search_knowledge '{"query":"spotify"}'  # Different org
```

## Repo-Local CLI

Inside the Owletto repository, use the workspace CLI entrypoint:

```bash
pnpm -C packages/cli exec tsx src/bin.ts login --device <mcp-url>
pnpm -C packages/cli exec tsx src/bin.ts org
pnpm -C packages/cli exec tsx src/bin.ts run
pnpm -C packages/cli exec tsx src/bin.ts run search_knowledge '{"query":"spotify"}'
```

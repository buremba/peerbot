# Releasing

The published packages ship as a synchronized release: `@lobu/core`, `@lobu/cli`, `@lobu/connector-sdk`, `@lobu/connector-worker`, `@lobu/worker`, `@lobu/embeddings`, `@lobu/client`, `@lobu/openclaw-plugin`, and `@lobu/promptfoo-provider`. (The previously published `lobu` unscoped package was retired when its commands moved into `@lobu/cli` as the `lobu memory` namespace.) [release-please](https://github.com/googleapis/release-please) reads conventional commits on `main` and drives versioning; publishing uses npm OIDC trusted publishing (no `NPM_TOKEN`, no OTP).

## Flow

1. Merge feature PRs into `main` with conventional commit messages.
2. release-please opens a `chore(main): release lobu <version>` PR with bumped `package.json`s and a generated `CHANGELOG.md`.
3. Merge the release PR (squash). This creates the `lobu-v<version>` tag + GitHub release and publishes to npm via `publish-packages.yml`.

Edit the release PR title if you want a specific version (e.g. `6.2.0-beta.1`) — release-please honors it.

## Commit prefixes → version bump

| Prefix | Effect |
| --- | --- |
| `feat:` | minor |
| `fix:` | patch |
| `feat!:` / `BREAKING CHANGE:` footer | major |
| `docs:` `chore:` `ci:` `test:` `style:` `refactor:` `perf:` | changelog only, no bump |

Scope is optional (`feat(gateway): ...`). Breaking changes go in the footer:

```
feat(gateway): rename runtime credential resolver contract

BREAKING CHANGE: RuntimeProviderCredentialResolver now returns
`{ credential?, credentialRef?, authType }` instead of a bare string.
```

## Adding a new published package

1. `release-please-config.json` — add to `packages["."].extra-files[]`:
   ```json
   { "type": "json", "path": "packages/<new-pkg>/package.json", "jsonpath": "$.version" }
   ```
   (`extra-files[]` is also where the synchronized version is propagated to `charts/lobu/Chart.yaml` — both `$.version` and `$.appVersion` are bumped there on every release.)
2. `scripts/publish-packages.mjs` — add to the `PACKAGES` array (use `transform: rewriteWorkspaceRefs` if it has `workspace:*` deps).

## Recovery

**Release PR looks wrong** — edit the PR title, or close it and push `chore: trigger release-please`. It re-runs on every push.

**Publish step fails after release PR merge** — fix the issue, push to `main`, re-run: `gh workflow run release-please.yml --ref main`. `publish-packages.mjs` is idempotent (skips already-published packages).

**Bad build reached npm** — prefer deprecation over unpublish:
```bash
npm deprecate '@lobu/core@<bad-version>' "broken build, use <good-version>"
```
Then land a fix and let release-please cut a patch (e.g. `6.1.2`).

## Manual publish fallback

If CI is broken and you need a hotfix:

```bash
npm login --auth-type=web
node scripts/publish-packages.mjs patch        # bump + build + publish
node scripts/publish-packages.mjs 6.2.0        # explicit version
node scripts/publish-packages.mjs --skip-bump  # publish current version
```

After a local publish, land a `chore(main): release lobu <version>` commit on `main` so `.release-please-manifest.json` stays in sync.

## Verify

```bash
for pkg in @lobu/core @lobu/cli @lobu/connector-sdk @lobu/connector-worker @lobu/worker @lobu/embeddings @lobu/client @lobu/openclaw-plugin @lobu/promptfoo-provider; do
  npm view "$pkg" version
done
```

All versions should match the release PR.

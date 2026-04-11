# Releasing

This repo publishes four packages to npm — `@lobu/core`, `@lobu/gateway`,
`@lobu/worker`, and `@lobu/cli` — as a single synchronized release.
`charts/lobu/Chart.yaml` is also bumped in lockstep. Versioning and
publishing are driven by
[release-please](https://github.com/googleapis/release-please) reading
conventional-commit messages from `main`, and publishing uses npm
trusted publishing (OIDC), so there are no long-lived `NPM_TOKEN`
secrets or manual OTP steps.

## TL;DR

**You do not bump versions by hand.** You just ship features via PRs to
`main` with conventional commit messages, and release-please does the
rest.

1. **Merge feature work into `main`** via PRs using conventional commit
   messages (`feat:`, `fix:`, `refactor:`, `docs:`, `chore:`, `test:`,
   etc.). Use `feat:` or `fix:` to trigger a version bump.
2. **release-please opens a release PR** titled `chore(release): <new-version>`
   automatically on every push to `main`. The PR contains:
   - Updated `package.json` version at the root.
   - Updated `packages/core/package.json`, `packages/gateway/package.json`,
     `packages/worker/package.json`, `packages/cli/package.json` — all
     synced to the new version.
   - Updated `charts/lobu/Chart.yaml` (`version` + `appVersion`).
   - A `CHANGELOG.md` entry generated from conventional commits since
     the last release tag.
3. **Merge the release PR** once you're happy with the version and
   changelog. release-please is configured for squash merge.
4. On merge, the same workflow automatically:
   - Creates a GitHub release + `v<new-version>` tag.
   - Publishes all four packages to npm via OIDC trusted publishing.
   - Dispatches the Docker image build via `repository_dispatch`.

No `gh workflow run`, no manual bump, no local `npm publish`. The
release PR merge is the "release button".

## How release-please picks the version

release-please reads the conventional commit messages between the last
`v<version>` tag and the new HEAD and applies semver rules:

| Commit prefix | Effect |
| --- | --- |
| `feat:` | minor bump (`3.0.x` → `3.1.0`) |
| `fix:` | patch bump (`3.0.19` → `3.0.20`) |
| `feat!:` / `BREAKING CHANGE:` footer | major bump (`3.x.y` → `4.0.0`) |
| `docs:`, `chore:`, `ci:`, `test:`, `style:`, `refactor:`, `perf:` | no version bump, but included in changelog under "Other" |

If you want an explicit version (e.g. `3.2.0-beta.1`), you can edit the
release PR title before merging — release-please will honor the version
you write.

## Commit message conventions

Scope is optional but encouraged. Use the package or area as the scope.
Examples:

- `feat(gateway): add runtime credential resolver for embedded mode`
- `fix(worker): strip WORKER_TOKEN from bash subprocess env`
- `docs(landing): rename Agent Prompts guide to Agent Workspace`
- `refactor(ci): use OIDC trusted publishing, drop NPM_TOKEN path`
- `chore(release): bump all packages to 3.1.0` — **release-please
  generates these itself — don't write them by hand**

Breaking changes go in the footer:

```
feat(gateway): rename runtime credential resolver contract

BREAKING CHANGE: RuntimeProviderCredentialResolver now returns
`{ credential?, credentialRef?, authType }` instead of a bare string.
Update embedded host apps accordingly.
```

## What the publish workflow actually does

The `release-please.yml` workflow runs on every push to `main`:

1. **`release-please` job** — runs
   `googleapis/release-please-action@v4` with
   `release-please-config.json` + `.release-please-manifest.json`.
   Either creates/updates the release PR or, if a release PR was just
   merged, cuts a GitHub release and tag.
2. **`publish` job** (conditional on `releases_created == true`) —
   runs only after the release PR merge. It does NOT publish directly.
   Instead it triggers `publish-packages.yml` via `gh workflow run`.
   This keeps the OIDC trusted publisher registration simple: only
   `publish-packages.yml` needs to be registered on npmjs.com.
3. **`dispatch-docker` job** (conditional on `releases_created == true`) —
   fires a `repository_dispatch` event so the Docker image build
   workflow picks up the new version.

`publish-packages.yml` is the workflow that actually publishes:

- Checks out `main` (the release commit).
- `bun install --frozen-lockfile`
- `node scripts/publish-packages.mjs --skip-bump` — builds the four
  packages, rewrites `workspace:*` refs to the concrete version,
  runs `npm publish --access public` per package with
  `NPM_CONFIG_PROVENANCE=true`.
- npm's OIDC trusted publisher exchange runs automatically because
  the workflow has `id-token: write` and each package is registered
  on npmjs.com as a trusted publisher with:
  - Organization: `lobu-ai`
  - Repository: `lobu`
  - Workflow: `publish-packages.yml`
  - Environment: `production`
- Provenance attestation is attached to every tarball.

You can also invoke `publish-packages.yml` manually for hotfix or
recovery scenarios:

```bash
gh workflow run publish-packages.yml -f bump=skip
```

## Verification after publish

```bash
npm view @lobu/core version
npm view @lobu/gateway version
npm view @lobu/worker version
npm view @lobu/cli version
```

All four should match the version in the merged release PR.

## Recovery playbook

**Release PR looks wrong (bad version, missing changelog entries)** —
edit the PR title to the version you want, or close it and push a
`chore: trigger release-please` commit to regenerate. release-please
re-runs on every push and will re-open the PR.

**Publish step fails after release PR merge** — fix the underlying
issue, push a patch to `main`, and re-run the `release-please.yml`
workflow manually with `gh workflow run release-please.yml --ref main`.
`publish-packages.mjs` is idempotent — it skips packages already on
npm (via `isVersionPublished`) and retries the rest.

**Wrong or broken build made it to npm** — npm allows `npm unpublish`
only within 72 hours and only if you're the sole owner. Prefer:

```bash
npm deprecate '@lobu/core@<bad-version>' "broken build, use <good-version>"
# repeat for the other three packages
```

Then land a fix via a new PR and let release-please cut another patch.

**`workspace:*` rewrite throws** — `publish-packages.mjs` throws when
it finds a `workspace:*` dep outside the `@lobu/*` scope. Means a new
workspace was added without updating the script. Open
`scripts/publish-packages.mjs`, add the new package to the `PACKAGES`
array or allow the ref.

## Chart.yaml `appVersion` is updated manually

release-please bumps `charts/lobu/Chart.yaml` `version:` in the
release PR automatically via its YAML updater, but does **not**
bump `appVersion:`. The YAML updater strips string quotes from any
value it touches, and Helm convention (and artifacthub.io) wants
`appVersion` quoted (`appVersion: "3.1.0"`), so it's left out of
the automation.

When you review the release PR, update `appVersion` manually to
match the new `version`:

```yaml
version: 3.1.0
appVersion: "3.1.0"
```

Amend the PR branch with a follow-up commit or edit the file in the
GitHub UI before merging.

## Adding release-please to a new package

If you add a new `packages/*` workspace that should be published, two
files need updating:

1. **`release-please-config.json`** — add a new entry to
   `extra-files[]` under the root `"."` package pointing at the new
   `package.json`:
   ```json
   {
     "type": "json",
     "path": "packages/<new-pkg>/package.json",
     "jsonpath": "$.version"
   }
   ```
2. **`scripts/publish-packages.mjs`** — add an entry to the `PACKAGES`
   array so the publish step knows to build and publish it, with
   `transform: rewriteWorkspaceRefs` if it uses `workspace:*` deps.

## Manual publish fallback

If release-please is down, the CI workflow is broken, or you need a
hotfix published faster than the normal flow allows, you can still
publish locally from a maintainer account on the `@lobu` npm scope.

```bash
npm whoami                    # verify you're logged in
npm login --auth-type=web     # if not logged in

# Either bump + build + publish in one shot:
node scripts/publish-packages.mjs patch              # auto-bump + build + publish
node scripts/publish-packages.mjs 3.1.0              # explicit version
node scripts/publish-packages.mjs --skip-bump        # publish current package.json version
node scripts/publish-packages.mjs --otp=123456 patch # pre-supply OTP

# Or set OTP via env:
NPM_OTP=123456 node scripts/publish-packages.mjs patch
```

After a local publish, you **must** still land a `chore(release)`
commit on `main` with the new version so `.release-please-manifest.json`
stays in sync. Otherwise release-please will propose duplicate versions
on the next run.

## Not used anymore

The following exist in git history — **do not resurrect them**:

- Direct pushes to `main` for version bumps. Use a PR.
- `gh workflow run publish-packages.yml` as the normal release path.
  `publish-packages.yml` still exists for manual fallback but
  release-please drives normal releases.
- `scripts/stage-publish-package.mjs` — replaced by
  `scripts/publish-packages.mjs`.
- The stale `release.yml` that was copy-pasted from
  `anthropics/claude-code-action` and tried to sync releases to an
  unrelated repo.

/**
 * Paths `/@fs/` must never serve from the Vite dev server.
 *
 * `server.fs.allow` defaults to the workspace root, so anything inside the repo
 * is fetchable over `/@fs/<abs path>` by whoever can reach the dev server —
 * which now includes a public Daytona preview. Three trees hold live state:
 * `.lobu-dev` is the embedded Postgres cluster (a local `make dev` keeps it in
 * the repo root), `.lobu` is the agent scratch dir holding session transcripts,
 * and `workspaces` is the per-agent worker tree.
 *
 * Vite matches `fs.deny` globs against the ABSOLUTE file path, so the three
 * are anchored to `servedRoot` rather than written as `**\/workspaces/**`: the
 * unanchored form also matched a checkout that merely lives under a directory
 * named `workspaces` (`~/workspaces/lobu`) and 403'd every SPA file.
 *
 * The first four entries are Vite's own defaults. Setting `fs.deny` REPLACES
 * that default array rather than merging with it, so dropping them here would
 * silently start serving `.env` — the one file that must never leave the host.
 */
export function devViteFsDeny(servedRoot: string): string[] {
	const root = escapeGlob(servedRoot.replace(/\/+$/, ""));
	return [
		".env",
		".env.*",
		"*.{crt,pem}",
		"**/.git/**",
		`${root}/.lobu-dev/**`,
		`${root}/**/.lobu/**`,
		`${root}/**/workspaces/**`,
	];
}

/** picomatch treats these as glob syntax; a repo path such as `my (repo)` must match literally. */
function escapeGlob(p: string): string {
	return p.replace(/[\\*?[\]{}()!+@]/g, "\\$&");
}

/**
 * The only trees `/@fs/` may reach, replacing Vite's default of the whole
 * workspace root. The deny list below is the second layer; this is the first,
 * and it is what keeps `scripts/`, `deploy/`, `charts/`, `docs/`, the Makefile
 * and (in the main checkout) every sibling worktree under `.claude/` out of
 * reach entirely rather than merely denied by pattern.
 *
 * Measured, not guessed: crawling the SPA's module graph — its entry plus every
 * module under `src/`, 652 modules — turns up exactly three files outside the
 * web root, all in the hoisted root `node_modules`. The aliased `@lobu/core/*`
 * subpaths never appear because Vite's dep optimizer pre-bundles them into
 * `<webRoot>/node_modules/.vite/deps/`, which esbuild reads straight off disk,
 * so `fs.allow` never applies to them.
 *
 * `packages` is allowed anyway. Nothing in the crawl needs it today, but
 * `vite.config.ts` aliases `@lobu/core/*` at `../core/src/*.ts`, and its own
 * comment records that a miss there "is invisible to every gate ... Only the
 * dev server breaks". Allowing the tree costs nothing — the state dirs inside
 * it (`workspaces`, `.lobu`) are denied below — and spares the next person a
 * dev-only breakage no CI job would catch.
 */
export function devViteFsAllow(servedRoot: string, webRoot: string): string[] {
	const root = servedRoot.replace(/\/+$/, "");
	return [webRoot, `${root}/node_modules`, `${root}/packages`];
}

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

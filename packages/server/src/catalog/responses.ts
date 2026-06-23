import type { CatalogEntry, CatalogKind } from "./types";

export function buildCatalogListResponse(
	kinds: CatalogKind[],
	all: Record<CatalogKind, CatalogEntry[]>,
): {
	catalogs: Record<string, { kind: CatalogKind; entries: CatalogEntry[] }>;
} {
	const catalogs: Record<
		string,
		{ kind: CatalogKind; entries: CatalogEntry[] }
	> = {};
	for (const kind of kinds) {
		catalogs[kind] = { kind, entries: all[kind] };
	}
	return { catalogs };
}

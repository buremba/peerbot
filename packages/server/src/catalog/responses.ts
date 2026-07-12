import type { CatalogEntry, CatalogKind } from "./types";
import { getCatalogConnectorInstallability } from "../utils/connector-catalog";

export function withConnectorInstallability(entry: CatalogEntry): CatalogEntry {
	const availability = getCatalogConnectorInstallability(entry.id);
	return {
		...entry,
		detail: {
			...entry.detail,
			installable: availability.installable,
			...(availability.installable
				? {}
				: {
						installability_reason: availability.reason,
						installability_message: availability.message,
					}),
		},
	};
}

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
		catalogs[kind] = {
			kind,
			entries:
				kind === "connectors"
					? all[kind].map(withConnectorInstallability)
					: all[kind],
		};
	}
	return { catalogs };
}

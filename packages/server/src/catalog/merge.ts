import type { CatalogEntry, InstalledItem } from "./types";

function actionCountFromSchema(actionsSchema: unknown): number {
	if (!actionsSchema || typeof actionsSchema !== "object") return 0;
	return Object.keys(actionsSchema).length;
}

function sortConnectorItems(items: InstalledItem[]): InstalledItem[] {
	return [...items].sort((a, b) => {
		const aInstalled = Boolean(a.detail.installed);
		const bInstalled = Boolean(b.detail.installed);
		if (aInstalled && !bInstalled) return -1;
		if (!aInstalled && bInstalled) return 1;
		return a.name.localeCompare(b.name);
	});
}

export function mergeConnectorInstalledWithCatalog(
	installed: InstalledItem[],
	catalog: CatalogEntry[],
): InstalledItem[] {
	const merged = new Map<string, InstalledItem>();

	for (const item of installed) {
		merged.set(item.id, {
			...item,
			detail: {
				...item.detail,
				installed: true,
				installable: false,
				catalog_origin: "org",
			},
		});
	}

	for (const entry of catalog) {
		if (merged.has(entry.id)) continue;
		const detail = entry.detail;
		const actionCount = actionCountFromSchema(detail.actions_schema);
		merged.set(entry.id, {
			id: entry.id,
			name: entry.name,
			detail: {
				...detail,
				version: entry.version ?? "0.0.0",
				description: entry.description ?? null,
				status: "active",
				installed: false,
				installable: true,
				catalog_origin: "catalog",
				operations_summary: {
					total: actionCount,
					reads: 0,
					writes: actionCount,
					local_action: actionCount,
					mcp_tool: 0,
					http_operation: 0,
				},
				has_operations: actionCount > 0,
			},
		});
	}

	return sortConnectorItems([...merged.values()]);
}

export function mergeSkillInstalledWithCatalog(
	installed: InstalledItem[],
	catalog: CatalogEntry[],
): InstalledItem[] {
	const merged = new Map<string, InstalledItem>();

	for (const item of installed) {
		merged.set(item.id, {
			...item,
			detail: {
				...item.detail,
				installed: true,
			},
		});
	}

	for (const entry of catalog) {
		if (entry.detail?.hidden) continue;
		if (merged.has(entry.id)) continue;
		merged.set(entry.id, {
			id: entry.id,
			name: entry.name,
			detail: {
				...entry.detail,
				description: entry.description ?? undefined,
				installed: false,
			},
		});
	}

	return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function parseIncludeCatalog(raw: string | undefined): boolean {
	if (!raw?.trim()) return false;
	return raw
		.split(",")
		.map((part) => part.trim())
		.includes("catalog");
}

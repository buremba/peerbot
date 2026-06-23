/**
 * Unified catalog model:
 *
 * - **Global catalog** (`list_catalog` / GET /catalog): manifest files only
 *   (`LOBU_CATALOG_URIS`). Kinds: `connectors`, `skills`. No DB.
 *
 * - **Installed overlay** (`list_installed` / GET /installed): org or agent
 *   state layered on top of catalog browse.
 *
 *   | Kind        | Installed source                                      | Catalog DB? |
 *   |-------------|-------------------------------------------------------|-------------|
 *   | connectors  | `connector_definitions` (+ versions) per org          | yes         |
 *   | watchers    | watcher inventory rows                                | yes (rows)  |
 *   | skills      | agent `skillsConfig` in settings                      | no          |
 *   | providers   | agent `installedProviders` + module registry metadata | no          |
 *   | guardrails  | agent `guardrails` enable list + gateway registry     | no          |
 *   | channels    | agent platform connection rows                        | no          |
 *
 * Only connector *definitions* are persisted as installable catalog entries in
 * Postgres. Everything else is manifest/registry + settings overlay.
 */
export const CATALOG_MANIFEST_VERSION = 1;

export const CATALOG_KINDS = ["connectors", "skills"] as const;
export type CatalogKind = (typeof CATALOG_KINDS)[number];

export const ORG_INSTALLED_KINDS = ["connectors", "watchers"] as const;
export type OrgInstalledKind = (typeof ORG_INSTALLED_KINDS)[number];

export const AGENT_INSTALLED_KINDS = [
	"skills",
	"providers",
	"guardrails",
	"channels",
] as const;
export type AgentInstalledKind = (typeof AGENT_INSTALLED_KINDS)[number];

export interface CatalogEntry {
	id: string;
	name: string;
	version?: string;
	description?: string | null;
	detail: Record<string, unknown>;
}

export interface CatalogManifest {
	version: number;
	kind: CatalogKind;
	entries: CatalogEntry[];
}

export interface CatalogListResponse {
	catalogs: Partial<
		Record<CatalogKind, { kind: CatalogKind; entries: CatalogEntry[] }>
	>;
}

export interface InstalledItem {
	id: string;
	name: string;
	detail: Record<string, unknown>;
}

export interface InstalledListResponse {
	installed: Partial<
		Record<
			OrgInstalledKind | AgentInstalledKind,
			{ kind: string; items: InstalledItem[] }
		>
	>;
}

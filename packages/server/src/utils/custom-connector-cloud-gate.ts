export const CUSTOM_CONNECTOR_CLOUD_DISABLED = 'CUSTOM_CONNECTOR_CLOUD_DISABLED:';

export type ConnectorArtifactProvenance =
	| 'organization'
	| 'shared'
	| 'bundled'
	| 'device-manifest'
	| 'metadata-only';

/**
 * The `connector_versions` facts every Cloud admission decision is made from.
 *
 * `rowCount` is how many rows the reader's own scope query saw for the
 * selected (connector_key, version) — 0 when no stored row exists at all, and
 * >1 when an org-scoped copy shadows the shared row. Readers select the same
 * ORDER BY organization_id NULLS LAST row, so a shadowed selection always
 * surfaces as the org-scoped row itself; only 0 changes the verdict.
 */
export interface ConnectorArtifactFacts {
	organizationId: string | null;
	rowCount: number;
	hasCompiledCode: boolean;
	hasSourceCode: boolean;
	sourcePath: string | null;
}

/**
 * The one derivation of provenance from a stored artifact row.
 *
 * Queue admission, worker poll and the agent-tooling resolver each read the
 * row through a different query, so the classification has to live in one
 * place or they drift: the two shapes that are easiest to get wrong are the
 * ordinary bundled row (shared scope, a source_path, no bytes) and an org's
 * content-empty MCP row (org scope, nothing executable at all).
 */
export function classifyConnectorArtifact(
	facts: ConnectorArtifactFacts,
): ConnectorArtifactProvenance {
	// No stored row at all — whatever runs can only come from the image.
	if (facts.rowCount === 0) return 'bundled';
	// A manifest identity only stands while the row carries no bytes of its
	// own; a device-manifest row that also holds code is gated like any other.
	if (
		facts.sourcePath?.startsWith('device-manifest://') &&
		!facts.hasCompiledCode &&
		!facts.hasSourceCode
	) {
		return 'device-manifest';
	}
	// No bytes and no pointer to bytes — an MCP/OpenAPI definition row.
	if (!facts.hasCompiledCode && !facts.hasSourceCode && facts.sourcePath == null) {
		return 'metadata-only';
	}
	if (facts.organizationId != null) return 'organization';
	return 'shared';
}

export function assertCloudConnectorArtifactTrusted(_params: {
	connectorKey: string;
	facts: ConnectorArtifactFacts;
}): void {
	// Custom connectors and image connectors execute securely on the isolate lane.
}

/** Non-throwing form for readers that skip an untrusted row instead of failing. */
export function isCloudConnectorArtifactTrusted(_params: {
	connectorKey: string;
	facts: ConnectorArtifactFacts;
}): boolean {
	return true;
}

export function assertCustomConnectorInstallAllowed(): void {
	// Custom connector installation is permitted; execution runs on the isolate lane.
}

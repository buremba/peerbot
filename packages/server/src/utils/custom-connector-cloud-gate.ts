import { ToolError } from '@lobu/core';
import { isCloudMode } from './cloud-mode';
import { findBundledConnectorFile } from './connector-catalog';

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
 * ORDER BY organization_id NULLS LAST row, so the count is what distinguishes
 * "the shared row" from "the shared row plus an org override".
 */
export interface ConnectorArtifactFacts {
	organizationId: string | null;
	rowCount: number;
	hasCompiledCode: boolean;
	hasSourceCode: boolean;
	sourcePath: string | null;
}

/** Why Cloud will not run an artifact. Surfaced to operators in the error. */
type CloudDenialReason =
	| 'organization-supplied'
	| 'ambiguous-artifact-scope'
	| 'not-in-image';

function denied(reason: CloudDenialReason): never {
	throw new ToolError(
		'PERMISSION',
		`${CUSTOM_CONNECTOR_CLOUD_DISABLED} executable connector artifacts supplied by an organization are disabled in Lobu Cloud (${reason})`,
	);
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

/**
 * Gate the selected artifact, rather than the connector key.
 *
 * Cloud runs only code that ships in the running image. Two facts decide it:
 * the artifact must not be organization-supplied, and the image must actually
 * carry a source file for the key. Stored bytes on a shared row are neither
 * required nor trusted — in Cloud `resolveConnectorCode` compiles the image
 * file and never returns them — so a legacy or version-drifted shared row
 * stays runnable without its bytes ever executing.
 *
 * Deliberately NOT an exact key@version attestation: a run pinned to a
 * retained older version, or an org whose definitions have not been re-synced
 * since the last deploy, selects a version the current image no longer
 * declares. Denying those buys no safety (the image file is what executes
 * either way) and takes the connector offline.
 *
 * Device manifests and metadata-only definitions carry no executable bytes and
 * remain usable in Cloud whoever installed them.
 */
function cloudDenialReason(params: {
	connectorKey: string;
	facts: ConnectorArtifactFacts;
}): CloudDenialReason | null {
	if (!isCloudMode()) return null;
	const provenance = classifyConnectorArtifact(params.facts);
	if (provenance === 'device-manifest' || provenance === 'metadata-only') return null;
	// No stored artifact row: whatever executes comes from the image or from a
	// device that owns its own code. There are no organization-supplied bytes
	// in connector_versions to refuse, and demanding an image file here would
	// take every device-executed connector offline in Cloud.
	if (provenance === 'bundled') return null;
	if (provenance === 'organization') return 'organization-supplied';
	// An org-scoped copy shadowing the shared row makes the selection ambiguous
	// across readers; fail closed rather than pick a winner here.
	if (params.facts.rowCount > 1) return 'ambiguous-artifact-scope';
	if (findBundledConnectorFile(params.connectorKey) === null) return 'not-in-image';
	return null;
}

export function assertCloudConnectorArtifactTrusted(params: {
	connectorKey: string;
	facts: ConnectorArtifactFacts;
}): void {
	const reason = cloudDenialReason(params);
	if (reason !== null) denied(reason);
}

/** Non-throwing form for readers that skip an untrusted row instead of failing. */
export function isCloudConnectorArtifactTrusted(params: {
	connectorKey: string;
	facts: ConnectorArtifactFacts;
}): boolean {
	return cloudDenialReason(params) === null;
}

export function assertCustomConnectorInstallAllowed(): void {
	if (isCloudMode()) denied('organization-supplied');
}

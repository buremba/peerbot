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

/** Why Cloud will not run an artifact. Surfaced to operators in the error. */
type CloudDenialReason = 'organization-supplied' | 'not-in-image';

/**
 * What the org admin reading the run error can do about each denial.
 *
 * The reason code alone read as an outage: a refusal surfaced inside a sync or
 * reaction run as `not eligible (organization-supplied)` with nothing to say
 * what the supported path is. The two reasons do not share a remedy — one is
 * a tenant migration, one is deploy drift — so each names its own. Every
 * action named here must be one Cloud actually permits: source-code installs,
 * updates and rollbacks are all refused by `assertCustomConnectorInstallAllowed`,
 * so an OpenAPI connector (source metadata) is not a destination.
 */
const CLOUD_DENIAL_REMEDY: Record<CloudDenialReason, string> = {
	'organization-supplied':
		'Re-express this connector as an MCP server, ship it as a device connector from a paired device, or run it self-hosted.',
	'not-in-image':
		'The running image ships no source file for this connector key — it was removed or renamed since this version was installed, or the deploy is incomplete. Install its replacement from the current catalog, or contact support.',
};

function denied(reason: CloudDenialReason): never {
	throw new ToolError(
		'PERMISSION',
		`${CUSTOM_CONNECTOR_CLOUD_DISABLED} Lobu Cloud only runs connector code shipped in its own image; this artifact is not eligible (${reason}). ${CLOUD_DENIAL_REMEDY[reason]}`,
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
	// An org-scoped row for a key the image ships is admitted, because the org
	// bytes still never execute: `resolveConnectorCode` compiles the image file
	// in Cloud whatever the stored row's scope. Denying took the connector
	// offline and prevented nothing — the same argument already applied to
	// version drift and to a shared row holding non-image bytes.
	//
	// This is the ordinary state of a long-lived workspace, not an exotic one:
	// readers select `ORDER BY organization_id NULLS LAST`, so an org copy wins
	// the selection over the shared row, and `apply` wrote org copies for years
	// before the shared-row convention. A key the image does NOT ship is the
	// genuinely organization-authored case and stays denied.
	if (provenance === 'organization') {
		return findBundledConnectorFile(params.connectorKey) === null
			? 'organization-supplied'
			: null;
	}
	// A selected shared row is the only row in scope: readers order org rows
	// first and the two partial unique indexes allow one row per scope, so
	// there is no second candidate left to disambiguate.
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

import { ToolError } from '@lobu/core';
import { isCloudMode } from './cloud-mode';

export const CUSTOM_CONNECTOR_CLOUD_DISABLED = 'CUSTOM_CONNECTOR_CLOUD_DISABLED:';

export type ConnectorArtifactProvenance =
	| 'organization'
	| 'shared'
	| 'bundled'
	| 'device-manifest'
	| 'metadata-only';

function denied(): never {
	throw new ToolError(
		'PERMISSION',
		`${CUSTOM_CONNECTOR_CLOUD_DISABLED} executable connector artifacts supplied by an organization are disabled in Lobu Cloud`,
	);
}

/**
 * Gate the selected artifact, rather than the connector key. Bundled code is
 * image-trusted; device manifests and metadata-only MCP definitions contain
 * no executable bytes and remain usable in Cloud.
 */
export function assertCustomConnectorCloudAllowed(params: {
	provenance: ConnectorArtifactProvenance | null | undefined;
	hasExecutableBytes?: boolean;
	hasMatchingBundledSource?: boolean;
}): void {
	if (!isCloudMode()) return;
	if (!params.hasExecutableBytes) return;
	if (!params.provenance) denied();
	if (params.provenance === 'bundled' || params.provenance === 'metadata-only' || params.provenance === 'device-manifest') return;
	if (params.provenance === 'shared' && params.hasMatchingBundledSource) return;
	denied();
}

export function assertCustomConnectorInstallAllowed(): void {
	if (isCloudMode()) denied();
}

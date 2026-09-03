import { afterEach, describe, expect, test } from 'bun:test';
import {
	assertCloudConnectorArtifactTrusted,
	assertCustomConnectorInstallAllowed,
	classifyConnectorArtifact,
	type ConnectorArtifactFacts,
	CUSTOM_CONNECTOR_CLOUD_DISABLED,
} from '../../utils/custom-connector-cloud-gate';

const originalCloudMode = process.env.LOBU_CLOUD_MODE;

afterEach(() => {
	if (originalCloudMode === undefined) delete process.env.LOBU_CLOUD_MODE;
	else process.env.LOBU_CLOUD_MODE = originalCloudMode;
});

/** The row `upsertBundledConnectorForOrg` writes: a pointer, no bytes. */
const BUNDLED_SHARED_ROW: ConnectorArtifactFacts = {
	organizationId: null,
	rowCount: 1,
	hasCompiledCode: false,
	hasSourceCode: false,
	sourcePath: 'connectors/github.ts',
};

const facts = (over: Partial<ConnectorArtifactFacts>): ConnectorArtifactFacts => ({
	...BUNDLED_SHARED_ROW,
	...over,
});

/**
 * Provenance had three hand-written derivations before this gate existed (queue
 * admission, worker poll, agent tooling) and they disagreed about exactly the
 * two rows below. One derivation is the whole point of the module, so the row
 * shapes are pinned here rather than at each reader.
 */
describe('classifyConnectorArtifact', () => {
	test('the ordinary bundled row — a source_path and no bytes — is shared, not org code', () => {
		expect(classifyConnectorArtifact(BUNDLED_SHARED_ROW)).toBe('shared');
	});

	test("an org's content-empty definition row is metadata-only, not org code", () => {
		expect(
			classifyConnectorArtifact(
				facts({ organizationId: 'org_1', sourcePath: null }),
			),
		).toBe('metadata-only');
	});

	test('org-supplied bytes are organization however they were stored', () => {
		expect(
			classifyConnectorArtifact(facts({ organizationId: 'org_1', hasCompiledCode: true })),
		).toBe('organization');
		expect(
			classifyConnectorArtifact(
				facts({ organizationId: 'org_1', hasSourceCode: true, sourcePath: null }),
			),
		).toBe('organization');
	});

	test('no stored row at all is bundled — only the image can attest it', () => {
		expect(
			classifyConnectorArtifact(facts({ rowCount: 0, sourcePath: null })),
		).toBe('bundled');
	});

	test('a device manifest keeps its identity only while it carries no bytes', () => {
		expect(
			classifyConnectorArtifact(facts({ sourcePath: 'device-manifest://abc' })),
		).toBe('device-manifest');
		expect(
			classifyConnectorArtifact(
				facts({ sourcePath: 'device-manifest://abc', hasCompiledCode: true }),
			),
		).toBe('shared');
	});
});

describe('Cloud artifact admission', () => {
	test('self-host admits every artifact, including organization code', () => {
		delete process.env.LOBU_CLOUD_MODE;
		assertCloudConnectorArtifactTrusted({
			connectorKey: 'anything',
			facts: facts({ organizationId: 'org_1', hasCompiledCode: true }),
		});
		expect(() => assertCustomConnectorInstallAllowed()).not.toThrow();
	});

	/**
	 * The regression the first cut of this gate caused: the ordinary bundled row
	 * is what every Cloud connector actually has, and rejecting it took sync,
	 * auth and operation runs offline for the whole default catalog.
	 */
	test('Cloud admits the ordinary bundled row', () => {
		process.env.LOBU_CLOUD_MODE = 'true';
		assertCloudConnectorArtifactTrusted({ connectorKey: 'github', facts: BUNDLED_SHARED_ROW });
	});

	/**
	 * A run pinned to a retained older version, or an org not re-synced since
	 * the last deploy, selects a version the image no longer declares. The
	 * image file is what executes either way, so this must stay admitted.
	 */
	test('Cloud admits a shared row whose version the image no longer declares', () => {
		process.env.LOBU_CLOUD_MODE = 'true';
		assertCloudConnectorArtifactTrusted({
			connectorKey: 'github',
			facts: facts({ sourcePath: 'connectors/github.ts' }),
		});
	});

	/**
	 * A device-executed connector ships no gateway-side artifact row. There are
	 * no organization-supplied bytes to refuse, and demanding an image file
	 * would take the whole device lane offline in Cloud.
	 */
	test('Cloud admits a selection with no stored artifact row', () => {
		process.env.LOBU_CLOUD_MODE = 'true';
		assertCloudConnectorArtifactTrusted({
			connectorKey: 'chrome',
			facts: facts({ rowCount: 0, sourcePath: null }),
		});
	});

	test('Cloud admits custom and bundled connectors on isolate lane', () => {
		process.env.LOBU_CLOUD_MODE = 'true';
		expect(() =>
			assertCloudConnectorArtifactTrusted({
				connectorKey: 'custom_connector',
				facts: facts({ organizationId: 'org_1', hasCompiledCode: true }),
			}),
		).not.toThrow();
		expect(() => assertCustomConnectorInstallAllowed()).not.toThrow();
	});

	test('Cloud admits byte-free definitions, including org-installed ones', () => {
		process.env.LOBU_CLOUD_MODE = 'true';
		assertCloudConnectorArtifactTrusted({
			connectorKey: 'some_mcp_server',
			facts: facts({ organizationId: 'org_1', sourcePath: null }),
		});
		assertCloudConnectorArtifactTrusted({
			connectorKey: 'some_device_connector',
			facts: facts({ organizationId: 'org_1', sourcePath: 'device-manifest://abc' }),
		});
	});

	test('Cloud admits a shared row whose non-image bytes it will run on isolate lane', () => {
		process.env.LOBU_CLOUD_MODE = 'true';
		expect(() =>
			assertCloudConnectorArtifactTrusted({
				connectorKey: 'github',
				facts: facts({ hasCompiledCode: true, sourcePath: null }),
			}),
		).not.toThrow();
	});
});

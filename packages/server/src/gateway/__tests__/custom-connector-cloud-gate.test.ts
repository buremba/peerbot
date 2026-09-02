import { afterEach, describe, expect, test } from 'bun:test';
import { isToolError } from '@lobu/core';
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

function denial(act: () => void): Error {
	try {
		act();
	} catch (error) {
		// Callers may ignore the return, so the helper itself pins that the
		// throw was the Cloud denial and not some incidental error.
		expect((error as Error).message).toStartWith(CUSTOM_CONNECTOR_CLOUD_DISABLED);
		return error as Error;
	}
	expect.unreachable('expected Cloud denial');
}

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

	test('Cloud denies a stored shared artifact whose key the image does not ship', () => {
		process.env.LOBU_CLOUD_MODE = 'true';
		const error = denial(() =>
			assertCloudConnectorArtifactTrusted({
				connectorKey: 'not_a_bundled_connector',
				facts: BUNDLED_SHARED_ROW,
			}),
		);
		expect(isToolError(error)).toBe(true);
		expect(error).toMatchObject({ code: 'PERMISSION', retryable: false });
		expect(error.message.startsWith(CUSTOM_CONNECTOR_CLOUD_DISABLED)).toBe(true);
	});

	test('Cloud denies organization-supplied bytes even for a shipped key', () => {
		process.env.LOBU_CLOUD_MODE = 'true';
		denial(() =>
			assertCloudConnectorArtifactTrusted({
				connectorKey: 'github',
				facts: facts({ organizationId: 'org_1', hasSourceCode: true }),
			}),
		);
	});

	test('Cloud denies an org row shadowing the shared row', () => {
		process.env.LOBU_CLOUD_MODE = 'true';
		denial(() =>
			assertCloudConnectorArtifactTrusted({
				connectorKey: 'github',
				facts: facts({ rowCount: 2 }),
			}),
		);
	});

	/**
	 * Byte-free definitions are the MCP/OpenAPI and device-manifest lanes. They
	 * stay usable in Cloud whoever installed them — including an org — because
	 * there are no bytes for Cloud to refuse to execute.
	 */
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

	/**
	 * A legacy or fixture-written shared row may hold `compiled_code` that did
	 * not come from the image. Its bytes are never executed — in Cloud
	 * `resolveConnectorCode` compiles the image file — so admitting it costs
	 * nothing and keeps the connector online.
	 */
	test('Cloud admits a shared row whose non-image bytes it will ignore', () => {
		process.env.LOBU_CLOUD_MODE = 'true';
		assertCloudConnectorArtifactTrusted({
			connectorKey: 'github',
			facts: facts({ hasCompiledCode: true, sourcePath: null }),
		});
	});

	test('Cloud refuses every organization-supplied install entry point', () => {
		process.env.LOBU_CLOUD_MODE = 'true';
		expect(() => assertCustomConnectorInstallAllowed()).toThrow(
			CUSTOM_CONNECTOR_CLOUD_DISABLED,
		);
	});
});

/**
 * The reason code alone read as an outage inside a run: `not eligible
 * (organization-supplied)` says which policy fired, not what to do about it.
 * Each reason names its own remedy, and every remedy names only an action
 * Cloud actually permits.
 */
describe('Cloud denial names the remedy, not only the reason', () => {
	test('an organization-supplied artifact is pointed at the supported lanes', () => {
		process.env.LOBU_CLOUD_MODE = 'true';
		const error = denial(() =>
			assertCloudConnectorArtifactTrusted({
				connectorKey: 'github',
				facts: facts({ organizationId: 'org_1', hasCompiledCode: true }),
			}),
		);
		expect(error.message).toContain('(organization-supplied)');
		expect(error.message).toMatch(/MCP/);
		expect(error.message).toMatch(/device connector/);
		expect(error.message).toMatch(/self-hosted/);
		// Cloud refuses every source-code install, so an OpenAPI connector —
		// which is source metadata — must not be offered as a destination.
		expect(error.message).not.toMatch(/OpenAPI/);
	});

	test('a shadowed shared row says the copy has to be removed for the tenant', () => {
		process.env.LOBU_CLOUD_MODE = 'true';
		const error = denial(() =>
			assertCloudConnectorArtifactTrusted({
				connectorKey: 'github',
				facts: facts({ rowCount: 2 }),
			}),
		);
		expect(error.message).toContain('(ambiguous-artifact-scope)');
		expect(error.message).toMatch(/organization-scoped copy/);
		// No Cloud-permitted action deletes a connector_versions row, so the
		// remedy must not pretend the tenant can self-serve it.
		expect(error.message).toMatch(/contact support/);
	});

	test('a missing image file is told apart from a tenant problem', () => {
		process.env.LOBU_CLOUD_MODE = 'true';
		const error = denial(() =>
			assertCloudConnectorArtifactTrusted({
				connectorKey: 'not_a_bundled_connector',
				facts: BUNDLED_SHARED_ROW,
			}),
		);
		expect(error.message).toContain('(not-in-image)');
		expect(error.message).toMatch(/current catalog/);
		expect(error.message).not.toMatch(/MCP/);
	});

	test('the install refusal carries the organization-supplied remedy', () => {
		process.env.LOBU_CLOUD_MODE = 'true';
		const error = denial(() => assertCustomConnectorInstallAllowed());
		expect(error.message).toContain('(organization-supplied)');
		expect(error.message).toMatch(/MCP/);
	});
});

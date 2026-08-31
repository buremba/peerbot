import { afterEach, describe, expect, test } from 'bun:test';
import { isToolError } from '@lobu/core';
import {
	assertCustomConnectorCloudAllowed,
	assertCustomConnectorInstallAllowed,
	CUSTOM_CONNECTOR_CLOUD_DISABLED,
} from '../../utils/custom-connector-cloud-gate';

const originalCloudMode = process.env.LOBU_CLOUD_MODE;

afterEach(() => {
	if (originalCloudMode === undefined) delete process.env.LOBU_CLOUD_MODE;
	else process.env.LOBU_CLOUD_MODE = originalCloudMode;
});

describe('custom connector Cloud gate', () => {
	test('denies organization executable bytes with a structured non-retryable error', () => {
		process.env.LOBU_CLOUD_MODE = 'true';
		try {
			assertCustomConnectorCloudAllowed({ provenance: 'organization', hasExecutableBytes: true });
			expect.unreachable('expected Cloud denial');
		} catch (error) {
			expect(isToolError(error)).toBe(true);
			expect(error).toMatchObject({ code: 'PERMISSION', retryable: false });
			expect((error as Error).message.startsWith(CUSTOM_CONNECTOR_CLOUD_DISABLED)).toBe(true);
		}
	});

	test('allows shared legacy bytes only when the matching image bundle exists', () => {
		process.env.LOBU_CLOUD_MODE = 'true';
		expect(() => assertCustomConnectorCloudAllowed({
			provenance: 'shared', hasExecutableBytes: true, hasMatchingBundledSource: true,
		})).not.toThrow();
		expect(() => assertCustomConnectorCloudAllowed({
			provenance: 'shared', hasExecutableBytes: true, hasMatchingBundledSource: false,
		})).toThrow();
	});

	test('leaves self-host and metadata-only artifacts unchanged', () => {
		delete process.env.LOBU_CLOUD_MODE;
		expect(() => assertCustomConnectorInstallAllowed()).not.toThrow();
		process.env.LOBU_CLOUD_MODE = 'true';
		expect(() => assertCustomConnectorCloudAllowed({ provenance: 'metadata-only' })).not.toThrow();
		expect(() => assertCustomConnectorCloudAllowed({ provenance: 'device-manifest' })).not.toThrow();
	});
});

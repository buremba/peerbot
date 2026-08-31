import { describe, expect, it } from 'vitest';
import { scrubSentryEvent, scrubSentryValue } from '../sentry-scrubber';

const SECRET = 'SENTRY_SECRET_SENTINEL';

describe('Sentry credential scrubber', () => {
	it('removes URL queries and fragments while preserving route paths', () => {
		const value = scrubSentryValue(
			`GET https://example.test/api/v1/files/a?token=${SECRET}&state=x#fragment`,
		);
		expect(value).toBe('GET https://example.test/api/v1/files/a');
	});

	it('removes every query value, including duplicate, encoded, and mixed-case credentials', () => {
		const event = scrubSentryEvent({
			request: {
				url: `https://example.test/api/v1/files/artifact?ToKeN=${SECRET}&token=${SECRET}&sigNature=${SECRET}&x%2Dapi%2Dkey=${SECRET}#${SECRET}`,
			},
			message: `signed download failed: https://example.test/api/v1/files/artifact?token=${SECRET}`,
		});
		const serialized = JSON.stringify(event);
		expect(serialized).not.toContain(SECRET);
		expect(serialized).toContain('https://example.test/api/v1/files/artifact');
		expect(serialized).not.toContain('?');
		expect(serialized).not.toContain('#');
	});

	it('redacts mixed-case secret keys through nested arrays and objects', () => {
		const nested: Record<string, unknown> = {
			Authorization: `Bearer ${SECRET}`,
			'X-API-Key': SECRET,
			CoOkIe: SECRET,
			items: [{ signature: SECRET, safeRoute: '/api/v1/files/a' }],
		};
		const result = scrubSentryValue(nested) as Record<string, unknown>;
		expect(JSON.stringify(result)).not.toContain(SECRET);
		expect((result.items as Array<Record<string, unknown>>)[0]?.safeRoute).toBe(
			'/api/v1/files/a',
		);
	});

	it('handles errors, causes, breadcrumbs, and circular values', () => {
		const cause = new Error(`download failed at https://example.test/file?code=${SECRET}`);
		const error = new Error('outer', { cause });
		(error as Error & { extras?: unknown }).extras = { state: SECRET };
		const circular: Record<string, unknown> = { error, breadcrumb: { data: { token: SECRET } } };
		circular.self = circular;

		const event = scrubSentryEvent({
			message: error.message,
			extra: circular,
			breadcrumbs: [{ message: `failed https://example.test/file?token=${SECRET}`, data: circular }],
			exception: { values: [{ type: 'Error', value: error.message, mechanism: { data: circular } }] },
		});
		const serialized = JSON.stringify(event);
		expect(serialized).not.toContain(SECRET);
		expect(serialized).toContain('https://example.test/file');
		expect(serialized).toContain('[REDACTED]');
	});
});

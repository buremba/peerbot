import { describe, expect, it } from 'vitest';
import { scrubSentryErrorEvent, scrubSentryValue } from '../sentry-scrubber';

const SECRET = 'SENTRY_SECRET_SENTINEL';

describe('Sentry credential scrubber', () => {
	it('removes URL queries and fragments while preserving route paths', () => {
		const value = scrubSentryValue(
			`GET https://example.test/api/v1/files/a?token=${SECRET}&state=x#fragment`,
		);
		expect(value).toBe('GET https://example.test/api/v1/files/a');
	});

	it('removes every query value, including duplicate, encoded, and mixed-case credentials', () => {
		const event = scrubSentryErrorEvent({
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

		const event = scrubSentryErrorEvent({
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

	it('redacts credentials in relative URLs and bare query strings', () => {
		// Neither has a scheme, so a URL-only scrub never sees them. This is the
		// signed-download-token vector the scrubber exists to close.
		const relative = scrubSentryValue(
			`GET /api/v1/files/a?token=${SECRET}&page=2`,
		) as string;
		expect(relative).not.toContain(SECRET);
		expect(relative).toContain('/api/v1/files/a');
		expect(relative).toContain('page=2');

		const queryString = scrubSentryValue({
			request: { query_string: `signature=${SECRET}&limit=10` },
		}) as { request: { query_string: string } };
		expect(queryString.request.query_string).not.toContain(SECRET);
		expect(queryString.request.query_string).toContain('limit=10');
	});

	it('keeps triage fields whose names merely contain a secret word', () => {
		const result = scrubSentryValue({
			status_code: 500,
			error_code: 'E_TIMEOUT',
			stack_key: 'abc',
			code: SECRET,
			state: SECRET,
		}) as Record<string, unknown>;
		expect(result.status_code).toBe(500);
		expect(result.error_code).toBe('E_TIMEOUT');
		expect(result.stack_key).toBe('abc');
		expect(result.code).toBe('[REDACTED]');
		expect(result.state).toBe('[REDACTED]');
	});

	it('preserves an Error instead of flattening it to an empty object', () => {
		// name/message/stack live on the prototype, so Object.keys sees none of
		// them and a plain walk would discard the whole error.
		const error = new Error(`boom at https://example.test/f?token=${SECRET}`);
		const result = scrubSentryValue({ cause: error }) as {
			cause: { name: string; message: string; stack?: string };
		};
		expect(result.cause.name).toBe('Error');
		expect(result.cause.message).toContain('boom at');
		expect(result.cause.message).not.toContain(SECRET);
		expect(result.cause.stack).toBeDefined();
	});
});

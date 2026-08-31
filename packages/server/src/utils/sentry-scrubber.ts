import type { Breadcrumb, ErrorEvent } from '@sentry/node';

/**
 * Secret only as a whole key name. As substrings these match `status_code`,
 * `error_code`, and `stack_key` — the fields triage actually needs.
 */
const EXACT_SECRET_KEYS = new Set(['state', 'code', 'key']);
const SECRET_KEY_PATTERN =
	/(?:authorization|apikey|bearer|cookie|credential|password|secret|signature|token)/i;
const URL_PATTERN = /https?:\/\/[^\s"'<>]+/gi;
/**
 * A relative URL (`/api/v1/files/a?token=…`) and Sentry's own
 * `request.query_string` (`token=…`, no scheme and no path) never match
 * URL_PATTERN, so the signed-download token would survive a URL-only scrub.
 */
const QUERY_PAIR_PATTERN = /([?&;]|^)([A-Za-z0-9_.\-%[\]]+)=([^&;\s"'<>]*)/g;

function decodeKey(raw: string): string {
	try {
		return decodeURIComponent(raw);
	} catch {
		return raw;
	}
}

function isSecretKey(key: string): boolean {
	const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
	return EXACT_SECRET_KEYS.has(normalized) || SECRET_KEY_PATTERN.test(normalized);
}

function scrubString(value: string): string {
	const withoutUrlQueries = value.replace(URL_PATTERN, (candidate) => {
		try {
			const url = new URL(candidate.replace(/[),.;]+$/, ''));
			return `${url.origin}${url.pathname}`;
		} catch {
			return candidate;
		}
	});
	return withoutUrlQueries.replace(
		QUERY_PAIR_PATTERN,
		(match, lead: string, name: string) =>
			isSecretKey(decodeKey(name)) ? `${lead}${name}=[REDACTED]` : match
	);
}

/**
 * Recursively remove credential material from values headed for Sentry.
 * This is deliberately defensive: telemetry must never make an unusual
 * application value or a circular error object throw another error.
 */
export function scrubSentryValue(value: unknown): unknown {
	const seen = new WeakSet<object>();

	function scrub(current: unknown): unknown {
		if (typeof current === 'string') return scrubString(current);
		if (current === null || typeof current !== 'object') return current;
		if (seen.has(current)) return '[CIRCULAR]';
		seen.add(current);

		// An Error carries name/message/stack on its prototype, so Object.keys
		// returns nothing and a plain walk would flatten it to `{}` — discarding
		// the only part of the event worth reading.
		if (current instanceof Error) {
			const serialized: Record<string, unknown> = {
				name: current.name,
				message: scrubString(current.message),
			};
			if (current.stack) serialized.stack = scrubString(current.stack);
			if (current.cause !== undefined) serialized.cause = scrub(current.cause);
			for (const key of Object.keys(current)) {
				serialized[key] = isSecretKey(key)
					? '[REDACTED]'
					: scrub((current as unknown as Record<string, unknown>)[key]);
			}
			return serialized;
		}

		if (Array.isArray(current)) return current.map((item) => scrub(item));

		const result: Record<string, unknown> = {};
		try {
			for (const key of Object.keys(current)) {
				if (isSecretKey(key)) {
					result[key] = '[REDACTED]';
					continue;
				}
				try {
					result[key] = scrub((current as Record<string, unknown>)[key]);
				} catch {
					result[key] = '[UNREADABLE]';
				}
			}
		} catch {
			return '[UNREADABLE]';
		}
		return result;
	}

	return scrub(value);
}

export function scrubSentryErrorEvent(event: ErrorEvent): ErrorEvent {
	return scrubSentryValue(event) as ErrorEvent;
}

/** Never drops a breadcrumb; it only rewrites credential material in place. */
export function scrubSentryBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb {
	return scrubSentryValue(breadcrumb) as Breadcrumb;
}

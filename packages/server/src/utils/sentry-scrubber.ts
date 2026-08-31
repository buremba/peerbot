import type { Breadcrumb, ErrorEvent, Event } from '@sentry/node';

const SECRET_KEY_PATTERN = /(?:authorization|api[-_ ]?key|apikey|bearer|cookie|credential|password|secret|signature|state|token|code|key)/i;
const URL_PATTERN = /https?:\/\/[^\s"'<>]+/gi;

function scrubString(value: string): string {
	return value.replace(URL_PATTERN, (candidate) => {
		try {
			const url = new URL(candidate.replace(/[),.;]+$/, ''));
			return `${url.origin}${url.pathname}`;
		} catch {
			return candidate;
		}
	});
}

function isSecretKey(key: string): boolean {
	return SECRET_KEY_PATTERN.test(key.replace(/[^a-z0-9]/gi, ''));
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

export function scrubSentryEvent(event: Event): Event {
	return scrubSentryValue(event) as Event;
}

export function scrubSentryErrorEvent(event: ErrorEvent): ErrorEvent {
	return scrubSentryValue(event) as ErrorEvent;
}

export function scrubSentryBreadcrumb(
	breadcrumb: Breadcrumb,
): Breadcrumb | null {
	return scrubSentryValue(breadcrumb) as Breadcrumb;
}

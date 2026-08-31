import { isSecretKey, redactUriCredentials } from '@lobu/core';
import type { Breadcrumb, ErrorEvent, Event } from '@sentry/node';

/**
 * Secret as a QUERY PARAMETER name, and only there. `code` is an OAuth
 * authorization code in `?code=…` but a Node/Postgres error code
 * (`ECONNREFUSED`, `23505`) as an object key; `state` and `key` are the same
 * story. Context decides, so this stays separate from the shared key denylist
 * rather than widening it — redacting these as object keys would blank the
 * fields triage actually reads.
 */
const SECRET_QUERY_PARAMS = new Set(['state', 'code', 'key']);
/**
 * Credential key names the shared config denylist has no reason to carry:
 * request signatures reach telemetry (webhook headers, presigned URLs) but
 * never appear in connector config, and that denylist also feeds the CLI's
 * deployment manifest hash — widening it there would change hashes.
 */
const EXTRA_SECRET_KEYS = new Set(['signature', 'sig']);

/** Deep enough to outlive Sentry's own normalize(); short of unbounded work. */
const MAX_DEPTH = 8;
const MAX_ENTRIES = 1000;

/** Separator/case-squashed form, for keys core's camel-case split can't read. */
function squashKey(key: string): string {
	return key.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

/**
 * Object and header keys. Core's normalizer splits on case boundaries, so an
 * arbitrarily-cased header (`CoOkIe`) normalizes to `co_ok_ie` and misses;
 * test the squashed form too.
 */
function isSecretObjectKey(key: string): boolean {
	if (isSecretKey(key)) return true;
	if (isSecretKey(squashKey(key))) return true;
	// Matched per separated segment, not against the squashed whole:
	// `X-Hub-Signature-256` squashes to `xhubsignature256`, which no exact set
	// can ever hold, so every real signature header would slip through.
	return key
		.replace(/[^a-z0-9]+/gi, '_')
		.toLowerCase()
		.split('_')
		.some((segment) => EXTRA_SECRET_KEYS.has(segment));
}
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

function isSecretQueryParam(name: string): boolean {
	const key = decodeKey(name);
	return isSecretObjectKey(key) || SECRET_QUERY_PARAMS.has(squashKey(key));
}

function scrubString(value: string): string {
	// `postgres://user:pa55@host/db` carries its credential in the userinfo, not
	// in a query pair or a secret-named key, so neither pass below would see it.
	const withoutUriCredentials = redactUriCredentials(value);
	const withoutUrlQueries = withoutUriCredentials.replace(URL_PATTERN, (candidate) => {
		// Trailing sentence punctuation is not part of the URL, but it is part of
		// the message: strip it to parse, then put it back.
		const trailing = candidate.match(/[),.;]+$/)?.[0] ?? '';
		const bare = trailing ? candidate.slice(0, -trailing.length) : candidate;
		try {
			const url = new URL(bare);
			return `${url.origin}${url.pathname}${trailing}`;
		} catch {
			return candidate;
		}
	});
	return withoutUrlQueries.replace(
		QUERY_PAIR_PATTERN,
		(match, lead: string, name: string) =>
			isSecretQueryParam(name) ? `${lead}${name}=[REDACTED]` : match
	);
}

/**
 * Recursively remove credential material from values headed for Sentry.
 * This is deliberately defensive: telemetry must never make an unusual
 * application value or a circular error object throw another error.
 */
export function scrubSentryValue(value: unknown): unknown {
	const seen = new WeakSet<object>();

	function scrub(current: unknown, depth = 0): unknown {
		if (typeof current === 'string') return scrubString(current);
		if (current === null || typeof current !== 'object') return current;
		if (seen.has(current)) return '[CIRCULAR]';
		// beforeBreadcrumb runs BEFORE Sentry's own normalize(), so without a cap
		// a single console breadcrumb carrying a huge or deeply nested object is
		// fully deep-cloned on the hot path only to be truncated moments later.
		if (depth >= MAX_DEPTH) return '[TRUNCATED]';
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
			if (current.cause !== undefined) serialized.cause = scrub(current.cause, depth + 1);
			for (const key of Object.keys(current)) {
				serialized[key] = isSecretObjectKey(key)
					? '[REDACTED]'
					: scrub((current as unknown as Record<string, unknown>)[key], depth + 1);
			}
			return serialized;
		}

		// Built-ins whose state is not enumerable: walking them as plain objects
		// yields `{}` (Date, Map, Set, RegExp) or one key per byte (Buffer). A
		// readable summary costs less payload and tells triage strictly more.
		if (current instanceof Date) return current.toISOString();
		if (current instanceof RegExp) return String(current);
		if (ArrayBuffer.isView(current)) {
			return `[${current.constructor.name} ${current.byteLength} bytes]`;
		}
		if (current instanceof Map) return `[Map ${current.size} entries]`;
		if (current instanceof Set) return `[Set ${current.size} items]`;

		if (Array.isArray(current)) {
			return current.slice(0, MAX_ENTRIES).map((item) => scrub(item, depth + 1));
		}

		const result: Record<string, unknown> = {};
		try {
			for (const key of Object.keys(current).slice(0, MAX_ENTRIES)) {
				if (isSecretObjectKey(key)) {
					result[key] = '[REDACTED]';
					continue;
				}
				try {
					result[key] = scrub((current as Record<string, unknown>)[key], depth + 1);
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

/**
 * `sdkProcessingMetadata` holds the live Scope -> Client -> options graph, and
 * @sentry/core deletes the field outright in createEventEnvelope. Deep-walking
 * it is therefore pure per-event work on a structure that never ships, and it
 * is the only part of a prepared event holding class instances. Detach it for
 * the walk and put the original reference back.
 */
function scrubEvent<T extends Event>(event: T): T {
	const { sdkProcessingMetadata } = event;
	const scrubbed = scrubSentryValue({
		...event,
		sdkProcessingMetadata: undefined,
	}) as T;
	if (sdkProcessingMetadata !== undefined) {
		scrubbed.sdkProcessingMetadata = sdkProcessingMetadata;
	}
	return scrubbed;
}

export function scrubSentryErrorEvent(event: ErrorEvent): ErrorEvent {
	return scrubEvent(event);
}

/**
 * Transactions are sampled (0.02 prod, 1.0 dev) but not exempt: a span's
 * attributes carry the request URL, which is the very `?token=` vector the
 * error path scrubs. Without this they reach Sentry unscrubbed.
 */
// Generic over Event rather than naming TransactionEvent: @sentry/node does
// not re-export that type, and @sentry/core is not a direct dependency here.
// Inference recovers it exactly at the beforeSendTransaction call site.
export function scrubSentryTransactionEvent<T extends Event>(event: T): T {
	return scrubEvent(event);
}

/** Never drops a breadcrumb; it only rewrites credential material in place. */
export function scrubSentryBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb {
	return scrubSentryValue(breadcrumb) as Breadcrumb;
}

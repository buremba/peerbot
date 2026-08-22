/**
 * Server-side containment for browser connector ingestion and run output.
 *
 * This walks only payloads already identified as browser-owned. It is not a
 * general JSON redactor: non-browser connectors remain byte-identical.
 */

const BROWSER_REDACTED_MARKER = "REDACTED";

/** Shared, case-insensitive OAuth callback parameter vocabulary. */
const BROWSER_SENSITIVE_URL_KEYS = [
	"code",
	"state",
	"token",
	"access_token",
	"refresh_token",
	"id_token",
	"client_secret",
	"user_code",
	"code_verifier",
] as const;

const SENSITIVE_KEYS = new Set<string>(BROWSER_SENSITIVE_URL_KEYS);
const MAX_NESTED_CALLBACK_DEPTH = 3;
const MAX_ENCODED_CALLBACK_PROBE_DEPTH = 8;
const MAX_NESTED_BROWSER_DEPTH = 16;
const MAX_BROWSER_CONTAINERS = 10_000;
const BROWSER_TEXT_TOKEN_RE = /[^\s<>'"`]+/g;
const URL_FIELD_KEYS = new Set([
	"url",
	"urls",
	"href",
	"hrefs",
	"sourceurl",
	"fromurl",
	"browserurl",
	"resourceurl",
	"downloadurl",
	"callbackurl",
	"redirecturl",
	"currenturl",
	"pageurl",
	"taburl",
	"targeturl",
	"openerurl",
	"referrerurl",
	"documenturl",
	"finalurl",
	"originid",
	"parentoriginid",
	"resourceref",
	"formaction",
	"referrer",
]);
const TEXT_FIELD_KEYS = new Set([
	"title",
	"name",
	"label",
	"text",
	"body",
	"content",
	"fields",
	"inputtext",
	"fieldlabel",
	"parentfolderpath",
	"attributes",
	"payloadtext",
	"contentpreview",
	"description",
	"summary",
	"message",
	"error",
	"errormessage",
	"outputtail",
]);

function decodeParamKey(value: string): string {
	let decoded = value.replace(/\+/g, " ");
	for (let depth = 0; depth < MAX_NESTED_CALLBACK_DEPTH; depth++) {
		try {
			const next = decodeURIComponent(decoded);
			if (next === decoded) break;
			decoded = next;
		} catch {
			break;
		}
	}
	return decoded.toLowerCase();
}

function decodeValue(value: string): string | null {
	if (!value.includes("%") && !value.includes("+")) return value;
	try {
		return decodeURIComponent(value.replace(/\+/g, " "));
	} catch {
		return null;
	}
}

function encodeNestedValue(value: string): string {
	return encodeURIComponent(value);
}

function containsSensitiveParameter(value: string): boolean {
	for (const match of value.matchAll(
		/(?:^|[?#]|&(?:amp;)?)([^=&?#\s]+)=([^&#\s<>'"`]*)/g,
	)) {
		if (!SENSITIVE_KEYS.has(decodeParamKey(match[1] ?? ""))) continue;
		const decodedValue = decodeValue(match[2] ?? "");
		if (decodedValue && decodedValue !== BROWSER_REDACTED_MARKER) return true;
	}
	return false;
}

function containsNestedSensitiveParameter(value: string): boolean {
	let decoded = value;
	for (let depth = 0; depth < MAX_ENCODED_CALLBACK_PROBE_DEPTH; depth++) {
		if (containsSensitiveParameter(decoded)) return true;
		const next = decodeValue(decoded);
		if (next === null || next === decoded) return false;
		decoded = next;
	}
	return false;
}

function redactNestedValue(rawValue: string, depth: number): string {
	if (containsSensitiveParameter(rawValue)) return BROWSER_REDACTED_MARKER;
	const decoded = decodeValue(rawValue);
	if (decoded === null || decoded === rawValue) return rawValue;
	const sanitized = redactBrowserUrlInternal(decoded, depth + 1);
	if (sanitized !== decoded) return encodeNestedValue(sanitized);
	return containsSensitiveParameter(decoded) || depth >= MAX_NESTED_CALLBACK_DEPTH
		? BROWSER_REDACTED_MARKER
		: rawValue;
}

function redactParameterPart(part: string, depth: number): string {
	const equals = part.indexOf("=");
	if (equals < 0) return part;
	const key = part.slice(0, equals);
	const rawValue = part.slice(equals + 1);
	if (SENSITIVE_KEYS.has(decodeParamKey(key))) {
		return `${key}=${BROWSER_REDACTED_MARKER}`;
	}
	const nested = redactNestedValue(rawValue, depth);
	return nested === rawValue ? part : `${key}=${nested}`;
}

function redactUrlPart(url: string, depth: number): string {
	return url.replace(
		/(^|[?#]|&(?:amp;)?)([^=&?#\s]+)=([^&#\s<>'"`]+)/g,
		(_match, separator: string, key: string, value: string) =>
			`${separator}${redactParameterPart(`${key}=${value}`, depth)}`,
	);
}

function redactBrowserUrlInternal(value: string, depth: number): string {
	if (!value) return value;
	// Scan URL-like and opaque callback-shaped strings without requiring a valid
	// URL object. The delimiter requirement avoids rewriting ordinary prose such
	// as "code=an-example", while still covering malformed and scheme-less URLs.
	const sanitized = value.replace(BROWSER_TEXT_TOKEN_RE, (match) => {
		if (!match.includes("?") && !match.includes("#") && !match.includes("//")) {
			return match;
		}
		const trailing = match.match(/[),.;:!?\]}]+$/)?.[0] ?? "";
		const url = trailing ? match.slice(0, -trailing.length) : match;
		return `${redactUrlPart(url, depth)}${trailing}`;
	});
	if (sanitized !== value) return sanitized;
	if (depth >= MAX_NESTED_CALLBACK_DEPTH) {
		return containsNestedSensitiveParameter(value) ? BROWSER_REDACTED_MARKER : value;
	}

	// A complete callback URL can itself be percent-encoded (and occasionally
	// double-encoded). Decode only to the small bound above, then restore the
	// same nesting level around the sanitized URL.
	const decoded = decodeValue(value);
	if (decoded === null || decoded === value) return value;
	const nested = redactBrowserUrlInternal(decoded, depth + 1);
	if (nested !== decoded) return encodeNestedValue(nested);
	return containsSensitiveParameter(decoded) ? BROWSER_REDACTED_MARKER : value;
}

/** Redact query/fragment values while preserving parameter order and duplicates. */
function redactBrowserUrl(value: string): string {
	return redactBrowserUrlInternal(value, 0);
}

function normalizeFieldKey(key: string): string {
	return key.toLowerCase().replace(/[_-]/g, "");
}

function sanitizeKnownBrowserFields(
	value: unknown,
	depth: number,
	state: { containers: number },
	scanStrings = false,
): unknown {
	if (typeof value === "string") return scanStrings ? redactBrowserUrl(value) : value;
	if (value === null || typeof value !== "object") return value;
	state.containers += 1;
	if (depth > MAX_NESTED_BROWSER_DEPTH || state.containers > MAX_BROWSER_CONTAINERS) {
		// Browser payloads are untrusted. If the bounded walk cannot inspect a
		// branch, discard that branch rather than letting an attacker hide a URL
		// beyond the traversal budget.
		return BROWSER_REDACTED_MARKER;
	}
	if (Array.isArray(value)) {
		let changed = false;
		const out = value.map((item) => {
			const next = sanitizeKnownBrowserFields(item, depth + 1, state, scanStrings);
			if (next !== item) changed = true;
			return next;
		});
		return changed ? out : value;
	}

	const record = value as Record<string, unknown>;
	let changed = false;
	const out: Record<string, unknown> = { ...record };
	for (const [key, child] of Object.entries(record)) {
		const normalized = normalizeFieldKey(key);
		const childScansStrings =
			scanStrings || URL_FIELD_KEYS.has(normalized) || TEXT_FIELD_KEYS.has(normalized);
		const next = sanitizeKnownBrowserFields(child, depth + 1, state, childScansStrings);
		if (next !== child) {
			out[key] = next;
			changed = true;
		}
	}
	return changed ? out : value;
}

export function isBrowserConnectorKey(connectorKey: string | null | undefined): boolean {
	if (typeof connectorKey !== "string") return false;
	const normalized = connectorKey.toLowerCase();
	return normalized === "chrome" || normalized.startsWith("chrome.");
}

interface BrowserIngestionFields {
	originId?: string | null;
	parentOriginId?: string | null;
	title?: string | null;
	content?: string | null;
	sourceUrl?: string | null;
	payloadData?: Record<string, unknown>;
	payloadTemplate?: Record<string, unknown> | null;
	attachments?: unknown[];
	metadata?: Record<string, unknown>;
	interactionInput?: Record<string, unknown> | null;
	interactionOutput?: Record<string, unknown> | null;
	interactionError?: string | null;
}

/** Sanitize only known browser ingestion fields; return the same object when unchanged. */
export function sanitizeBrowserIngestionFields<T extends BrowserIngestionFields>(
	fields: T,
): T {
	const out = { ...fields } as T;
	let changed = false;
	for (const [key, value] of [
		["originId", fields.originId],
		["parentOriginId", fields.parentOriginId],
		["title", fields.title],
		["content", fields.content],
		["sourceUrl", fields.sourceUrl],
	] as const) {
		if (typeof value !== "string") continue;
		const redacted = redactBrowserUrl(value);
		if (redacted !== value) {
			(out as Record<string, unknown>)[key] = redacted;
			changed = true;
		}
	}
	for (const key of [
		"payloadData",
		"payloadTemplate",
		"attachments",
		"metadata",
		"interactionInput",
		"interactionOutput",
	] as const) {
		const value = fields[key];
		if (!value) continue;
		const redacted = sanitizeKnownBrowserFields(value, 0, { containers: 0 });
		if (redacted !== value) {
			(out as Record<string, unknown>)[key] = redacted;
			changed = true;
		}
	}
	if (typeof fields.interactionError === "string") {
		const redacted = redactBrowserUrl(fields.interactionError);
		if (redacted !== fields.interactionError) {
			(out as Record<string, unknown>).interactionError = redacted;
			changed = true;
		}
	}
	return changed ? out : fields;
}

export function sanitizeBrowserText(value: string | null | undefined): string | null | undefined {
	return typeof value === "string" ? redactBrowserUrl(value) : value;
}

export function sanitizeBrowserPayload<T>(value: T): T {
	return sanitizeKnownBrowserFields(value, 0, { containers: 0 }) as T;
}

/**
 * Evaluate and generic scrape return arbitrary page-derived data under `value`
 * or `result`. Deep-scan those unstructured branches; declared browser fields
 * elsewhere keep the narrow known-field policy used for browser payloads.
 */
export function sanitizeBrowserActionOutput<T>(value: T): T {
	const knownFields = sanitizeBrowserPayload(value);
	if (knownFields === null || typeof knownFields !== "object" || Array.isArray(knownFields)) {
		return knownFields;
	}

	const record = knownFields as Record<string, unknown>;
	let changed = false;
	const out: Record<string, unknown> = { ...record };
	const sanitizeResultBranch = (
		target: Record<string, unknown>,
		key: "value" | "result",
	): boolean => {
		if (!Object.hasOwn(target, key)) return false;
		const current = target[key];
		const sanitized = sanitizeKnownBrowserFields(current, 0, { containers: 0 }, true);
		if (sanitized !== current) {
			target[key] = sanitized;
			return true;
		}
		return false;
	};

	changed = sanitizeResultBranch(out, "value") || changed;
	changed = sanitizeResultBranch(out, "result") || changed;
	if (
		record.observation &&
		typeof record.observation === "object" &&
		!Array.isArray(record.observation)
	) {
		const observation = { ...(record.observation as Record<string, unknown>) };
		let observationChanged = sanitizeResultBranch(observation, "value");
		observationChanged = sanitizeResultBranch(observation, "result") || observationChanged;
		if (observationChanged) {
			out.observation = observation;
			changed = true;
		}
	}
	return changed ? (out as T) : knownFields;
}

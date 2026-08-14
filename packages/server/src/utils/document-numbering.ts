/**
 * Per-series, per-period GAPLESS document numbering (invoice `2026-000001`,
 * `2026-000002`, …) for entity types that declare it.
 *
 * ## Where the behaviour is declared
 *
 * As an `x-numbering` vendor extension on the entity type's `metadata_schema` —
 * the type definition is the single place a document rule lives.
 * `manage_entity_schema` stores `metadata_schema` verbatim, and the AJV singleton
 * runs with `strict: false`, so an unknown top-level `x-` key round-trips through
 * create/update and is ignored by metadata validation:
 *
 * ```jsonc
 * "x-numbering": {
 *   "field": "invoice_no",        // metadata field the number is stamped into
 *   "prefix": "INV",              // optional literal segment (omit for "2026-000001")
 *   "reset": "year",              // "year" | "month" | "never" — when the counter restarts
 *   "padding": 6,                 // zero-pad width of the sequence segment
 *   "separator": "-",             // optional, default "-"
 *   "series_field": "branch_code",// optional: metadata field that PARTITIONS the counter
 *   "timezone": "Europe/Istanbul" // optional IANA zone deciding the period boundary (default UTC)
 * }
 * ```
 *
 * ## Why gapless is stricter than unique, and what that forces
 *
 * A UNIQUE index or a Postgres SEQUENCE gives you no duplicates. Neither gives
 * you no GAPS: `nextval()` is deliberately non-transactional, so a rolled-back
 * insert burns its number forever. Tax authorities that mandate gapless
 * numbering (TR e-Fatura, DE GoBD, …) reject exactly that outcome.
 *
 * Gaplessness therefore requires the counter to be ORDINARY TABLE STATE mutated
 * INSIDE the caller's transaction:
 *
 *   1. `pg_advisory_xact_lock(ns, key)` on (org, type, series, period).
 *   2. UPSERT the counter row, `RETURNING last_value`.
 *   3. Stamp the formatted number into the entity metadata.
 *   4. INSERT the entity — same transaction.
 *
 * Commit makes the bump and the row durable together; ROLLBACK undoes the bump
 * and drops the lock, so the very next writer reuses the number. That is the
 * whole trick, and its price is explicit: every concurrent create for one
 * (org, type, series, period) SERIALIZES from step 1 to COMMIT. Throughput per
 * series is 1 / (lock-hold time), so the caller must never do network I/O
 * between allocation and commit. `createEntity`'s transaction wraps only the
 * INSERT, which is why this is affordable there and would not be affordable in
 * a long agent-driven transaction.
 *
 * ## Caller contract (unenforceable in SQL — read it)
 *
 * `allocateDocumentNumber` MUST be called with an OPEN TRANSACTION client. Handed
 * a pool client it still returns a number, but each statement is its own implicit
 * transaction: the advisory lock is released before the entity INSERT and a
 * failed INSERT leaves the counter bumped — i.e. a gap. Same caveat, same
 * reasoning as `getNextNumericId` in `tools/admin/helpers/db-helpers.ts`.
 * Postgres exposes no reliable in-transaction predicate at lock time (no xid is
 * assigned yet), so this is documented rather than detected.
 *
 * ## Where it is wired
 *
 * The ONLY production caller is `createEntity` (`utils/entity-management.ts`),
 * inside its existing `sql.begin`, immediately before `INSERT INTO entities`.
 * That placement is load-bearing — see the caller contract above. In particular
 * the entity mutation gate is NOT a valid seam: it runs on a pool client
 * (`sql: getDb()` in `manage_entity.ts`) in a different transaction, so anything
 * it allocated would commit early and be burned when the insert fails.
 *
 * Because approval-queued creates only reach `createEntity` when
 * `applyEntityChangeProposal` runs, a deferred create allocates at APPLY time; a
 * rejected proposal never touches a counter.
 *
 * KNOWN BYPASS: `utils/entity-link-upsert.ts` auto-creates entities from
 * connector-extracted links with its own INSERT (retried across up to three slug
 * variants) and does not allocate. A numbered document type auto-created from a
 * link therefore lands unnumbered. Numbering-declaring types are ERP documents
 * created deliberately, not link-extracted, so this is recorded rather than
 * fixed here — the retry loop would need restructuring to hold one transaction.
 *
 * `document_number_counters` ships in
 * `db/migrations/20260814120000_document_number_counters.sql`.
 */

import type { DbClient } from "../db/client";

/**
 * Namespace for `pg_advisory_xact_lock(key1, key2)`, kept in signed int32 range
 * as Postgres requires. "docn" = document-numbering; distinct from the events
 * dedup namespace so the two never falsely contend.
 */
export const DOCUMENT_NUMBER_LOCK_NAMESPACE = 0x646f636e;

/** When a series restarts its count. */
export type NumberingReset = "year" | "month" | "never";

export interface NumberingSpec {
	/** Metadata field the formatted number is written to. */
	field: string;
	/** Literal leading segment, or null for none. */
	prefix: string | null;
	reset: NumberingReset;
	/** Zero-pad width of the numeric segment. */
	padding: number;
	/** Segment joiner. */
	separator: string;
	/** Metadata field partitioning the counter (branch, till, …), or null. */
	seriesField: string | null;
	/** IANA zone deciding when the period rolls over. */
	timezone: string;
}

/** Raised for a malformed spec or an unusable series value. */
export class DocumentNumberingError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DocumentNumberingError";
	}
}

const MAX_PADDING = 18;

function asObject(value: unknown): Record<string, unknown> {
	if (!value) return {};
	if (typeof value === "string") {
		try {
			const parsed: unknown = JSON.parse(value);
			return parsed && typeof parsed === "object" && !Array.isArray(parsed)
				? (parsed as Record<string, unknown>)
				: {};
		} catch {
			return {};
		}
	}
	return typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function isValidTimezone(tz: string): boolean {
	try {
		new Intl.DateTimeFormat("en-CA", { timeZone: tz });
		return true;
	} catch {
		return false;
	}
}

/**
 * Read `x-numbering` off an entity type's `metadata_schema`.
 *
 * Returns null when the type declares no numbering (the overwhelmingly common
 * case — this is opt-in per type). THROWS on a malformed declaration rather than
 * ignoring it: a numbering rule that silently does nothing is how documents end
 * up unnumbered in an audit.
 */
export function parseNumberingSpec(
	metadataSchema: unknown,
): NumberingSpec | null {
	const schema = asObject(metadataSchema);
	const raw = schema["x-numbering"];
	if (raw == null) return null;
	if (typeof raw !== "object" || Array.isArray(raw)) {
		throw new DocumentNumberingError("x-numbering must be an object");
	}
	const obj = raw as Record<string, unknown>;

	const field = obj.field;
	if (typeof field !== "string" || field.length === 0) {
		throw new DocumentNumberingError(
			"x-numbering.field must be a non-empty string",
		);
	}

	const reset = obj.reset ?? "year";
	if (reset !== "year" && reset !== "month" && reset !== "never") {
		throw new DocumentNumberingError(
			'x-numbering.reset must be one of "year", "month", "never"',
		);
	}

	const paddingRaw = obj.padding ?? 6;
	if (
		typeof paddingRaw !== "number" ||
		!Number.isInteger(paddingRaw) ||
		paddingRaw < 1 ||
		paddingRaw > MAX_PADDING
	) {
		throw new DocumentNumberingError(
			`x-numbering.padding must be an integer between 1 and ${MAX_PADDING}`,
		);
	}

	const prefixRaw = obj.prefix ?? null;
	if (prefixRaw !== null && typeof prefixRaw !== "string") {
		throw new DocumentNumberingError("x-numbering.prefix must be a string");
	}

	const separatorRaw = obj.separator ?? "-";
	if (typeof separatorRaw !== "string") {
		throw new DocumentNumberingError("x-numbering.separator must be a string");
	}

	const seriesFieldRaw = obj.series_field ?? null;
	if (
		seriesFieldRaw !== null &&
		(typeof seriesFieldRaw !== "string" || seriesFieldRaw.length === 0)
	) {
		throw new DocumentNumberingError(
			"x-numbering.series_field must be a non-empty string",
		);
	}
	if (seriesFieldRaw === field) {
		throw new DocumentNumberingError(
			"x-numbering.series_field must differ from x-numbering.field",
		);
	}

	const timezoneRaw = obj.timezone ?? "UTC";
	if (typeof timezoneRaw !== "string" || !isValidTimezone(timezoneRaw)) {
		throw new DocumentNumberingError(
			"x-numbering.timezone must be a valid IANA time zone",
		);
	}

	return {
		field,
		prefix: prefixRaw === "" ? null : prefixRaw,
		reset,
		padding: paddingRaw,
		separator: separatorRaw,
		seriesField: seriesFieldRaw,
		timezone: timezoneRaw,
	};
}

/**
 * The period bucket a document created at `now` belongs to: `2026`, `2026-08`,
 * or `""` for a never-resetting series.
 *
 * Evaluated in the spec's zone, not the server's: an invoice cut at 01:30 on
 * 1 January in Istanbul belongs to the NEW fiscal year even though the server
 * clock still reads 31 December in UTC. Getting this wrong misfiles documents
 * across a year boundary, which is the one moment numbering is audited.
 */
export function derivePeriod(spec: NumberingSpec, now: Date): string {
	if (spec.reset === "never") return "";
	// en-CA renders ISO-ordered YYYY-MM-DD, so slicing is unambiguous.
	const formatted = new Intl.DateTimeFormat("en-CA", {
		timeZone: spec.timezone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(now);
	const [year, month] = formatted.split("-");
	return spec.reset === "year" ? year : `${year}-${month}`;
}

/**
 * The series partition for this document: `""` when the type declares no
 * `series_field`, else the metadata value under it.
 *
 * A declared series field that is missing or blank is an ERROR, never an empty
 * partition: silently folding a branch-less invoice into the shared `""` series
 * would interleave two branches' numbers in one run of counters.
 */
export function deriveSeries(
	spec: NumberingSpec,
	metadata: Record<string, unknown>,
): string {
	if (!spec.seriesField) return "";
	const value = metadata[spec.seriesField];
	if (typeof value === "string" && value.trim().length > 0) return value.trim();
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	throw new DocumentNumberingError(
		`Numbering series field "${spec.seriesField}" is required and must be a non-empty string or number.`,
	);
}

/** Render `prefix`, `period` and the zero-padded sequence into the final string. */
export function formatDocumentNumber(
	spec: NumberingSpec,
	period: string,
	sequence: number,
): string {
	const segments: string[] = [];
	if (spec.prefix) segments.push(spec.prefix);
	if (period) segments.push(period);
	segments.push(String(sequence).padStart(spec.padding, "0"));
	return segments.join(spec.separator);
}

/**
 * Stable 32-bit FNV-1a over the counter identity, used as the second advisory
 * lock key. Same construction as `eventDedupLockKey` in `utils/insert-event.ts`
 * — a collision only costs two unrelated series a little extra serialization,
 * never correctness, because the UPSERT below is keyed on the real primary key.
 */
export function documentNumberLockKey(args: {
	organizationId: string;
	entityTypeId: number;
	series: string;
	period: string;
}): number {
	const s = `${args.organizationId}:${args.entityTypeId}:${args.series}:${args.period}`;
	let hash = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		hash ^= s.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return hash | 0;
}

export interface AllocatedDocumentNumber {
	/** 1-based ordinal within (org, type, series, period). */
	sequence: number;
	/** The value to stamp into `metadata[spec.field]`. */
	formatted: string;
	series: string;
	period: string;
}

/**
 * Allocate the next number for one (org, type, series, period).
 *
 * `tx` MUST be an open transaction (see the caller contract at the top of this
 * file). The advisory lock is taken BEFORE the UPSERT so that the serialization
 * point stays put if the allocator ever grows a second statement (a manual
 * override check, a repair path reading `entities`); the UPSERT's own row lock
 * would otherwise be the only ordering, and it does not cover a read-then-write.
 *
 * Deadlock note: two transactions that allocate for two DIFFERENT series in
 * opposite order can deadlock on the two advisory locks. Postgres detects and
 * aborts one; the abort is safe (it burns no number). Allocate one number per
 * transaction, or sort by lock key, if a multi-document transaction is ever
 * introduced.
 */
export async function allocateDocumentNumber(
	tx: DbClient,
	args: {
		organizationId: string;
		entityTypeId: number;
		spec: NumberingSpec;
		metadata: Record<string, unknown>;
		now?: Date;
	},
): Promise<AllocatedDocumentNumber> {
	const series = deriveSeries(args.spec, args.metadata);
	const period = derivePeriod(args.spec, args.now ?? new Date());
	const lockKey = documentNumberLockKey({
		organizationId: args.organizationId,
		entityTypeId: args.entityTypeId,
		series,
		period,
	});

	await tx`
		SELECT pg_advisory_xact_lock(${DOCUMENT_NUMBER_LOCK_NAMESPACE}, ${lockKey})
	`;

	const rows = await tx<{ last_value: number }>`
		INSERT INTO document_number_counters (
			organization_id, entity_type_id, series, period, last_value, updated_at
		) VALUES (
			${args.organizationId}, ${args.entityTypeId}, ${series}, ${period}, 1, now()
		)
		ON CONFLICT (organization_id, entity_type_id, series, period)
		DO UPDATE SET
			last_value = document_number_counters.last_value + 1,
			updated_at = now()
		RETURNING last_value
	`;
	const sequence = Number(rows[0]?.last_value);
	if (!Number.isInteger(sequence) || sequence < 1) {
		throw new DocumentNumberingError(
			"Document number allocation returned no counter value.",
		);
	}

	return {
		sequence,
		formatted: formatDocumentNumber(args.spec, period, sequence),
		series,
		period,
	};
}

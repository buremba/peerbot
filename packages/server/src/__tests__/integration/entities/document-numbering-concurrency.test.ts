/**
 * Gapless per-year document numbering under concurrent writes.
 *
 * Gapless is strictly stronger than unique, so a UNIQUE index proves nothing
 * here — the interesting failures are (a) two writers reading the same counter
 * and emitting the same number, and (b) a rolled-back writer BURNING a number
 * so the series skips one. This suite exercises the real allocator from
 * `utils/document-numbering.ts` against real Postgres with real concurrent
 * transactions, and includes a NEGATIVE CONTROL showing a Postgres SEQUENCE —
 * the obvious wrong answer — leaving exactly the gap the design has to avoid.
 *
 * `document_number_counters` now ships in
 * `db/migrations/20260814120000_document_number_counters.sql`, so this suite uses
 * the migrated table (the harness runs migrations and TRUNCATEs between suites).
 * It must NOT create or drop that table itself — dropping it would silently
 * break every later suite sharing the database.
 *
 * This suite exercises the allocator directly. The end-to-end proof that the
 * real create path allocates, stamps, and rolls back correctly lives in
 * `document-numbering-create-path.test.ts`.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb } from "../../../db/client";
import {
	allocateDocumentNumber,
	DocumentNumberingError,
	derivePeriod,
	deriveSeries,
	formatDocumentNumber,
	type NumberingSpec,
	parseNumberingSpec,
} from "../../../utils/document-numbering";
import { cleanupTestDatabase } from "../../setup/test-db";
import {
	createTestOrganization,
	createTestUser,
} from "../../setup/test-fixtures";

const SPEC_SCHEMA = {
	type: "object",
	properties: { invoice_no: { type: "string" } },
	"x-numbering": {
		field: "invoice_no",
		reset: "year",
		padding: 6,
		timezone: "Europe/Istanbul",
	},
};

describe("gapless document numbering", () => {
	let organizationId: string;
	let entityTypeId: number;
	let createdBy: string;
	let spec: NumberingSpec;
	const sql = getDb();

	beforeAll(async () => {
		await cleanupTestDatabase();
		const org = await createTestOrganization({ name: "Numbering Test Org" });
		organizationId = org.id;
		const user = await createTestUser({ email: "numbering-owner@test.com" });
		createdBy = user.id;

		const rows = await sql<{ id: number }>`
      INSERT INTO entity_types (slug, name, organization_id, created_by, metadata_schema)
      VALUES ('numbering_invoice', 'Invoice', ${organizationId}, ${user.id}, ${sql.json(SPEC_SCHEMA)})
      RETURNING id
    `;
		entityTypeId = rows[0].id;

		const parsed = parseNumberingSpec(SPEC_SCHEMA);
		if (!parsed) throw new Error("fixture schema must declare x-numbering");
		spec = parsed;
	});

	afterAll(async () => {
		if (organizationId) {
			await sql`DELETE FROM entities WHERE organization_id = ${organizationId}`;
		}
		if (entityTypeId) {
			// Cascades this suite's document_number_counters rows away; the TABLE
			// itself is migration-owned and must survive for later suites.
			await sql`DELETE FROM entity_types WHERE id = ${entityTypeId}`;
		}
		await sql.unsafe(
			"DROP SEQUENCE IF EXISTS public.numbering_negative_control_seq",
		);
	});

	describe("spec parsing and formatting (table-free)", () => {
		it("returns null for a type that declares no numbering", () => {
			expect(parseNumberingSpec({ type: "object" })).toBeNull();
			expect(parseNumberingSpec(null)).toBeNull();
		});

		it("defaults reset/padding/separator and rejects malformed declarations", () => {
			const parsed = parseNumberingSpec({
				"x-numbering": { field: "invoice_no" },
			});
			expect(parsed).toMatchObject({
				field: "invoice_no",
				reset: "year",
				padding: 6,
				separator: "-",
				seriesField: null,
				timezone: "UTC",
			});

			expect(() => parseNumberingSpec({ "x-numbering": {} })).toThrow(
				DocumentNumberingError,
			);
			expect(() =>
				parseNumberingSpec({ "x-numbering": { field: "n", reset: "weekly" } }),
			).toThrow(/reset must be one of/);
			expect(() =>
				parseNumberingSpec({ "x-numbering": { field: "n", padding: 0 } }),
			).toThrow(/padding must be an integer/);
			expect(() =>
				parseNumberingSpec({
					"x-numbering": { field: "n", timezone: "Mars/Olympus" },
				}),
			).toThrow(/valid IANA time zone/);
			expect(() =>
				parseNumberingSpec({
					"x-numbering": { field: "n", series_field: "n" },
				}),
			).toThrow(/must differ from/);
		});

		it("formats 2026-000001 and honours prefix, padding and separator", () => {
			expect(formatDocumentNumber(spec, "2026", 1)).toBe("2026-000001");
			expect(formatDocumentNumber(spec, "2026", 42)).toBe("2026-000042");
			expect(formatDocumentNumber({ ...spec, prefix: "INV" }, "2026", 7)).toBe(
				"INV-2026-000007",
			);
			expect(
				formatDocumentNumber(
					{ ...spec, prefix: "INV", separator: "/", padding: 4 },
					"2026-08",
					7,
				),
			).toBe("INV/2026-08/0007");
			expect(formatDocumentNumber({ ...spec, reset: "never" }, "", 7)).toBe(
				"000007",
			);
		});

		it("buckets the period in the declared zone, not the server zone", () => {
			// 2025-12-31T22:30Z is already 2026-01-01 01:30 in Istanbul (UTC+3).
			const newYearEve = new Date("2025-12-31T22:30:00Z");
			expect(derivePeriod(spec, newYearEve)).toBe("2026");
			expect(derivePeriod({ ...spec, timezone: "UTC" }, newYearEve)).toBe(
				"2025",
			);
			expect(derivePeriod({ ...spec, reset: "month" }, newYearEve)).toBe(
				"2026-01",
			);
			expect(derivePeriod({ ...spec, reset: "never" }, newYearEve)).toBe("");
		});

		it("refuses to fold a missing series value into the shared partition", () => {
			const seriesSpec = { ...spec, seriesField: "branch_code" };
			expect(deriveSeries(seriesSpec, { branch_code: " IST " })).toBe("IST");
			expect(deriveSeries(seriesSpec, { branch_code: 7 })).toBe("7");
			expect(() => deriveSeries(seriesSpec, {})).toThrow(
				DocumentNumberingError,
			);
			expect(() => deriveSeries(seriesSpec, { branch_code: "  " })).toThrow(
				/is required/,
			);
		});
	});

	describe("concurrent allocation", () => {
		const WORKERS = 10;
		const ROUNDS = 5;
		const TOTAL = WORKERS * ROUNDS;
		const NOW = new Date("2026-06-15T12:00:00Z");

		it(`issues ${TOTAL} numbers under ${WORKERS}-way concurrency with no duplicates and no gaps`, async () => {
			// Each round is its own transaction that allocates AND inserts the
			// document — the shape production would use inside createEntity's
			// existing sql.begin.
			const runWorker = async (worker: number): Promise<string[]> => {
				const issued: string[] = [];
				for (let round = 0; round < ROUNDS; round++) {
					const formatted = await sql.begin(async (tx) => {
						const allocated = await allocateDocumentNumber(tx, {
							organizationId,
							entityTypeId,
							spec,
							metadata: {},
							now: NOW,
						});
						await tx`
              INSERT INTO entities (organization_id, entity_type_id, name, slug, created_by, metadata)
              VALUES (
                ${organizationId}, ${entityTypeId},
                ${`Invoice ${allocated.formatted}`}, ${`invoice-w${worker}-r${round}`},
                ${createdBy}, ${tx.json({ invoice_no: allocated.formatted, worker })}
              )
            `;
						return allocated.formatted;
					});
					issued.push(formatted as string);
				}
				return issued;
			};

			const issued = (
				await Promise.all(
					Array.from({ length: WORKERS }, (_, w) => runWorker(w)),
				)
			).flat();

			// No duplicates, and the set is exactly 1..TOTAL — i.e. no gaps.
			const expected = Array.from({ length: TOTAL }, (_, i) =>
				formatDocumentNumber(spec, "2026", i + 1),
			);
			expect(new Set(issued).size).toBe(TOTAL);
			expect([...issued].sort()).toEqual([...expected].sort());
			expect(issued).toContain("2026-000001");
			expect(issued).toContain(formatDocumentNumber(spec, "2026", TOTAL));

			// And the persisted documents agree with what was handed out.
			const stored = await sql<{ invoice_no: string }>`
        SELECT metadata->>'invoice_no' AS invoice_no
        FROM entities
        WHERE organization_id = ${organizationId} AND entity_type_id = ${entityTypeId}
        ORDER BY metadata->>'invoice_no'
      `;
			expect(stored.map((r) => r.invoice_no)).toEqual([...expected].sort());

			const counter = await sql<{ last_value: number }>`
        SELECT last_value FROM document_number_counters
        WHERE organization_id = ${organizationId}
          AND entity_type_id = ${entityTypeId}
          AND series = '' AND period = '2026'
      `;
			expect(Number(counter[0].last_value)).toBe(TOTAL);
		});

		it("does not burn a number when the writer transaction rolls back", async () => {
			const before = await sql<{ last_value: number }>`
        SELECT last_value FROM document_number_counters
        WHERE organization_id = ${organizationId}
          AND entity_type_id = ${entityTypeId}
          AND series = '' AND period = '2026'
      `;
			const nextSequence = Number(before[0]?.last_value ?? 0) + 1;
			let rolledBack = "";
			await expect(
				sql.begin(async (tx) => {
					const allocated = await allocateDocumentNumber(tx, {
						organizationId,
						entityTypeId,
						spec,
						metadata: {},
						now: NOW,
					});
					rolledBack = allocated.formatted;
					throw new Error("simulated failure after allocation");
				}),
			).rejects.toThrow("simulated failure after allocation");

			expect(rolledBack).toBe(formatDocumentNumber(spec, "2026", nextSequence));

			const next = await sql.begin(async (tx) =>
				allocateDocumentNumber(tx, {
					organizationId,
					entityTypeId,
					spec,
					metadata: {},
					now: NOW,
				}),
			);
			// The rolled-back allocation is REUSED, not skipped.
			expect((next as { formatted: string }).formatted).toBe(rolledBack);
			expect((next as { sequence: number }).sequence).toBe(nextSequence);
		});

		it("NEGATIVE CONTROL: a Postgres sequence burns the number on rollback", async () => {
			await sql.unsafe("CREATE SEQUENCE public.numbering_negative_control_seq");
			await expect(
				sql.begin(async (tx) => {
					const rows = await tx<{ nextval: number }>`
            SELECT nextval('public.numbering_negative_control_seq') AS nextval
          `;
					expect(Number(rows[0].nextval)).toBe(1);
					throw new Error("simulated failure after nextval");
				}),
			).rejects.toThrow("simulated failure after nextval");

			const after = await sql<{ nextval: number }>`
        SELECT nextval('public.numbering_negative_control_seq') AS nextval
      `;
			// 2, not 1: nextval is non-transactional, so number 1 is gone forever.
			expect(Number(after[0].nextval)).toBe(2);
		});

		it("keeps distinct series and periods on independent counters", async () => {
			const seriesSpec: NumberingSpec = { ...spec, seriesField: "branch_code" };
			const allocations = await Promise.all([
				sql.begin((tx) =>
					allocateDocumentNumber(tx, {
						organizationId,
						entityTypeId,
						spec: seriesSpec,
						metadata: { branch_code: "IST" },
						now: NOW,
					}),
				),
				sql.begin((tx) =>
					allocateDocumentNumber(tx, {
						organizationId,
						entityTypeId,
						spec: seriesSpec,
						metadata: { branch_code: "ANK" },
						now: NOW,
					}),
				),
				sql.begin((tx) =>
					allocateDocumentNumber(tx, {
						organizationId,
						entityTypeId,
						spec,
						metadata: {},
						now: new Date("2027-02-01T12:00:00Z"),
					}),
				),
			]);
			const [ist, ank, y2027] = allocations as Array<{
				sequence: number;
				formatted: string;
				series: string;
				period: string;
			}>;
			expect(ist.sequence).toBe(1);
			expect(ank.sequence).toBe(1);
			expect(y2027.sequence).toBe(1);
			expect(ist.series).toBe("IST");
			expect(y2027.period).toBe("2027");
			expect(y2027.formatted).toBe("2027-000001");
		});
	});
});

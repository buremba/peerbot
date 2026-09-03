/**
 * Structural + timing guard for the arrival settle budget.
 *
 * Automation windows select rows by `events.created_at`, and stop one settle
 * window short of the database clock. That offset is a bet about the WRITER:
 * `created_at` is stamped when the inserting statement runs, while the row only
 * becomes visible at commit, so any window whose horizon passes a row's
 * `created_at` before that row commits completes without it — silently, and
 * forever, because nothing ever re-offers it.
 *
 * The design's answer is to bound the writer rather than the reader. That answer
 * is only true while every `INSERT INTO events` site commits far inside the
 * budget, and nothing else in the codebase enforces it: the next insert site
 * added inside a long-running transaction reintroduces the hole with no local
 * symptom at all.
 *
 * So this suite does two things. It fails on an UNKNOWN insert site — a new one
 * is not necessarily wrong, but it must be looked at and then listed here
 * deliberately. And it measures the real end-to-end latency of the ordinary
 * ingestion path against the budget, so a regression that pushes a write from
 * milliseconds into tens of seconds fails here instead of in production.
 */

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { intervals } from "../../../config/intervals";
import { cleanupTestDatabase, getTestDb } from "../../setup/test-db";
import { createTestEntity, seedOwnerContext } from "../../setup/test-fixtures";
import { insertEvent } from "../../../utils/insert-event";

// packages/server/src/__tests__/integration/automations → packages/server/src
const SERVER_SRC = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../../..",
);

/**
 * The sanctioned `INSERT INTO events` sites. Paths are relative to
 * `packages/server/src`.
 *
 * `insert-event.ts` is a single statement on the pooled autocommit connection,
 * so its transaction IS the statement. `feedback.ts` wraps its inserts in an
 * explicit `sql.begin` alongside a `SELECT ... FOR UPDATE` and an `UPDATE runs`
 * — three local statements, no network call, so it still commits in single-digit
 * milliseconds. Neither reaches outside the database while its transaction is
 * open, which is the property the budget actually depends on.
 */
const SANCTIONED_INSERT_SITES = [
	// The one ingestion writer. Every connector row, every agent-written note,
	// every Automation output goes through it.
	"utils/insert-event.ts",
	// Automation feedback, written as an event so it is governed like any other
	// row rather than living in a side table.
	"tools/admin/manage_automations/feedback.ts",
].sort();

function walkTypeScriptFiles(directory: string, prefix = ""): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
		if (entry.isDirectory()) {
			return walkTypeScriptFiles(path.join(directory, entry.name), relative);
		}
		return entry.isFile() && entry.name.endsWith(".ts") ? [relative] : [];
	});
}

function findEventInsertSites(): string[] {
	// `git grep` keeps this honest against the real tree (respects .gitignore, no
	// stale build output). Daytona's staged-tree runner omits `.git`, so fall
	// back to walking the source rather than silently reporting zero sites.
	const res = spawnSync(
		"git",
		["grep", "-l", "INSERT INTO events (", "--", "src/**/*.ts"],
		{ cwd: path.resolve(SERVER_SRC, ".."), encoding: "utf8" },
	);
	const gitFiles = (res.stdout ?? "")
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	const files =
		res.status === 0 && gitFiles.length > 0
			? gitFiles.map((line) => line.replace(/^src\//, ""))
			: walkTypeScriptFiles(SERVER_SRC).filter((file) =>
					readFileSync(path.join(SERVER_SRC, file), "utf8").includes(
						"INSERT INTO events (",
					),
				);
	return files
		// Tests insert event rows freely — they are not production writers.
		.filter((file) => !file.includes("__tests__"))
		.sort();
}

describe("events insert-site guard", () => {
	it("every INSERT INTO events site is a known, sanctioned one", () => {
		const found = findEventInsertSites();
		expect(found.length).toBeGreaterThan(0); // guard against a broken grep
		expect(found).toEqual(SANCTIONED_INSERT_SITES);
	});

	it("no sanctioned site reaches outside the database while its insert is open", () => {
		for (const relPath of SANCTIONED_INSERT_SITES) {
			const source = readFileSync(path.join(SERVER_SRC, relPath), "utf8");
			// A local multi-statement transaction is fine — `feedback.ts` has one.
			// What is NOT fine is holding it open across a network call: that turns
			// a millisecond write into an arbitrary one, and the budget is the only
			// thing standing between that and a permanently skipped row.
			expect(
				/\bawait fetch\(|\bawait new Promise\(/.test(source),
				`${relPath} awaits a network call or a timer, and it inserts into ` +
					"events. The arrival horizon assumes every event write commits far " +
					`inside AUTOMATION_ARRIVAL_SETTLE_MS (default 60000ms); a write held ` +
					"open past it is skipped by a window that completes without ever " +
					"seeing the row. Move the call outside the transaction.",
			).toBe(false);
		}
	});
});

describe("the arrival settle budget covers the real write latency", () => {
	beforeEach(async () => {
		await cleanupTestDatabase();
	});

	it("commits an ordinary ingestion write orders of magnitude inside the budget", async () => {
		const seeded = await seedOwnerContext();
		const entity = await createTestEntity({
			name: "Settle budget subject",
			organization_id: seeded.org.id,
			created_by: seeded.user.id,
		});
		const sql = getTestDb();

		// The production default, not whatever this suite runs with (the suite
		// collapses it to zero so fixtures are visible immediately).
		const PRODUCTION_SETTLE_MS = 60_000;

		// Measure the whole write, not one statement: what matters is the gap
		// between `created_at` being stamped and the row being visible to a reader.
		const latencies: number[] = [];
		for (let i = 0; i < 20; i += 1) {
			const startedAt = Date.now();
			const inserted = await insertEvent({
				entityIds: [entity.id],
				organizationId: seeded.org.id,
				originId: `settle-budget-${i}`,
				title: `Settle budget probe ${i}`,
				content: "A row on the ordinary ingestion path.",
				semanticType: "content",
				occurredAt: new Date(),
			});
			const [row] = await sql<{ visible: boolean }>`
				SELECT true AS visible FROM events WHERE id = ${Number(inserted.id)}
			`;
			expect(row?.visible).toBe(true);
			latencies.push(Date.now() - startedAt);
		}

		const worst = Math.max(...latencies);
		// Two orders of magnitude of headroom, asserted as a ratio rather than a
		// raw millisecond ceiling so this stays meaningful if the budget changes.
		expect(worst).toBeLessThan(PRODUCTION_SETTLE_MS / 100);
	});
});

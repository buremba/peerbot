/**
 * Unit coverage for queryProjectsIdColumn — the save-time guard that catches
 * watcher source queries which omit an `id` column.
 *
 * Bug being pinned: watcher-mode content aggregation (queryContentData in
 * get_content.ts) keys every row by `row.id`, and the signed window_token only
 * carries those numeric ids. A source query like
 * `SELECT origin_id, payload_text FROM events` produces zero content_ids, so
 * complete_window reports `content_linked: 0` and SILENTLY skips the reaction —
 * even though the agent received the rows. We reject such queries at save time.
 */

import { describe, expect, it } from "bun:test";
import { queryProjectsIdColumn } from "../../utils/execute-data-sources";

describe("queryProjectsIdColumn", () => {
	it("accepts a query that projects id explicitly", () => {
		expect(queryProjectsIdColumn("SELECT id, payload_text FROM events")).toBe(
			true,
		);
	});

	it("accepts SELECT *", () => {
		expect(
			queryProjectsIdColumn("SELECT * FROM events ORDER BY occurred_at DESC"),
		).toBe(true);
	});

	it("accepts a table-qualified star (e.g. ev.*)", () => {
		expect(queryProjectsIdColumn("SELECT ev.* FROM events ev")).toBe(true);
	});

	it("accepts a qualified id column (e.g. e.id)", () => {
		expect(
			queryProjectsIdColumn("SELECT e.id, e.payload_text FROM events e"),
		).toBe(true);
	});

	it("accepts a column aliased AS id", () => {
		expect(
			queryProjectsIdColumn("SELECT event_id AS id, payload_text FROM events"),
		).toBe(true);
	});

	it("accepts a WITH/CTE query whose final projection includes id", () => {
		expect(
			queryProjectsIdColumn(
				"WITH x AS (SELECT * FROM events) SELECT id, payload_text FROM x",
			),
		).toBe(true);
	});

	// --- the bug: these omit id and would silently drop every row ---

	it("REJECTS a query that omits id (origin_id is not id)", () => {
		expect(
			queryProjectsIdColumn("SELECT origin_id, payload_text FROM events"),
		).toBe(false);
	});

	it("REJECTS a query selecting only non-id columns", () => {
		expect(
			queryProjectsIdColumn(
				"SELECT payload_text, author_name, occurred_at FROM events",
			),
		).toBe(false);
	});

	it("REJECTS a CTE query whose final projection omits id", () => {
		expect(
			queryProjectsIdColumn(
				"WITH x AS (SELECT id FROM events) SELECT origin_id FROM x",
			),
		).toBe(false);
	});

	it("fails open (returns true) on unparseable SQL so a parser edge case never blocks a save", () => {
		expect(queryProjectsIdColumn("this is not sql at all")).toBe(true);
	});

	it("tolerates watcher template placeholders ({{entityId}}, {{query.x}})", () => {
		expect(
			queryProjectsIdColumn(
				"SELECT id FROM events WHERE entity_ids @> ARRAY[{{entityId}}]",
			),
		).toBe(true);
		expect(
			queryProjectsIdColumn(
				"SELECT origin_id FROM events WHERE x = {{query.foo}}",
			),
		).toBe(false);
	});
});

import { describe, expect, it } from "bun:test";
import { parsePlatformsQuery } from "../../rest-api";
import { GetContentSchema } from "../../tools/get_content/schema";
import { validateToolArgs } from "../../tools/validate-args";
import { ToolUserError } from "../../utils/errors";

/**
 * REST wrappers pass args straight into getContent (withValidatedArgs).
 * After rejectUnknownKeys (#1836), any key not on GetContentSchema 400s —
 * including always-present booleans like legacy include_classifications=false.
 */
describe("read_knowledge REST → tool arg contract", () => {
	it("rejects legacy include_classifications (never a tool arg)", () => {
		expect(() =>
			validateToolArgs("read_knowledge", GetContentSchema, {
				include_classifications: true,
				include_classification: "summary",
				limit: 1,
			}),
		).toThrow(ToolUserError);
		try {
			validateToolArgs("read_knowledge", GetContentSchema, {
				include_classifications: false,
				limit: 1,
			});
			expect.unreachable("should reject");
		} catch (err) {
			expect(err).toBeInstanceOf(ToolUserError);
			expect((err as ToolUserError).message).toMatch(/include_classifications/);
		}
	});

	it("rejects singular platform (schema is platforms[])", () => {
		expect(() =>
			validateToolArgs("read_knowledge", GetContentSchema, {
				platform: "slack",
				limit: 1,
			}),
		).toThrow(/platform/);
	});

	it("accepts the public list shape REST must emit (no plural, platforms only)", () => {
		const coerced = validateToolArgs("read_knowledge", GetContentSchema, {
			sort_by: "date",
			sort_order: "desc",
			include_classification: "summary",
			limit: 1,
			offset: 0,
			platforms: ["slack"],
		});
		expect(coerced).toMatchObject({
			include_classification: "summary",
			platforms: ["slack"],
			limit: 1,
		});
		expect(coerced).not.toHaveProperty("include_classifications");
		expect(coerced).not.toHaveProperty("platform");
	});

	it("parsePlatformsQuery maps singular platform into platforms[]", () => {
		expect(parsePlatformsQuery(undefined, "slack")).toEqual(["slack"]);
		expect(parsePlatformsQuery("telegram,discord", undefined)).toEqual([
			"telegram",
			"discord",
		]);
		expect(parsePlatformsQuery("telegram", "slack")).toEqual([
			"telegram",
			"slack",
		]);
		expect(parsePlatformsQuery("slack", "slack")).toEqual(["slack"]);
		expect(parsePlatformsQuery(undefined, undefined)).toBeUndefined();
	});
});

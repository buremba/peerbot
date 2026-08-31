import { describe, expect, test } from "bun:test";
import { Value } from "@sinclair/typebox/value";
import { GetAutomationSchema } from "../../tools/get_automation";

describe("get_automation pagination contract", () => {
	test("accepts bounded integer pages", () => {
		expect(
			Value.Check(GetAutomationSchema, {
				automation_id: "1",
				page: 1,
				page_size: 500,
			}),
		).toBe(true);
	});

	test("rejects fractional, negative, and unbounded pages", () => {
		for (const pagination of [
			{ page: 0 },
			{ page: 1.5 },
			{ page: 1_000_001 },
			{ page_size: 0 },
			{ page_size: 1.5 },
			{ page_size: 501 },
		]) {
			expect(
				Value.Check(GetAutomationSchema, {
					automation_id: "1",
					...pagination,
				}),
			).toBe(false);
		}
	});
});

import { describe, expect, test } from "bun:test";
import GoogleChatConnector from "../gchat";

describe("Google Chat connector definition", () => {
	test("exposes the project-local Lobu command mapping", () => {
		const definition = new GoogleChatConnector().definition;
		const properties = definition.optionsSchema?.properties as
			| Record<string, Record<string, unknown>>
			| undefined;

		expect(definition.version).toBe("1.0.2");
		expect(properties?.helpCommandId).toMatchObject({
			type: "string",
			pattern: "^(?:[1-9][0-9]{0,2}|1000)$",
			title: "Lobu command ID",
		});
	});
});

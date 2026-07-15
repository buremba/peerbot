import { describe, expect, it } from "bun:test";
import { getRawDispatchTools } from "../../../tools/registry";
import { generateStrictToolPaths } from "../../../utils/openapi-generator";

/**
 * The strict projection is the single TypeBox source rendered for the typed
 * first-party client. These guards keep it faithful: every dispatch tool gets a
 * path, output schemas survive, discriminated unions are NOT flattened, and
 * server-internal input fields never reach the client.
 */
describe("generateStrictToolPaths", () => {
	const paths = generateStrictToolPaths();
	const tools = getRawDispatchTools();

	it("emits one POST /api/{orgSlug}/<tool> path per dispatch tool", () => {
		const emitted = Object.keys(paths).sort();
		const expected = tools.map((t) => `/api/{orgSlug}/${t.name}`).sort();
		expect(emitted).toEqual(expected);
		for (const [path, ops] of Object.entries(paths)) {
			expect(path).toMatch(/^\/api\/\{orgSlug\}\//);
			expect(ops.post).toBeDefined();
			expect(ops.post.operationId).toBe(path.split("/").pop());
			const orgParam = ops.post.parameters?.[0];
			expect(orgParam?.name).toBe("orgSlug");
			expect(orgParam?.in).toBe("path");
			expect(orgParam?.required).toBe(true);
		}
	});

	it("renders each tool's real output schema as the 200 response", () => {
		for (const tool of tools) {
			if (!tool.outputSchema) continue;
			const schema =
				paths[`/api/{orgSlug}/${tool.name}`].post.responses["200"].content[
					"application/json"
				].schema;
			// Not the permissive `{ additionalProperties: true }` fallback: a real
			// TypeBox result carries structure (object properties or a union).
			const hasShape =
				schema.anyOf !== undefined ||
				schema.oneOf !== undefined ||
				schema.properties !== undefined;
			expect(hasShape, `${tool.name} 200 should carry a typed shape`).toBe(
				true,
			);
		}
	});

	it("preserves discriminated-union request bodies (no flattening)", () => {
		// manage_connections is a Type.Union of per-action variants; the strict
		// projection must keep the union so hey-api emits a discriminated type.
		const body =
			paths["/api/{orgSlug}/manage_connections"].post.requestBody.content[
				"application/json"
			].schema;
		expect(body.anyOf ?? body.oneOf, "union must survive").toBeDefined();
	});

	it("drops server-internal input fields via the public schema", () => {
		const body =
			paths["/api/{orgSlug}/search_memory"].post.requestBody.content[
				"application/json"
			].schema;
		expect(body.properties?.query_embedding).toBeUndefined();
		expect(body.properties?.agent_id).toBeUndefined();
	});

	it("strips TypeBox internal $id/static keys", () => {
		const json = JSON.stringify(paths);
		expect(json).not.toContain('"$id"');
		expect(json).not.toContain('"static"');
	});
});

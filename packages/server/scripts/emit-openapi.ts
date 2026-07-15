/**
 * Emit the strict dispatch-tool OpenAPI paths to a standalone document.
 *
 * The full client-facing document (gateway routes + these tool paths) is served
 * live at `GET /lobu/api/docs/openapi.json` and is what `@lobu/client` is
 * generated from. This script emits ONLY the tool surface — no running server or
 * database required — so the domain half of the contract can be inspected,
 * diffed, or fed to `openapi-ts` offline.
 *
 * Usage: bun packages/server/scripts/emit-openapi.ts [outfile]
 */
import { writeFileSync } from "node:fs";
import { generateStrictToolPaths } from "../src/utils/openapi-generator";

const doc = {
	openapi: "3.1.0",
	info: {
		title: "Lobu API — dispatch tools",
		version: "1.0.0",
		description:
			"Strict projection of the dispatch-tool surface (POST /api/{orgSlug}/{tool}) from the server's TypeBox schemas.",
	},
	servers: [{ url: "http://localhost:8787", description: "Local development" }],
	paths: generateStrictToolPaths(),
};

const out = process.argv[2] ?? "/dev/stdout";
writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`);

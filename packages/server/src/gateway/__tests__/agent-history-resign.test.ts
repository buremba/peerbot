import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resignFileRefs } from "../routes/public/agent-history.js";
import { type ArtifactTestEnv, createArtifactTestEnv } from "./setup.js";

const BASE = "http://localhost:8954/lobu";
const ARTIFACT_ID = "11111111-1111-4111-8111-111111111111";
const NESTED_ARTIFACT_ID = "22222222-2222-4222-8222-222222222222";

describe("resignFileRefs", () => {
	let env: ArtifactTestEnv;

	beforeEach(() => {
		env = createArtifactTestEnv();
	});

	afterEach(() => env.cleanup());

	test("rewrites a tokenless artifact ref into a fresh signed absolute URL", () => {
		const out = resignFileRefs(
			`See [report.pdf](/api/v1/files/${ARTIFACT_ID})`,
			env.artifactStore,
			BASE,
		) as string;
		// The tokenless path is replaced by an absolute, signed download URL whose
		// path keeps the `/lobu` mount prefix and whose token validates.
		const match = out.match(/\((https?:\/\/[^)]+)\)/);
		expect(match).toBeTruthy();
		const url = new URL(match?.[1] as string);
		expect(url.pathname).toBe(`/lobu/api/v1/files/${ARTIFACT_ID}`);
		const token = url.searchParams.get("token");
		expect(token).toBeTruthy();
		expect(
			env.artifactStore.validateDownloadToken(token as string, ARTIFACT_ID).valid,
		).toBe(true);
	});

	test("walks nested content arrays and text parts", () => {
		const out = resignFileRefs(
			[{ type: "text", text: `[a.csv](/api/v1/files/${NESTED_ARTIFACT_ID})` }],
			env.artifactStore,
			BASE,
		) as Array<{ text: string }>;
		expect(out[0].text).toContain("token=");
		expect(out[0].text).toContain(`/lobu/api/v1/files/${NESTED_ARTIFACT_ID}`);
	});

	test("leaves non-artifact text and already-signed links untouched", () => {
		const plain = "just a [link](https://example.com) here";
		expect(resignFileRefs(plain, env.artifactStore, BASE)).toBe(plain);
		const signed = "[f](http://localhost:8954/lobu/api/v1/files/id?token=existing)";
		// Already has a query string → the negative lookahead skips it.
		expect(resignFileRefs(signed, env.artifactStore, BASE)).toBe(signed);
	});
});

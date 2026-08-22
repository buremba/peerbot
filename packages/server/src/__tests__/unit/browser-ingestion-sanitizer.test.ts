import { describe, expect, test } from "bun:test";
import {
	isBrowserConnectorKey,
	sanitizeBrowserActionOutput,
	sanitizeBrowserIngestionFields,
	sanitizeBrowserPayload,
	sanitizeBrowserText,
} from "../../utils/browser-ingestion-sanitizer";

const callbackValue = "old-client-callback-value";

describe("browser ingestion sanitizer", () => {
	test("redacts mixed-case, duplicate, encoded, query, and fragment values", () => {
		const url =
			`https://example.test/callback?Code=${callbackValue}&keep=1&code=second#STATE=fragment&keep=2`;
		const out = sanitizeBrowserText(url);

		expect(out).toBe(
			"https://example.test/callback?Code=REDACTED&keep=1&code=REDACTED#STATE=REDACTED&keep=2",
		);
		expect(out).not.toContain(callbackValue);
	});

	test("handles encoded keys, malformed URLs, and already-redacted values idempotently", () => {
		const input =
			"https://example.test/cb?%63%6f%64%65=encoded&access_token=REDACTED&x=1#broken%ZZ=value";
		const once = sanitizeBrowserText(input);
		expect(once).toContain("%63%6f%64%65=REDACTED");
		expect(sanitizeBrowserText(once)).toBe(once);
		expect(sanitizeBrowserText("opaque-callback?code=not-a-url")).toBe(
			"opaque-callback?code=REDACTED",
		);
		expect(sanitizeBrowserText("about:blank#access_token=fragment-secret")).toBe(
			"about:blank#access_token=REDACTED",
		);
		expect(sanitizeBrowserText("opaque-callback#state=fragment-secret")).toBe(
			"opaque-callback#state=REDACTED",
		);
		expect(
			sanitizeBrowserText("https://example.test/?%2563%256f%2564%2565=secret"),
		).toBe("https://example.test/?%2563%256f%2564%2565=REDACTED");
		expect(sanitizeBrowserText("Open https://example.test/?code=secret, then continue.")).toBe(
			"Open https://example.test/?code=REDACTED, then continue.",
		);
		expect(sanitizeBrowserText("https://example.test/?keep=1&amp;code=secret")).toBe(
			"https://example.test/?keep=1&amp;code=REDACTED",
		);
		expect(sanitizeBrowserText("code%3Dencoded-query-secret")).toBe("REDACTED");
		expect(sanitizeBrowserText("https://example.test/?next=code%3Dnested-secret")).toBe(
			"https://example.test/?next=REDACTED",
		);
		expect(
			sanitizeBrowserText(
				"https://example.test/?redirect=https%3A%2F%2Finner.test%2F%3Fcode%3Dsecret",
			),
		).toBe(
			"https://example.test/?redirect=https%3A%2F%2Finner.test%2F%3Fcode%3DREDACTED",
		);
		const encoded = sanitizeBrowserText(
			"https%3A%2F%2Finner.test%2F%3Fcode%3Dsecret",
		);
		expect(encoded).toBe(
			"https%3A%2F%2Finner.test%2F%3Fcode%3DREDACTED",
		);
		expect(sanitizeBrowserText(encoded)).toBe(encoded);
		const longBenignText = "a".repeat(100_000);
		expect(sanitizeBrowserText(longBenignText)).toBe(longBenignText);
		const doubleEncoded = encodeURIComponent(
			"https%3A%2F%2Finner.test%2F%3Fstate%3Ddouble-secret",
		);
		expect(sanitizeBrowserText(doubleEncoded)).not.toContain("double-secret");
		let overEncoded = "https://inner.test/?code=bounded-secret";
		for (let i = 0; i < 5; i++) overEncoded = encodeURIComponent(overEncoded);
		expect(sanitizeBrowserText(overEncoded)).not.toContain("bounded-secret");
		let benignEncoded = "https://inner.test/?keep=ordinary-value";
		for (let i = 0; i < 5; i++) benignEncoded = encodeURIComponent(benignEncoded);
		expect(sanitizeBrowserText(benignEncoded)).toBe(benignEncoded);
	});

	test("sanitizes browser fields before nested derivation, preview, and attachment persistence", () => {
		const input = {
			originId: `https://example.test/item?code=${callbackValue}`,
			parentOriginId: `https://example.test/parent?state=${callbackValue}`,
			title: `https://example.test/item?token=${callbackValue}`,
			content: `Opened https://example.test/?refresh_token=${callbackValue}`,
			sourceUrl: `https://example.test/?id_token=${callbackValue}`,
			payloadData: {
				url: `https://example.test/?client_secret=${callbackValue}`,
				form_action: `https://example.test/?code=${callbackValue}`,
				referrer: `https://example.test/?state=${callbackValue}`,
				origin_id: `https://example.test/?token=${callbackValue}`,
				nested: [{ href: `https://example.test/?user_code=${callbackValue}` }],
				unrelated: "unchanged",
			},
			attachments: [{ download_url: `https://example.test/?code=${callbackValue}` }],
			metadata: { from_url: `https://example.test/?state=${callbackValue}` },
		};
		const once = sanitizeBrowserIngestionFields(input);
		const twice = sanitizeBrowserIngestionFields(once);

		expect(twice).toEqual(once);
		expect(JSON.stringify(once)).not.toContain(callbackValue);
		expect(once.payloadData?.unrelated).toBe("unchanged");
		expect((once.payloadData?.nested as Array<Record<string, string>>)[0]?.href).toContain(
			"user_code=REDACTED",
		);
		expect(
			sanitizeBrowserPayload({ arbitrary: "https://example.test/?code=deep-secret" }),
		).toEqual({ arbitrary: "https://example.test/?code=deep-secret" });
		expect(sanitizeBrowserPayload({ value: "ordinary prose code=not-a-url" })).toEqual({
			value: "ordinary prose code=not-a-url",
		});
		expect(
			sanitizeBrowserPayload({ nested: { content_preview: "https://x.test/?code=secret" } }),
		).toEqual({ nested: { content_preview: "https://x.test/?code=REDACTED" } });
		expect(
			sanitizeBrowserPayload({ nested: { Source_URL: "https://x.test/#STATE=secret" } }),
		).toEqual({ nested: { Source_URL: "https://x.test/#STATE=REDACTED" } });
		let deep: Record<string, unknown> = { url: "https://x.test/?code=too-deep" };
		for (let i = 0; i < 18; i++) deep = { nested: deep };
		expect(JSON.stringify(sanitizeBrowserPayload(deep))).not.toContain("too-deep");
		const many = Array.from({ length: 10_001 }, (_, index) =>
			index === 10_000
				? { url: "https://x.test/?code=too-wide" }
				: { value: "ordinary" },
		);
		expect(JSON.stringify(sanitizeBrowserPayload({ records: many }))).not.toContain(
			"too-wide",
		);
		const separatelyBounded = sanitizeBrowserIngestionFields({
			payloadData: { records: many },
			attachments: [{ url: "https://x.test/?code=after-wide-field" }],
		});
		expect(separatelyBounded.attachments).toEqual([
			{ url: "https://x.test/?code=REDACTED" },
		]);
	});

	test("does not rewrite unrelated records and recognizes browser connector variants", () => {
		expect(isBrowserConnectorKey("chrome")).toBe(true);
		expect(isBrowserConnectorKey("chrome.tabs")).toBe(true);
		expect(isBrowserConnectorKey("Chrome.History")).toBe(true);
		expect(isBrowserConnectorKey("chromecast.demo")).toBe(false);
		expect(isBrowserConnectorKey("github")).toBe(false);
		expect(sanitizeBrowserPayload({ plain: "unchanged" })).toEqual({ plain: "unchanged" });
		expect(sanitizeBrowserPayload({ url: `chrome://callback?code=${callbackValue}` })).toEqual({
			url: "chrome://callback?code=REDACTED",
		});
	});

	test("deep-scans only known Chrome action result branches", () => {
		const arbitrary = `https://example.test/?code=${callbackValue}`;
		const once = sanitizeBrowserActionOutput({
			value: arbitrary,
			result: { rows: [{ arbitrary_key: arbitrary }] },
			responses: [{ body: arbitrary }],
			tree: [{ name: arbitrary }],
			observation: { value: arbitrary, result: { arbitrary_key: arbitrary } },
			unrelated: arbitrary,
		});
		const twice = sanitizeBrowserActionOutput(once);

		expect(twice).toEqual(once);
		expect(once.value).toBe("https://example.test/?code=REDACTED");
		expect(JSON.stringify(once.result)).not.toContain(callbackValue);
		expect(JSON.stringify(once.responses)).not.toContain(callbackValue);
		expect(JSON.stringify(once.tree)).not.toContain(callbackValue);
		expect(JSON.stringify(once.observation)).not.toContain(callbackValue);
		expect(once.unrelated).toBe(arbitrary);
	});

	test("sanitizes page-derived labels and values in browser payloads", () => {
		const arbitrary = `https://example.test/?code=${callbackValue}`;
		const out = sanitizeBrowserPayload({
			field_label: arbitrary,
			parent_folder_path: arbitrary,
			fields: [{ label: arbitrary, value: arbitrary }],
			automation_signals: [
				{
					url: arbitrary,
					resource_ref: arbitrary,
					input_text: arbitrary,
					attributes: { callback: arbitrary },
				},
			],
		});

		expect(JSON.stringify(out)).not.toContain(callbackValue);
	});
});

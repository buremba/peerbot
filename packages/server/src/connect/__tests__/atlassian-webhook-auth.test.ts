/**
 * Unit tests for the Atlassian OAuth-app webhook JWT verifier (HS256/384/512
 * bearer sent on dynamic-webhook deliveries). Pure-function coverage of the
 * rejection paths the gateway e2e test does not reach: alg confusion, expiry,
 * nbf, and malformed tokens.
 */

import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyAtlassianWebhookJwt } from "../atlassian-webhook-auth";

const SECRET = "jira-client-secret";

function b64url(value: unknown): string {
	return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function mintJwt(params: {
	secret?: string;
	alg?: string;
	algForSigning?: string;
	payload?: Record<string, unknown>;
}): string {
	const alg = params.alg ?? "HS256";
	const header = b64url({ alg, typ: "JWT" });
	const payload = b64url(
		params.payload ?? { exp: Math.floor(Date.now() / 1000) + 60 },
	);
	const digest = (params.algForSigning ?? alg)
		.replace("HS", "sha")
		.toLowerCase();
	const signature = createHmac(digest, params.secret ?? SECRET)
		.update(`${header}.${payload}`)
		.digest("base64url");
	return `${header}.${payload}.${signature}`;
}

describe("verifyAtlassianWebhookJwt", () => {
	it("accepts a valid HS256 token signed with the client secret", () => {
		expect(verifyAtlassianWebhookJwt(mintJwt({}), SECRET)).toBe(true);
	});

	it.each(["HS384", "HS512"] as const)("accepts %s", (alg) => {
		expect(verifyAtlassianWebhookJwt(mintJwt({ alg }), SECRET)).toBe(true);
	});

	it("rejects a token signed with a different secret", () => {
		expect(
			verifyAtlassianWebhookJwt(mintJwt({ secret: "forged" }), SECRET),
		).toBe(false);
	});

	it("rejects alg none and unknown algorithms", () => {
		const header = b64url({ alg: "none", typ: "JWT" });
		const payload = b64url({ exp: Math.floor(Date.now() / 1000) + 60 });
		expect(verifyAtlassianWebhookJwt(`${header}.${payload}.sig`, SECRET)).toBe(
			false,
		);
		expect(
			verifyAtlassianWebhookJwt(
				mintJwt({ alg: "RS256", algForSigning: "HS256" }),
				SECRET,
			),
		).toBe(false);
	});

	it("rejects a header/signature algorithm mismatch", () => {
		expect(
			verifyAtlassianWebhookJwt(
				mintJwt({ alg: "HS512", algForSigning: "HS256" }),
				SECRET,
			),
		).toBe(false);
	});

	it("rejects a tampered payload", () => {
		const token = mintJwt({});
		const [header, , signature] = token.split(".");
		const tampered = `${header}.${b64url({ exp: Math.floor(Date.now() / 1000) + 9999 })}.${signature}`;
		expect(verifyAtlassianWebhookJwt(tampered, SECRET)).toBe(false);
	});

	it("rejects an expired token and a non-numeric exp", () => {
		expect(
			verifyAtlassianWebhookJwt(
				mintJwt({ payload: { exp: Math.floor(Date.now() / 1000) - 10 } }),
				SECRET,
			),
		).toBe(false);
		expect(
			verifyAtlassianWebhookJwt(mintJwt({ payload: { exp: "soon" } }), SECRET),
		).toBe(false);
	});

	it("rejects a token that is not yet valid (nbf in the future)", () => {
		expect(
			verifyAtlassianWebhookJwt(
				mintJwt({
					payload: {
						exp: Math.floor(Date.now() / 1000) + 120,
						nbf: Math.floor(Date.now() / 1000) + 60,
					},
				}),
				SECRET,
			),
		).toBe(false);
	});

	it("accepts a signed token without exp/nbf claims", () => {
		expect(verifyAtlassianWebhookJwt(mintJwt({ payload: {} }), SECRET)).toBe(
			true,
		);
	});

	it("rejects malformed tokens", () => {
		expect(verifyAtlassianWebhookJwt("", SECRET)).toBe(false);
		expect(verifyAtlassianWebhookJwt("a.b", SECRET)).toBe(false);
		expect(verifyAtlassianWebhookJwt("..", SECRET)).toBe(false);
		expect(verifyAtlassianWebhookJwt("not-json.also-not.sig", SECRET)).toBe(
			false,
		);
		expect(verifyAtlassianWebhookJwt("x".repeat(20_000), SECRET)).toBe(false);
	});
});

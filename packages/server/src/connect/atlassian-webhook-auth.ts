import { createHmac, timingSafeEqual } from "node:crypto";
import { type DbClient, getDb } from "../db/client";
import { resolveAuthCredentials } from "../utils/auth-credential-secrets";

const JWT_ALGORITHMS = {
	HS256: "sha256",
	HS384: "sha384",
	HS512: "sha512",
} as const;

function stringConfig(
	config: Record<string, unknown>,
	key: string,
): string | undefined {
	const value = config[key];
	return typeof value === "string" && value.trim().length > 0
		? value.trim()
		: undefined;
}

function decodeJson(value: string): Record<string, unknown> | null {
	try {
		const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

/** Verify Atlassian's OAuth-app webhook JWT without ever logging the bearer. */
export function verifyAtlassianWebhookJwt(
	token: string,
	clientSecret: string,
	nowMs = Date.now(),
): boolean {
	if (!token || token.length > 16_384) return false;
	const parts = token.split(".");
	if (parts.length !== 3 || parts.some((part) => part.length === 0)) return false;
	const [encodedHeader, encodedPayload, encodedSignature] = parts;
	const header = decodeJson(encodedHeader);
	const payload = decodeJson(encodedPayload);
	if (!header || !payload) return false;
	const algorithm = header.alg;
	if (typeof algorithm !== "string" || !Object.hasOwn(JWT_ALGORITHMS, algorithm)) {
		return false;
	}
	const expected = createHmac(
		JWT_ALGORITHMS[algorithm as keyof typeof JWT_ALGORITHMS],
		clientSecret,
	)
		.update(`${encodedHeader}.${encodedPayload}`)
		.digest();
	// base64url decoding is lenient; malformed input decodes to the wrong length.
	const presented = Buffer.from(encodedSignature, "base64url");
	if (presented.length !== expected.length) return false;
	if (!timingSafeEqual(presented, expected)) return false;

	const nowSeconds = nowMs / 1000;
	if (
		payload.exp !== undefined &&
		(typeof payload.exp !== "number" ||
			!Number.isFinite(payload.exp) ||
			payload.exp <= nowSeconds)
	) {
		return false;
	}
	if (
		payload.nbf !== undefined &&
		(typeof payload.nbf !== "number" ||
			!Number.isFinite(payload.nbf) ||
			payload.nbf > nowSeconds)
	) {
		return false;
	}
	return true;
}

export async function verifyAtlassianWebhookAuthorization(params: {
	organizationId: string;
	connectionConfig: Record<string, unknown>;
	token: string;
	sql?: DbClient;
}): Promise<boolean> {
	const appSlug = stringConfig(
		params.connectionConfig,
		"jira_webhook_app_profile_slug",
	);
	if (!appSlug) return false;
	const sql = params.sql ?? getDb();
	const rows = await sql`
		SELECT id, connector_key, profile_kind, status, auth_data, provider
		FROM auth_profiles
		WHERE organization_id = ${params.organizationId}
		  AND slug = ${appSlug}
		LIMIT 1
	`;
	const profile = rows[0] as
		| {
				id: number;
				connector_key: string | null;
				profile_kind: string;
				status: string;
				auth_data: Record<string, unknown> | null;
				provider: string | null;
		  }
		| undefined;
	if (
		!profile ||
		profile.connector_key !== "jira" ||
		profile.profile_kind !== "oauth_app" ||
		profile.status !== "active" ||
		profile.provider?.toLowerCase() !== "jira"
	) {
		return false;
	}
	const credentials = await resolveAuthCredentials({
		organizationId: params.organizationId,
		authProfileId: Number(profile.id),
		authData: profile.auth_data,
	});
	const clientSecret = credentials.JIRA_CLIENT_SECRET;
	return typeof clientSecret === "string" && clientSecret.length > 0
		? verifyAtlassianWebhookJwt(params.token, clientSecret)
		: false;
}

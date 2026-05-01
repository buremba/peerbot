/**
 * Google verified-facts emitter.
 *
 * Reads the Google `userinfo` payload for an authenticated account and
 * emits `ConnectorFact[]` with appropriate assurance. The platform layer
 * passes the result to `engine.ingestFacts`.
 *
 * Capability declaration is published statically so a future CI lint can
 * assert that this file never emits a namespace it didn't declare.
 */

import type {
	ConnectorFact,
	ConnectorIdentityCapability,
} from "@lobu/connector-sdk";
import { normalizeEmail } from "@lobu/connector-sdk";
import { fetchUserInfoWithRaw } from "../../connect/oauth-providers";
import logger from "../../utils/logger";
import {
	type ConnectorEmitParams,
	type ConnectorEmitResult,
	registerConnector,
} from "../capability-registry";

const log = logger.child({ module: "identity-connector-google" });

const googleIdentityCapability: ConnectorIdentityCapability = {
	connectorKey: "google",
	produces: [
		{
			namespace: "email",
			assurance: "oauth_verified",
			notes:
				"Google's verified primary email; survives provider-level account changes via providerStableId.",
		},
		{
			namespace: "hosted_domain",
			assurance: "oauth_verified",
			notes:
				"Google Workspace `hd` claim. Present only for Workspace accounts; absent for personal Gmail.",
		},
	],
};

/**
 * Fetch Google's userinfo payload and translate into ConnectorFacts.
 *
 * Returns `null` on fetch failure or when the response shape is too sparse
 * to assert anything authoritative — the engine would otherwise interpret
 * an empty `facts` array as a tombstone signal.
 */
async function getVerifiedFactsFromGoogle(
	params: ConnectorEmitParams,
): Promise<ConnectorEmitResult | null> {
	if (!params.accessToken) return null;

	let payload: Awaited<ReturnType<typeof fetchUserInfoWithRaw>>;
	try {
		payload = await fetchUserInfoWithRaw({
			provider: "google",
			accessToken: params.accessToken,
		});
	} catch (err) {
		log.warn(
			{ err, sourceAccountId: params.sourceAccountId },
			"google userinfo fetch failed",
		);
		return null;
	}

	if (!payload.raw) return null;
	const raw = payload.raw as {
		sub?: unknown;
		id?: unknown;
		email?: unknown;
		email_verified?: unknown;
		verified_email?: unknown;
		hd?: unknown;
	};

	const providerStableId = String(raw.sub ?? raw.id ?? "");
	if (!providerStableId) {
		log.warn(
			{ sourceAccountId: params.sourceAccountId },
			"google userinfo missing sub/id",
		);
		return null;
	}

	// Empty-input footgun: ingestFacts treats `facts: []` as authoritative and
	// tombstones every prior fact. If userinfo came back without ANY of the
	// claim shapes we read from (no `email` key AND no `hd` key), we can't
	// distinguish "user has nothing to share" from "scope was reduced or the
	// response is malformed." Bail with null so the prior facts survive.
	const hasReadableShape = "email" in raw || "hd" in raw;
	if (!hasReadableShape) {
		log.warn(
			{ sourceAccountId: params.sourceAccountId, providerStableId },
			"google userinfo missing both email and hd claims; refusing to assert empty state",
		);
		return null;
	}

	const facts: ConnectorFact[] = [];

	// Email — emitted only when explicitly verified by Google. Google's
	// OAuth2 v2 endpoint returns `verified_email`; OIDC userinfo returns
	// `email_verified`. Require either field to be boolean true.
	const emailVerified = raw.email_verified === true || raw.verified_email === true;
	if (typeof raw.email === "string" && emailVerified) {
		const normalized = normalizeEmail(raw.email);
		if (normalized) {
			facts.push({
				namespace: "email",
				identifier: raw.email,
				normalizedValue: normalized,
				assurance: "oauth_verified",
				providerStableId,
				sourceAccountId: params.sourceAccountId,
			});
		}
	}

	// Hosted domain — Google Workspace only. Absent for personal accounts.
	if (typeof raw.hd === "string" && raw.hd.length > 0) {
		const normalized = raw.hd.toLowerCase();
		facts.push({
			namespace: "hosted_domain",
			identifier: raw.hd,
			normalizedValue: normalized,
			assurance: "oauth_verified",
			providerStableId,
			sourceAccountId: params.sourceAccountId,
		});
	}

	return { providerStableId, facts };
}

// Self-registration. Importing this module is the only thing core code
// has to do to enable the Google connector — there's no `case 'google'`
// branch anywhere in the engine or auth-hook.
registerConnector({
	capability: googleIdentityCapability,
	emit: getVerifiedFactsFromGoogle,
});

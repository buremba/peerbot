import { createLogger } from "@lobu/core";
import { getDb } from "../db/client";
import { listCatalogConnectorDefinitions } from "../utils/connector-catalog";
import {
	installUrlFor,
	lowerProvider,
	resolveAppInstallOnboardingCandidate,
	type OnboardingConnectorCandidate,
} from "./onboarding-intent-decision";
import { findExistingPersonalOrg } from "./personal-org-provisioning";

const logger = createLogger("auth-onboarding-intents");

const NEW_USER_KIND = "new_user_signup";
const INSTALL_APP_ACTION = "install_app";
const MARKER_TTL_MINUTES = 15;
const INTENT_TTL_HOURS = 24;

type Sql = ReturnType<typeof getDb>;

type PendingIntentRow = {
	id: string | number;
	provider: string | null;
	connector_key: string | null;
	payload: Record<string, unknown> | null;
};

async function resolveOnboardingOrgId(
	userId: string,
	sql: Sql,
): Promise<string | null> {
	const personalOrg = await findExistingPersonalOrg(userId, sql);
	if (personalOrg?.id) return personalOrg.id;

	const [membership] = (await sql`
    SELECT "organizationId" AS organization_id
    FROM "member"
    WHERE "userId" = ${userId}
    ORDER BY "createdAt" ASC
    LIMIT 1
  `) as Array<{ organization_id: string }>;
	return membership?.organization_id ?? null;
}

export async function markNewUserForOnboarding(userId: string): Promise<void> {
	const sql = getDb();
	await sql`
    INSERT INTO auth_onboarding_intents (
      user_id, kind, action, payload, expires_at
    ) VALUES (
      ${userId}, ${NEW_USER_KIND}, 'marker', '{}'::jsonb,
      NOW() + (${`${MARKER_TTL_MINUTES} minutes`})::interval
    )
    ON CONFLICT (user_id, kind)
      WHERE consumed_at IS NULL AND kind = 'new_user_signup'
    DO UPDATE SET expires_at = EXCLUDED.expires_at
  `;
}

export async function enqueueAppInstallOnboardingForNewSignup(params: {
	userId: string;
	providerId: string | null | undefined;
}): Promise<void> {
	const provider = lowerProvider(params.providerId);
	if (!provider || !params.userId) return;

	const sql = getDb();
	await sql.begin(async (tx) => {
		const [marker] = (await tx`
      SELECT id
      FROM auth_onboarding_intents
      WHERE user_id = ${params.userId}
        AND kind = ${NEW_USER_KIND}
        AND consumed_at IS NULL
        AND expires_at > NOW()
      ORDER BY created_at ASC
      LIMIT 1
      FOR UPDATE
    `) as Array<{ id: string | number }>;

		// No server-created new-user marker means this is a normal login or account
		// link. Do not redirect returning users based on connector absence.
		if (!marker) return;

		const organizationId = await resolveOnboardingOrgId(
			params.userId,
			tx as Sql,
		);
		if (!organizationId) {
			await tx`
        UPDATE auth_onboarding_intents
        SET consumed_at = NOW()
        WHERE id = ${marker.id}
      `;
			return;
		}

		const connectorRows = (await tx`
      SELECT key, auth_schema
      FROM connector_definitions
      WHERE organization_id = ${organizationId}
        AND status = 'active'
      ORDER BY updated_at DESC
    `) as OnboardingConnectorCandidate[];

		let match = resolveAppInstallOnboardingCandidate({
			hasNewUserMarker: true,
			providerId: provider,
			connectors: connectorRows,
		});
		if (!match) {
			const catalogRows = await listCatalogConnectorDefinitions();
			match = resolveAppInstallOnboardingCandidate({
				hasNewUserMarker: true,
				providerId: provider,
				connectors: catalogRows.map((row) => ({
					key: row.key,
					auth_schema: row.auth_schema,
				})),
			});
		}
		if (!match) {
			await tx`
        UPDATE auth_onboarding_intents
        SET consumed_at = NOW()
        WHERE id = ${marker.id}
      `;
			return;
		}

		await tx`
      INSERT INTO auth_onboarding_intents (
        user_id, kind, provider, connector_key, action, payload, expires_at
      ) VALUES (
        ${params.userId}, 'app_install', ${provider}, ${match.connectorKey},
        ${INSTALL_APP_ACTION},
        ${tx.json({ installShape: match.installShape })},
        NOW() + (${`${INTENT_TTL_HOURS} hours`})::interval
      )
      ON CONFLICT (user_id, action, connector_key)
        WHERE consumed_at IS NULL AND action = 'install_app'
      DO NOTHING
    `;

		await tx`
      UPDATE auth_onboarding_intents
      SET consumed_at = NOW()
      WHERE id = ${marker.id}
    `;
	});
}

export async function consumePendingOnboardingIntent(userId: string): Promise<{
	action: "install_app";
	connectorKey: string;
	provider: string;
	installUrl: string;
} | null> {
	const sql = getDb();
	const consumed = await sql.begin(async (tx) => {
		const [row] = (await tx`
      SELECT id, provider, connector_key, payload
      FROM auth_onboarding_intents
      WHERE user_id = ${userId}
        AND action = ${INSTALL_APP_ACTION}
        AND consumed_at IS NULL
        AND expires_at > NOW()
      ORDER BY created_at ASC
      LIMIT 1
      FOR UPDATE
    `) as PendingIntentRow[];

		if (!row) return null;

		await tx`
      UPDATE auth_onboarding_intents
      SET consumed_at = NOW()
      WHERE id = ${row.id}
    `;
		return row;
	});

	if (!consumed) return null;
	const provider = lowerProvider(consumed.provider);
	const connectorKey = consumed.connector_key?.trim();
	if (!provider || !connectorKey) {
		logger.warn({ userId, consumed }, "Skipping malformed onboarding intent");
		return null;
	}

	return {
		action: "install_app",
		connectorKey,
		provider,
		installUrl: installUrlFor(provider, consumed.payload?.installShape),
	};
}

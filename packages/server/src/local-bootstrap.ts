/**
 * Local-install bootstrap hooks — shared by BOTH `lobu run` backends:
 *
 *   - embedded Postgres (`embedded-runtime.ts`), always;
 *   - external postgres:// DATABASE_URL (`server.ts`), only when the CLI set
 *     LOBU_RUN_OWNS_DB=1.
 *
 * The hooks provision the synthetic `install_operator` user (+ its personal
 * org) and the default agent, so a fresh install is sign-in-able via
 * `/api/local-init` without a chicken-and-egg /sign-up. Both steps are
 * idempotent and never crash boot. They must run as pre-listen hooks: the
 * gateway init that precedes them establishes ENCRYPTION_KEY, which
 * `ensureInstallOperator` requires.
 *
 * 🚨 SAFETY INVARIANT — cloud/multi-replica prod must NEVER auto-provision
 * users or orgs. `LOBU_RUN_OWNS_DB=1` is set in exactly one place: the CLI's
 * `lobu run` command (`packages/cli/src/commands/dev.ts`) when it spawns the
 * server bundle for a single-operator local install. The prod chart
 * (`charts/lobu`) and deployment manifests never set it, so
 * `externalDbBootstrapHooks` returns `[]` there and prod boots stay
 * bootstrap-free. Do not gate bootstrap on anything weaker than this explicit
 * opt-in flag, and never set the flag from inside the server.
 */

import postgres from "postgres";
import { ensureBuilderAgent } from "./auth/builder-provisioning";
import { ensureDefaultAgent } from "./auth/default-provisioning";
import { ensureInstallOperator } from "./auth/install-operator";
import logger from "./utils/logger";

type PreListenHook = () => Promise<void> | void;

/**
 * The two local-install provisioning hooks, in order. `databaseUrl` must be
 * the final resolved postgres:// URL (embedded: the spawned cluster's TCP
 * URL; external: DATABASE_URL itself).
 */
export function buildLocalBootstrapHooks(databaseUrl: string): PreListenHook[] {
	return [
		// BEFORE listen so headless installs (CI, containers) sign in via
		// better-auth without a chicken-and-egg /sign-up. Provisions the
		// synthetic `install_operator` user; idempotent. Never crash boot.
		async () => {
			try {
				await ensureInstallOperator();
			} catch (err) {
				logger.error({ err }, "Install-operator provisioning failed");
			}
		},
		// Default-agent provisioning: resolve the personal org id each boot so
		// a returning user picks up the default agent.
		async () => {
			try {
				const rows = postgres(databaseUrl, { max: 1 });
				try {
					const orgs = (await rows`
            SELECT id FROM "organization"
            WHERE (metadata::jsonb)->>'personal_org_for_user_id' IS NOT NULL
            ORDER BY "createdAt" ASC LIMIT 1
          `) as unknown as Array<{ id: string }>;
					const orgId = orgs[0]?.id ?? null;
					if (orgId) {
						await ensureDefaultAgent(orgId);
						await ensureBuilderAgent(orgId);
					}
				} finally {
					await rows.end({ timeout: 1 });
				}
			} catch (err) {
				logger.warn({ err }, "Default-agent provisioning failed");
			}
		},
	];
}

/**
 * Flag-gated bootstrap for the external-DATABASE_URL branch. Returns the
 * bootstrap hooks ONLY when `LOBU_RUN_OWNS_DB === "1"` (the CLI-owned local
 * install marker — see the safety invariant above); otherwise `[]`, which is
 * what every cloud/prod deployment gets.
 */
export function externalDbBootstrapHooks(
	databaseUrl: string,
	env: NodeJS.ProcessEnv,
): PreListenHook[] {
	if (env.LOBU_RUN_OWNS_DB !== "1") return [];
	return buildLocalBootstrapHooks(databaseUrl);
}

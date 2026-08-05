/**
 * Local-install bootstrap hooks — shared by BOTH `lobu run` backends:
 *
 *   - embedded Postgres (`embedded-runtime.ts`), always;
 *   - external postgres:// DATABASE_URL (`server.ts`), only when the CLI set
 *     LOBU_RUN_OWNS_DB=1.
 *
 * The hook provisions the synthetic `install_operator` user (+ its personal
 * org), so a fresh install is sign-in-able via `/api/local-init` without a
 * chicken-and-egg /sign-up. Idempotent and never crashes boot. Must run as a
 * pre-listen hook: the gateway init that precedes it establishes
 * ENCRYPTION_KEY, which `ensureInstallOperator` requires.
 *
 * Agents are NOT auto-provisioned: users create their own agents explicitly
 * (`lobu init` / `lobu apply`, the web console, or the manage_agents tool).
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

import { ensureInstallOperator } from "./auth/install-operator";
import logger from "./utils/logger";

type PreListenHook = () => Promise<void> | void;

/**
 * The local-install provisioning hook. `_databaseUrl` is accepted for
 * call-site compatibility (embedded: the spawned cluster's TCP URL; external:
 * DATABASE_URL itself) but is no longer needed now that agent provisioning
 * is gone.
 */
export function buildLocalBootstrapHooks(_databaseUrl: string): PreListenHook[] {
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

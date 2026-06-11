/**
 * Lobu server entry point — single entry for both backends.
 *
 * DATABASE_URL selects the mode:
 *   - postgres:// URL     → connect to an external Postgres (prod, or a DB you run)
 *   - a path / file://    → spawn a local embedded Postgres rooted there
 *
 * Embedded boot lives in `./embedded-runtime` (statically imported below); the
 * heavy embedded deps — `embedded-postgres` + the pgvector injector — load via
 * `await import(...)` *inside* that module, so the external/prod path never
 * resolves or loads the embedded-postgres binary. Everything after the backend
 * is chosen is identical — the shared spine (Hono wrapper, middleware, routes,
 * httpServer timeouts, Vite, scheduler, signal handlers, shutdown ordering)
 * lives in `./server-lifecycle.ts`. DO NOT add `new Hono`, `app.use`,
 * `app.route`, `http.createServer`, or signal handlers here.
 */

// Refuse to boot under an unsupported Node major (isolated-vm gate). The module
// asserts on load, so this side-effect import MUST be first.
import "./utils/assert-node-version";

// Sentry must init before any other imports for auto-instrumentation.
import "./instrument";

import dotenv from "dotenv";

dotenv.config();

// Mac-app / `lobu context server ...` settings from ~/.config/lobu/config.json.
// After dotenv (so project .env wins) and before main() reads DATABASE_URL / PORT.
import { applyUserServerConfigToEnv } from "./utils/user-config";

applyUserServerConfigToEnv();

import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertExternalDepsResolvable } from "@lobu/connector-worker/compile";
import { getDb, probeListenNotify } from "./db/client";
import {
	resolveMigrationsDir,
	runMigrations,
	startEmbeddedRuntime,
} from "./embedded-runtime";
import { externalDbBootstrapHooks } from "./local-bootstrap";
import { getEnvFromProcess } from "./utils/env";
import logger from "./utils/logger";
import { assertSchemaUpToDate } from "./utils/schema-version-check";

const PACKAGE_REPO_ROOT = path.resolve(
	fileURLToPath(new URL(".", import.meta.url)),
	"../../..",
);

/** DATABASE_URL is external iff it's a postgres:// URL; anything else → embedded. */
function isExternal(databaseUrl: string | undefined): boolean {
	return !!databaseUrl && /^postgres(ql)?:\/\//i.test(databaseUrl.trim());
}

async function main(): Promise<void> {
	const raw = process.env.DATABASE_URL?.trim();
	const external = isExternal(raw);

	if (!process.env.LOBU_DEV_PROJECT_PATH) {
		// Downstream buildGatewayConfig() derives worker paths from this; without
		// it, running from a project subdir gets a wrong cwd-relative resolve.
		process.env.LOBU_DEV_PROJECT_PATH = PACKAGE_REPO_ROOT;
	}

	const port = parseInt(process.env.PORT || "8787", 10);
	// External: bind all interfaces by default (containers). Embedded: loopback
	// only — the local-init endpoint mints PATs with no auth challenge, so it
	// must not be reachable from the LAN unless the operator sets HOST.
	const host =
		process.env.HOST?.trim() || (external ? "0.0.0.0" : "127.0.0.1");

	let databaseReadiness: () => Promise<void>;
	let preListenHooks: Array<() => Promise<void> | void> = [];
	let extraTeardown: Array<() => Promise<void> | void> = [];

	// Local-install conveniences — ephemeral secrets + localhost URLs so a bare
	// `lobu run` works without hand-written env. Applies to the embedded backend
	// always, and to an external DATABASE_URL only when the CLI marked this
	// process a single-operator local install (LOBU_RUN_OWNS_DB=1 — see the
	// safety invariant below). Prod never sets the flag and always has these
	// set explicitly, so every guard no-ops there.
	if (!external || process.env.LOBU_RUN_OWNS_DB === "1") {
		if (!process.env.BETTER_AUTH_SECRET) {
			process.env.BETTER_AUTH_SECRET = randomBytes(32).toString("base64");
			logger.info(
				"Generated ephemeral BETTER_AUTH_SECRET — set in .env to persist sessions",
			);
		}
		if (!process.env.JWT_SECRET) {
			process.env.JWT_SECRET = randomBytes(32).toString("base64");
		}
		if (!process.env.PUBLIC_WEB_URL) {
			process.env.PUBLIC_WEB_URL = `http://localhost:${port}`;
		}
		if (!process.env.NODE_ENV) {
			process.env.NODE_ENV = "development";
		}
	}

	if (external) {
		// `external` is true only for a non-empty postgres:// URL, so `raw` is
		// defined here; bind it to a non-optional local for the closure below.
		const externalDatabaseUrl = raw as string;
		process.env.DATABASE_URL = externalDatabaseUrl;
		// 🚨 SAFETY INVARIANT: cloud/multi-replica prod must NEVER auto-provision
		// users or orgs. LOBU_RUN_OWNS_DB=1 is set ONLY by the CLI's `lobu run`
		// (packages/cli/src/commands/dev.ts) for single-operator local installs;
		// charts/lobu and the prod manifests never set it, so this returns [] in
		// prod. Without these hooks an external-DB `lobu run` migrated the schema
		// but left `user`/`organization` empty — `/api/local-init` then failed
		// with `unexpected_empty_user_table` and there was no path to a first
		// user (issue #1180).
		preListenHooks = externalDbBootstrapHooks(externalDatabaseUrl, process.env);
		databaseReadiness = async () => {
			// `lobu run` owns the local DB lifecycle, so it must apply migrations
			// itself before the schema-version gate runs — otherwise a fresh/empty
			// external Postgres throws `relation "schema_migrations" does not exist`.
			// The CLI sets LOBU_RUN_OWNS_DB=1 when it spawns this bundle. Prod never
			// sets it: there a separate dbmate migration Job applies migrations, and
			// the app only asserts the DB is up to date (below). runMigrations is
			// idempotent, so replaying against an already-migrated DB is a no-op.
			if (process.env.LOBU_RUN_OWNS_DB === "1") {
				logger.info(
					"[migrations] LOBU_RUN_OWNS_DB=1 — applying migrations to external DATABASE_URL",
				);
				await runMigrations(externalDatabaseUrl);
			}
			// Refuse to boot if the image expects a migration the DB hasn't applied.
			// Skippable via SKIP_SCHEMA_VERSION_CHECK=1 for emergency forward-flight.
			if (process.env.SKIP_SCHEMA_VERSION_CHECK !== "1") {
				// resolveMigrationsDir covers the published CLI (migrations live next
				// to the bundle, where the repo-root-relative path resolved to
				// node_modules/db/migrations → ENOENT warning); the PACKAGE_REPO_ROOT
				// fallback preserves the previous behaviour everywhere else.
				const migrationsDir =
					process.env.LOBU_MIGRATIONS_DIR?.trim() ||
					resolveMigrationsDir() ||
					path.join(PACKAGE_REPO_ROOT, "db", "migrations");
				await assertSchemaUpToDate(getDb(), { migrationsDir });
			} else {
				logger.warn(
					"[schema-check] SKIP_SCHEMA_VERSION_CHECK=1 — skipping boot-time assertion",
				);
			}
			// Detector (not a gate): the runs-queue has a 200ms SKIP-LOCKED poll
			// fallback, so a dropped LISTEN (transaction-mode pooler) just degrades
			// wakeup latency rather than causing an outage.
			if (process.env.SKIP_LISTEN_NOTIFY_PROBE !== "1") {
				try {
					await probeListenNotify();
					logger.info("[DB] LISTEN/NOTIFY probe ok");
				} catch (err) {
					logger.warn(
						{ err },
						"[DB] LISTEN/NOTIFY probe failed — runs-queue will fall back to 200ms poll.",
					);
				}
			}
		};
	} else {
		// Lazy: pulls embedded-postgres + the pgvector injector ONLY here, spawns
		// the cluster, sets process.env.DATABASE_URL to its TCP URL.
		const rt = await startEmbeddedRuntime();
		databaseReadiness = rt.databaseReadiness;
		preListenHooks = rt.preListenHooks;
		extraTeardown = rt.extraTeardown;
		logger.info(`Data: ${rt.dataDir}`);
	}

	// Imported AFTER env + DATABASE_URL are finalised: the lifecycle's transitive
	// imports (gateway, scheduler, ./index) evaluate at module load and expect a
	// hot DATABASE_URL, which the embedded branch only sets above.
	const { createServerLifecycle, reportBootFailure } = await import(
		"./server-lifecycle"
	);

	const lifecycle = createServerLifecycle({
		mode: external ? "postgres" : "embedded-postgres",
		env: getEnvFromProcess(),
		host,
		port,
		databaseReadiness,
		preListenHooks,
		// Crash loud if the runtime image is missing a connector external dep,
		// instead of letting feeds silently fail later. After listen() so the
		// sync require.resolve walk doesn't add to readiness latency.
		postListenHooks: [
			() => {
				try {
					assertExternalDepsResolvable(createRequire(import.meta.url).resolve);
				} catch (err) {
					logger.error({ err }, "Connector external dependency check failed");
					process.exit(1);
				}
			},
		],
		extraTeardown,
	});

	try {
		await lifecycle.start();
	} catch (err) {
		reportBootFailure(err);
	}
}

main().catch(async (error) => {
	// Lazy import so a crash in the env-setup block above (before the lifecycle
	// import) still reaches stderr with the structured fallback logging.
	const { reportBootFailure } = await import("./server-lifecycle");
	reportBootFailure(error);
});

/**
 * Node.js Server Entry Point (Postgres mode).
 *
 * Mode-specific bootstrap only. The shared spine
 * (Hono wrapper, middleware, route mounts, httpServer timeouts, Vite,
 * scheduler boot, signal handlers, shutdown ordering) lives in
 * `./server-lifecycle.ts`. DO NOT add `new Hono`, `app.use`, `app.route`,
 * `http.createServer`, or `process.on('SIGTERM' | 'SIGINT', …)` here — they
 * belong in the lifecycle.
 */

// Refuse to boot under an unsupported Node major (isolated-vm gate). The
// module performs the check on load, so this side-effect import MUST be the
// first one — ESM evaluates sibling imports in textual order, so anything
// above this line would otherwise run first and could itself crash on the
// unsupported runtime.
import "./utils/assert-node-version";

// Sentry must init before any other imports for auto-instrumentation
import "./instrument";

import dotenv from "dotenv";

dotenv.config();

import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertExternalDepsResolvable } from "@lobu/connector-worker/compile";
import { getDb, probeListenNotify } from "./db/client";
import {
	applyDevProjectPathDefault,
	createServerLifecycle,
	reportBootFailure,
} from "./server-lifecycle";
import { getEnvFromProcess } from "./utils/env";
import logger from "./utils/logger";
import { assertSchemaUpToDate } from "./utils/schema-version-check";

// Resolve repo root from this source file: …/packages/server/src/server.ts → repo root.
const PACKAGE_REPO_ROOT = path.resolve(
	fileURLToPath(new URL(".", import.meta.url)),
	"../../..",
);

applyDevProjectPathDefault(PACKAGE_REPO_ROOT);

async function main(): Promise<void> {
	const databaseUrl = process.env.DATABASE_URL?.trim();
	if (!databaseUrl) {
		throw new Error(
			"DATABASE_URL is required. Use a PostgreSQL connection string (for local dev run: pnpm dev:all).",
		);
	}
	process.env.DATABASE_URL = databaseUrl;

	const env = getEnvFromProcess();
	const port = parseInt(process.env.PORT || "8787", 10);
	const host = process.env.HOST?.trim() || "0.0.0.0";

	const databaseReadiness = async (): Promise<void> => {
		// Refuse to boot if the image expects a migration the database hasn't
		// applied. Skippable via SKIP_SCHEMA_VERSION_CHECK=1 for emergency
		// forward-flight (e.g. rolling back to an older image whose migrations
		// dir is a strict prefix of what's already applied). See
		// utils/schema-version-check.ts for the 2026-05-16 incident this guards.
		if (process.env.SKIP_SCHEMA_VERSION_CHECK !== "1") {
			const migrationsDir =
				process.env.LOBU_MIGRATIONS_DIR?.trim() ||
				path.join(PACKAGE_REPO_ROOT, "db", "migrations");
			await assertSchemaUpToDate(getDb(), { migrationsDir });
		} else {
			logger.warn(
				"[schema-check] SKIP_SCHEMA_VERSION_CHECK=1 — skipping boot-time assertion",
			);
		}

		// Verify LISTEN/NOTIFY actually delivers. This is a *detector*, not a
		// gate: the runs-queue has a 200ms SKIP-LOCKED poll fallback that keeps
		// the queue correct even when LISTEN is silently dropped (transaction-mode
		// pgbouncer, RDS Proxy, etc.). Failing the probe just means wakeup
		// latency degrades to the poll interval — not an outage.
		if (process.env.SKIP_LISTEN_NOTIFY_PROBE !== "1") {
			try {
				await probeListenNotify();
				logger.info("[DB] LISTEN/NOTIFY probe ok");
			} catch (err) {
				logger.warn(
					{ err },
					"[DB] LISTEN/NOTIFY probe failed — runs-queue will fall back to 200ms poll. Fix the pooler config to restore real-time wakeups.",
				);
			}
		}
	};

	const lifecycle = createServerLifecycle({
		mode: "postgres",
		env,
		host,
		port,
		databaseReadiness,
		// Crash loud if the runtime image is missing any connector external dep,
		// instead of letting every feed silently fail with "Missing npm
		// dependency: X" hours later. Run after listen() so the synchronous
		// require.resolve walk doesn't add to cold-boot/readiness latency.
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
	});

	await lifecycle.start();
}

main().catch(reportBootFailure);

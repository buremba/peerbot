/**
 * Local Server Entry Point (PGlite mode).
 *
 * Mode-specific bootstrap only:
 *   - apply user-config / forced env-var writes BEFORE anything reads env
 *   - start PGlite + socket server + run migrations
 *   - fork embeddings child
 *   - hand off to `createServerLifecycle()` for the shared spine
 *
 * The shared spine (Hono wrapper, middleware, route mounts, httpServer
 * timeouts, Vite, scheduler boot, signal handlers, shutdown ordering) lives
 * in `./server-lifecycle.ts`. DO NOT add `new Hono`, `app.use`, `app.route`,
 * `http.createServer`, or `process.on('SIGTERM' | 'SIGINT', …)` here.
 */

// Refuse to boot under an unsupported Node major (isolated-vm gate). Module
// asserts on load, so this must be the first import; see assert-node-version.ts.
import "./utils/assert-node-version";

// Sentry must init before any other imports for auto-instrumentation
// (postgres.js, http, etc.). No-op when SENTRY_DSN is unset, which is the
// common case for `lobu run` installs — the import is cheap.
import "./instrument";

import { fork } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";

dotenv.config();

import { applyUserServerConfigToEnv } from "./utils/user-config";

// After dotenv (project .env) so .env wins; before the module-level DATA_DIR
// / PORT / HOST reads below so user-config overrides from
// ~/.config/lobu/config.json land in time.
//
// DATABASE_URL is also filled in, but this bundle always boots PGlite and
// overwrites it below. External-Postgres routing happens upstream in
// `lobu run` (packages/cli/src/commands/dev.ts), which switches bundles when
// the user config or env pins DATABASE_URL. So in practice only LOBU_DATA_DIR
// / PORT / HOST flow through this call.
applyUserServerConfigToEnv();

import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { vector } from "@electric-sql/pglite/vector";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { assertExternalDepsResolvable } from "@lobu/connector-worker/compile";
import { ensureDefaultAgent } from "./auth/default-provisioning";
import { ensureInstallOperator } from "./auth/install-operator";
import {
	listMigrationFiles,
	loadMigrationUpSection,
} from "./db/migration-loader";
import { getEnvFromProcess } from "./utils/env";
import logger from "./utils/logger";

const DATA_DIR = process.env.LOBU_DATA_DIR || join(homedir(), ".lobu", "data");
const PORT = parseInt(process.env.PORT || "8787", 10);
// Loopback-only by default: the embedded local-runner ships a
// loopback-trust endpoint (`POST /api/local-init`) that mints worker-scoped
// PATs for the bootstrap user with no auth challenge. Binding to 0.0.0.0
// would expose that to anyone on the LAN. Operators who explicitly want
// LAN/WAN reachability must set `HOST=0.0.0.0` themselves.
const HOST = process.env.HOST?.trim() || "127.0.0.1";
const EMBEDDINGS_PORT = parseInt(process.env.EMBEDDINGS_PORT || "0", 10);
const APP_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const PACKAGE_REPO_ROOT = join(APP_ROOT, "..", "..");
const require = createRequire(import.meta.url);

function resolveExistingPath(
	...candidates: Array<string | undefined>
): string | null {
	for (const candidate of candidates) {
		if (candidate && existsSync(candidate)) {
			return candidate;
		}
	}
	return null;
}

function readPositiveIntEnv(name: string, fallback: number): number {
	const raw = process.env[name]?.trim();
	if (!raw) return fallback;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function isTruthyEnv(name: string): boolean {
	return /^(1|true|yes|on)$/i.test(process.env[name]?.trim() ?? "");
}

async function main(): Promise<void> {
	mkdirSync(DATA_DIR, { recursive: true });

	// Set all env vars FIRST — before any imports that might read them. The
	// server-lifecycle module is imported dynamically below for exactly this
	// reason: its transitive imports (`./index`, gateway, scheduler) read env
	// at module-evaluation time, and pglite socket setup must finish first.
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
		process.env.PUBLIC_WEB_URL = `http://localhost:${PORT}`;
	}
	if (!process.env.NODE_ENV) {
		process.env.NODE_ENV = "development";
	}
	process.env.PGSSLMODE = "disable";
	process.env.LOBU_DISABLE_PREPARE = "1";
	// Single-user mode default: the embedded runner spawns its own PGlite,
	// seeds a single bootstrap user, and is expected to be used by exactly
	// one operator on one machine. Block additional sign-ups so the
	// operator can't accidentally fork into a second account (one for the
	// Mac app + CLI, one for the web UI) by visiting /sign-up. Operators
	// who actually want multi-user mode set LOBU_SINGLE_USER=0 explicitly.
	if (process.env.LOBU_SINGLE_USER === undefined) {
		process.env.LOBU_SINGLE_USER = "1";
	}

	if (!process.env.LOBU_DEV_PROJECT_PATH) {
		// Mirror server.ts: downstream `buildGatewayConfig()` derives worker
		// paths from LOBU_DEV_PROJECT_PATH. Without this fallback, users running
		// `lobu run` from a project subdir get a wrong cwd-relative resolve.
		process.env.LOBU_DEV_PROJECT_PATH = PACKAGE_REPO_ROOT;
	}

	// ─── PGlite ──────────────────────────────────────────────────

	logger.info({ dataDir: DATA_DIR }, "Starting PGlite");
	const db = await PGlite.create({
		dataDir: DATA_DIR,
		extensions: { vector, pg_trgm },
	});

	// ─── PGlite Socket Server ────────────────────────────────────
	// Start socket FIRST, then run everything (including migrations)
	// through it. No direct PGlite access after this point.

	const pgSocketPort = parseInt(process.env.PG_SOCKET_PORT || "0", 10);
	const socketServer = new PGLiteSocketServer({
		db,
		port: pgSocketPort,
		maxConnections: readPositiveIntEnv(
			"LOBU_PGLITE_SOCKET_MAX_CONNECTIONS",
			64,
		),
		idleTimeout: readPositiveIntEnv("LOBU_PGLITE_SOCKET_IDLE_TIMEOUT_MS", 0),
		debug: isTruthyEnv("LOBU_PGLITE_SOCKET_DEBUG"),
	});
	socketServer.addEventListener("error", (event: Event) => {
		logger.error(
			{ error: (event as CustomEvent).detail },
			"PGlite socket server error",
		);
	});
	socketServer.addEventListener("close", () => {
		logger.warn("PGlite socket server closed");
	});
	// Wait for listening event to get the actual port (especially when port=0)
	const actualPgPort = await new Promise<number>((resolve) => {
		socketServer.addEventListener("listening", (e: Event) => {
			resolve((e as CustomEvent).detail?.port ?? pgSocketPort);
		});
		socketServer.start();
	});
	// sslmode=disable is required — PGlite socket doesn't support SSL negotiation
	const dbUrl = `postgresql://postgres@127.0.0.1:${actualPgPort}/postgres?sslmode=disable`;
	process.env.DATABASE_URL = dbUrl;
	logger.info({ port: actualPgPort }, "PGlite socket server ready");

	// ─── Embeddings Service (child process) ──────────────────────

	const embeddingsChild = await startEmbeddings();

	// ─── Lifecycle ───────────────────────────────────────────────
	// Dynamic import: env mutation above must land before the lifecycle's
	// transitive imports (gateway, scheduler, ./index) evaluate at module load.
	// This collapses the previous fan-out of seven `await import(...)` sites
	// (one per helper) into a single boundary.
	const { createServerLifecycle, reportBootFailure } = await import(
		"./server-lifecycle"
	);

	const env = getEnvFromProcess();

	// Personal-org id for default-agent provisioning. Resolved once during the
	// pre-listen phase rather than per-call, so the dynamic postgres import
	// happens with a hot DATABASE_URL.
	let personalOrgId: string | null = null;

	const lifecycle = createServerLifecycle({
		mode: "pglite",
		env,
		host: HOST,
		port: PORT,
		databaseReadiness: () => runMigrations(dbUrl),
		preListenHooks: [
			// Runs BEFORE listen so headless installs (CI, containers, /tmp
			// scaffolds without a browser) can sign in via better-auth without
			// a chicken-and-egg /sign-up step. Provisions a synthetic
			// `install_operator` user whose password is the install's
			// ENCRYPTION_KEY. Idempotent — re-running on a boot where the
			// operator already exists is a no-op. See
			// `docs/install-operator-bootstrap.md`.
			async () => {
				try {
					await ensureInstallOperator();
				} catch (err) {
					logger.error({ err }, "Install-operator provisioning failed");
					// Don't crash the server — the operator only matters for headless
					// installs; a browser-based signup still works.
				}
			},
			// Default-agent provisioning. Deferred to first-user creation in the
			// `databaseHooks.user.create.after` hook; this resolves the personal
			// org id on each boot so a returning user picks up the default agent.
			async () => {
				try {
					const personalOrgRows = (await import("postgres")).default(dbUrl, {
						max: 1,
					});
					try {
						const rows = (await personalOrgRows`
              SELECT id FROM "organization"
              WHERE (metadata::jsonb)->>'personal_org_for_user_id' IS NOT NULL
              ORDER BY "createdAt" ASC LIMIT 1
            `) as unknown as Array<{ id: string }>;
						personalOrgId = rows[0]?.id ?? null;
						if (personalOrgId) await ensureDefaultAgent(personalOrgId);
					} finally {
						await personalOrgRows.end({ timeout: 1 });
					}
				} catch (err) {
					logger.warn({ err }, "Default-agent provisioning failed");
				}
			},
		],
		// Mirror server.ts: crash loud if the runtime image is missing any
		// connector external dep, instead of letting each feed silently fail
		// with "Missing npm dependency: X" hours later. Runs after listen() so
		// the sync require.resolve walk doesn't add to cold-boot latency.
		// Without this hook, PGlite mode silently re-introduces the drift the
		// refactor exists to prevent — flagged by pi review on #951.
		postListenHooks: [
			() => {
				try {
					assertExternalDepsResolvable(require.resolve);
				} catch (err) {
					logger.error({ err }, "Connector external dependency check failed");
					process.exit(1);
				}
			},
		],
		// PGlite-specific teardown — runs after stopLobuGateway + closeDbSingleton
		// so gateway's postgres.js connections release before the socket goes
		// away underneath them.
		extraTeardown: [
			() => {
				embeddingsChild?.kill();
			},
			() => socketServer.stop(),
			() => db.close(),
		],
	});

	try {
		await lifecycle.start();
		logger.info(`Data: ${DATA_DIR}`);
	} catch (err) {
		// Bridge to reportBootFailure so PGlite-mode boot crashes get the same
		// structured + plain-text fallback logging as Postgres mode.
		reportBootFailure(err);
	}
}

// ─── Migrations ──────────────────────────────────────────────────

async function runMigrations(dbUrl: string): Promise<void> {
	// Embedded boot runs the same migrations dbmate uses for prod, applied
	// unconditionally. After the schema squash (2026-05-19), the migrations
	// dir is a single baseline + any forward deltas; both are idempotent
	// enough to replay on a pre-initialized DB:
	//   - The baseline starts with `CREATE TABLE` against a fresh schema
	//     and is gated by a `schema_migrations` row insertion. On a DB that
	//     has the baseline applied, dbmate-style version tracking skips the
	//     file; we do the same below.
	//   - Forward deltas use `IF NOT EXISTS` discipline so re-application
	//     against an already-migrated DB is a no-op.
	const pg = await import("postgres");
	const sql = pg.default(dbUrl, { max: 1 });

	try {
		const migrationsDir = resolveExistingPath(
			// Published @lobu/cli copies migrations next to start-local.bundle.mjs
			// under dist/db/migrations.
			join(fileURLToPath(new URL(".", import.meta.url)), "db", "migrations"),
			join(APP_ROOT, "db", "migrations"),
			// Monorepo `bun run --filter @lobu/server dev:local`: APP_ROOT is
			// packages/server/, so the migrations live two levels up at repo root.
			join(APP_ROOT, "..", "..", "db", "migrations"),
			join(process.cwd(), "db", "migrations"),
			join(process.cwd(), "..", "..", "db", "migrations"),
		);
		if (!migrationsDir) {
			throw new Error("Migrations directory not found.");
		}

		// Make sure the `schema_migrations` ledger exists before we read it.
		await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS public.schema_migrations (
        version character varying(128) NOT NULL PRIMARY KEY
      )
    `);

		const appliedRows = (await sql.unsafe(
			`SELECT version FROM public.schema_migrations`,
		)) as Array<{ version: string }>;
		const applied = new Set(appliedRows.map((r) => r.version));

		// Versions whose contents are known to be fully covered by an existing
		// schema (i.e. the squashed baseline). When one of these errors with a
		// duplicate-object SQLSTATE the DB is already at the target state and we
		// can safely record the version as applied. This is intentionally narrow:
		// any future delta migration must use `IF NOT EXISTS` discipline rather
		// than relying on this fallback, or its mid-file failures could mask
		// schema drift.
		const IDEMPOTENT_BASELINE_VERSIONS = new Set(["00000000000000"]);

		logger.info("Running migrations...");
		for (const file of listMigrationFiles(migrationsDir)) {
			// Filename convention is `<version>_<slug>.sql`; the version is the
			// leading underscore-separated prefix.
			const version = file.split("_")[0] ?? "";
			if (applied.has(version)) {
				continue;
			}
			const migrationSql = loadMigrationUpSection(migrationsDir, file);
			if (!migrationSql) continue;

			await sql.unsafe("SET search_path TO public");
			try {
				await sql.unsafe(migrationSql);
			} catch (err) {
				// The squashed baseline uses plain `CREATE FUNCTION` / `CREATE TABLE`
				// for cleanliness, so replaying it against a DB that already has the
				// schema raises `42723` (duplicate function) / `42P07` (duplicate
				// table) / `42710` (duplicate object). When the failing file is the
				// baseline, that's exactly the no-op case `lobu run` should treat as
				// success. For any other migration the duplicate error is surfaced
				// unchanged so partial failures cannot silently advance the ledger
				// (see `IDEMPOTENT_BASELINE_VERSIONS` above).
				const code = (err as { code?: string } | null)?.code;
				const isDuplicateObject =
					code === "42723" || code === "42P07" || code === "42710";
				if (!isDuplicateObject || !IDEMPOTENT_BASELINE_VERSIONS.has(version)) {
					throw err;
				}
				logger.info(
					{ migration: file, version, pgErrorCode: code },
					"Migration already applied (idempotent skip)",
				);
			}
			await sql`
        INSERT INTO public.schema_migrations (version) VALUES (${version})
        ON CONFLICT DO NOTHING
      `;
		}

		logger.info("Migrations complete");
	} finally {
		await sql.end();
	}
}

// ─── Embeddings (child process) ──────────────────────────────────

function findFreePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = http.createServer();
		srv.listen(0, "127.0.0.1", () => {
			const addr = srv.address();
			const port = typeof addr === "object" && addr ? addr.port : 0;
			srv.close(() => resolve(port));
		});
		srv.on("error", reject);
	});
}

async function startEmbeddings(): Promise<ReturnType<typeof fork> | null> {
	const publishedServerPath = (() => {
		try {
			return fileURLToPath(import.meta.resolve("@lobu/embeddings/server"));
		} catch {
			return null;
		}
	})();
	const serverPath = resolveExistingPath(
		join(APP_ROOT, "packages", "embeddings", "src", "server.ts"),
		join(process.cwd(), "packages", "embeddings", "src", "server.ts"),
		...(publishedServerPath ? [publishedServerPath] : []),
	);
	if (!serverPath) {
		logger.warn(
			"Embeddings service not found — embedding generation will not be available",
		);
		return null;
	}

	const port = EMBEDDINGS_PORT || (await findFreePort());
	const isTypescriptServer = serverPath.endsWith(".ts");
	let execArgv: string[] = [];
	if (isTypescriptServer) {
		const tsxPackageJson = require.resolve("tsx/package.json");
		const tsxLoaderPath = join(dirname(tsxPackageJson), "dist", "loader.mjs");
		execArgv = ["--import", tsxLoaderPath];
	}

	const child = fork(serverPath, [], {
		execArgv,
		env: { ...process.env, PORT: String(port) },
		stdio: ["ignore", "pipe", "pipe", "ipc"],
	});

	process.env.EMBEDDINGS_SERVICE_URL = `http://127.0.0.1:${port}`;

	child.stdout?.on("data", (data: Buffer) => {
		const msg = data.toString().trim();
		if (msg) logger.info({ service: "embeddings" }, msg);
	});

	child.stderr?.on("data", (data: Buffer) => {
		const msg = data.toString().trim();
		if (msg) logger.warn({ service: "embeddings" }, msg);
	});

	child.on("exit", (code) => {
		if (code !== 0 && code !== null) {
			logger.warn({ code }, "Embeddings service exited");
		}
	});

	return child;
}

main().catch(async (error) => {
	// Imported lazily so a crash in the env-setup block above (which runs
	// before the lifecycle import) still reaches stderr.
	const { reportBootFailure } = await import("./server-lifecycle");
	reportBootFailure(error);
});

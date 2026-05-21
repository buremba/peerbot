/**
 * Embedded-PostgreSQL runtime — lazy-loaded by `server.ts` ONLY when
 * `DATABASE_URL` is a path / `file://` (local `lobu run`, the Mac app, tests).
 *
 * Everything heavy (the `embedded-postgres` binary, the pgvector injector) is
 * pulled in via `await import(...)` inside `startEmbeddedRuntime`, so the
 * external-Postgres path (prod) never resolves or loads them even though they
 * sit in node_modules. Returns the mode-specific lifecycle hooks that
 * `server.ts` hands to the shared `createServerLifecycle()` spine.
 */

import { fork } from "node:child_process";
import { existsSync } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDefaultAgent } from "./auth/default-provisioning";
import { ensureInstallOperator } from "./auth/install-operator";
import {
	listMigrationFiles,
	loadMigrationUpSection,
} from "./db/migration-loader";
import logger from "./utils/logger";

const APP_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const require = createRequire(import.meta.url);

export interface EmbeddedRuntime {
	/** TCP URL of the spawned cluster; already written to process.env.DATABASE_URL. */
	databaseUrl: string;
	/** Cluster datadir, for the boot log. */
	dataDir: string;
	databaseReadiness: () => Promise<void>;
	preListenHooks: Array<() => Promise<void> | void>;
	extraTeardown: Array<() => Promise<void> | void>;
}

/**
 * Resolve the embedded data root from `DATABASE_URL` (a `file://` / path value;
 * the CLI / Mac app inject it). The cluster lives at `<root>/.lobu/pgdata`.
 * A leading `~` is expanded. `DATABASE_URL` is the single source of truth — a
 * postgres:// URL routes to the external path before this is ever called.
 */
function resolveDataRoot(): string {
	const dbUrl = process.env.DATABASE_URL?.trim();
	if (!dbUrl) {
		throw new Error(
			"DATABASE_URL is required: a file:// path for embedded Postgres " +
				"(e.g. file://~/.lobu) or a postgres:// URL for an external database.",
		);
	}
	let p = dbUrl.replace(/^file:(\/\/)?/i, "");
	if (p === "~" || p.startsWith("~/")) p = join(homedir(), p.slice(1));
	return p;
}

function resolveExistingPath(
	...candidates: Array<string | undefined>
): string | null {
	for (const candidate of candidates) {
		if (candidate && existsSync(candidate)) return candidate;
	}
	return null;
}

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

/**
 * Spawn an embedded PostgreSQL (injecting pgvector), set process.env.DATABASE_URL
 * to its TCP URL, fork the embeddings child, and return the lifecycle hooks.
 */
export async function startEmbeddedRuntime(): Promise<EmbeddedRuntime> {
	const dataRoot = resolveDataRoot();
	const pgDataDir = join(dataRoot, ".lobu", "pgdata");

	// Embedded-only env defaults. Single-user mode: the embedded runner spawns
	// its own DB, seeds one bootstrap user, and is used by exactly one operator
	// on one machine — block extra /sign-up forks unless LOBU_SINGLE_USER=0.
	process.env.PGSSLMODE = "disable";
	if (process.env.LOBU_SINGLE_USER === undefined) {
		process.env.LOBU_SINGLE_USER = "1";
	}

	// Heavy deps stay behind dynamic import so the external/prod path never
	// loads the embedded-postgres binary resolution or the pgvector injector.
	const { default: EmbeddedPostgres } = await import("embedded-postgres");
	const { injectPgvector, resolveEmbeddedNativeDir } = await import(
		"@lobu/pgvector-embedded"
	);

	// embedded-postgres bundles pg_trgm but not pgvector — inject the host
	// platform's prebuilt vector library into the binary tree before boot
	// (idempotent). cube + earthdistance are already in the stock binary.
	injectPgvector(resolveEmbeddedNativeDir());

	const pgPort =
		parseInt(process.env.LOBU_PG_PORT || "", 10) || (await findFreePort());
	const pg = new EmbeddedPostgres({
		databaseDir: pgDataDir,
		user: "postgres",
		password: "postgres",
		port: pgPort,
		persistent: true,
	});

	// initdb refuses a non-empty datadir; skip it when the cluster already
	// exists so restarts reuse the same data instead of erroring.
	if (!existsSync(join(pgDataDir, "PG_VERSION"))) {
		logger.info({ pgDataDir }, "Initialising embedded PostgreSQL cluster");
		await pg.initialise();
	}
	await pg.start();

	const databaseUrl = `postgresql://postgres:postgres@127.0.0.1:${pgPort}/postgres?sslmode=disable`;
	process.env.DATABASE_URL = databaseUrl;
	logger.info({ port: pgPort }, "Embedded PostgreSQL ready");

	const embeddingsChild = await startEmbeddings();

	return {
		databaseUrl,
		dataDir: pgDataDir,
		databaseReadiness: () => runMigrations(databaseUrl),
		preListenHooks: [
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
					const rows = (await import("postgres"))
						.default(databaseUrl, { max: 1 });
					try {
						const orgs = (await rows`
              SELECT id FROM "organization"
              WHERE (metadata::jsonb)->>'personal_org_for_user_id' IS NOT NULL
              ORDER BY "createdAt" ASC LIMIT 1
            `) as unknown as Array<{ id: string }>;
						const orgId = orgs[0]?.id ?? null;
						if (orgId) await ensureDefaultAgent(orgId);
					} finally {
						await rows.end({ timeout: 1 });
					}
				} catch (err) {
					logger.warn({ err }, "Default-agent provisioning failed");
				}
			},
		],
		// Runs after stopLobuGateway + closeDbSingleton so gateway connections
		// release before the embeddings child + PG child are stopped.
		extraTeardown: [
			() => {
				embeddingsChild?.kill();
			},
			() => pg.stop(),
		],
	};
}

async function runMigrations(databaseUrl: string): Promise<void> {
	// Same migrations dbmate uses for prod, applied unconditionally. The dir is
	// a single squashed baseline + forward deltas; both replay idempotently
	// (baseline gated by the schema_migrations ledger, deltas use IF NOT EXISTS).
	const pg = await import("postgres");
	const sql = pg.default(databaseUrl, { max: 1 });

	try {
		const migrationsDir = resolveExistingPath(
			// Published @lobu/cli copies migrations next to the bundle under dist/db/migrations.
			join(fileURLToPath(new URL(".", import.meta.url)), "db", "migrations"),
			join(APP_ROOT, "db", "migrations"),
			join(APP_ROOT, "..", "..", "db", "migrations"),
			join(process.cwd(), "db", "migrations"),
			join(process.cwd(), "..", "..", "db", "migrations"),
		);
		if (!migrationsDir) throw new Error("Migrations directory not found.");

		await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS public.schema_migrations (
        version character varying(128) NOT NULL PRIMARY KEY
      )
    `);

		const appliedRows = (await sql.unsafe(
			`SELECT version FROM public.schema_migrations`,
		)) as Array<{ version: string }>;
		const applied = new Set(appliedRows.map((r) => r.version));

		// The squashed baseline uses plain CREATE TABLE/FUNCTION, so replaying it
		// against an already-migrated DB raises duplicate-object SQLSTATEs; treat
		// those as the no-op success case for the baseline only. Forward deltas
		// must use IF NOT EXISTS rather than relying on this fallback.
		const IDEMPOTENT_BASELINE_VERSIONS = new Set(["00000000000000"]);

		logger.info("Running migrations...");
		for (const file of listMigrationFiles(migrationsDir)) {
			const version = file.split("_")[0] ?? "";
			if (applied.has(version)) continue;
			const migrationSql = loadMigrationUpSection(migrationsDir, file);
			if (!migrationSql) continue;

			await sql.unsafe("SET search_path TO public");
			try {
				await sql.unsafe(migrationSql);
			} catch (err) {
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

async function startEmbeddings(): Promise<ReturnType<typeof fork> | null> {
	const embeddingsPort = parseInt(process.env.EMBEDDINGS_PORT || "0", 10);
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

	const port = embeddingsPort || (await findFreePort());
	let execArgv: string[] = [];
	if (serverPath.endsWith(".ts")) {
		const tsxPackageJson = require.resolve("tsx/package.json");
		execArgv = ["--import", join(dirname(tsxPackageJson), "dist", "loader.mjs")];
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

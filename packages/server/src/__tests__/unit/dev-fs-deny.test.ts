import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	type ViteDevServer,
	createServer,
	resolveConfig,
	searchForWorkspaceRoot,
} from "vite";
import { devViteFsAllow, devViteFsDeny } from "../../utils/dev-fs-deny";

/**
 * `/@fs/` served the embedded Postgres cluster, the agent scratch dir and the
 * per-agent worker tree to anyone who could reach the dev server — which a
 * public Daytona preview now lets be the whole internet. Proven on a real
 * sandbox before this fix: an anonymous GET of
 * `/@fs/workspace/lobu/.lobu/probe.json` returned 200 with the file body.
 *
 * This boots a real Vite dev server over real HTTP rather than asserting
 * against a local reimplementation of Vite's glob matching, so it stays honest
 * if Vite changes how `fs.deny` is interpreted.
 */
describe("devViteFsDeny", () => {
	let root: string;
	let deny: string[];
	let vite: ViteDevServer;
	let server: http.Server;
	let origin: string;

	beforeAll(async () => {
		// The checkout sits under a directory named `workspaces` and its own name
		// carries glob metacharacters: an unanchored `**\/workspaces/**` or an
		// unescaped root would 403 every ordinary file below.
		root = path.join(
			mkdtempSync(path.join(tmpdir(), "dev-fs-deny-")),
			"workspaces",
			"lobu (dev)",
		);
		for (const rel of [
			".lobu-dev/postgresql.conf",
			".lobu-dev/.lobu/pgdata/PG_VERSION",
			".lobu/session.jsonl",
			"packages/server/workspaces/agent-1/session.jsonl",
			".env",
			"index.html",
			"public-note.txt",
		]) {
			const abs = path.join(root, rel);
			mkdirSync(path.dirname(abs), { recursive: true });
			writeFileSync(abs, `contents of ${rel}`);
		}

		// Same call dev-vite.ts makes: anchor to the tree Vite's `fs.allow` opens.
		deny = devViteFsDeny(searchForWorkspaceRoot(root));
		vite = await createServer({
			root,
			configFile: false,
			logLevel: "silent",
			server: {
				middlewareMode: true,
				fs: { deny },
			},
			appType: "custom",
		});
		server = http.createServer(vite.middlewares);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const addr = server.address();
		if (!addr || typeof addr === "string") throw new Error("no port");
		origin = `http://127.0.0.1:${addr.port}`;
	});

	afterAll(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await vite.close();
	});

	const status = async (rel: string) =>
		(await fetch(`${origin}/@fs${path.join(root, rel)}`)).status;

	it("keeps covering every one of Vite's own defaults", async () => {
		// Setting fs.deny REPLACES Vite's default array instead of merging with
		// it, so a well-meaning trim here would quietly start serving .env. Read
		// the defaults from Vite itself so a Vite upgrade that adds one fails here.
		const defaults = (
			await resolveConfig({ root, configFile: false, logLevel: "silent" }, "serve")
		).server.fs.deny;
		expect(defaults.length).toBeGreaterThan(0);
		for (const pattern of defaults) {
			expect(deny).toContain(pattern);
		}
	});

	it("refuses the Postgres cluster, agent scratch and worker tree over /@fs/", async () => {
		for (const denied of [
			// directly under .lobu-dev, so only the .lobu-dev pattern can deny it
			".lobu-dev/postgresql.conf",
			".lobu-dev/.lobu/pgdata/PG_VERSION",
			".lobu/session.jsonl",
			"packages/server/workspaces/agent-1/session.jsonl",
			".env",
		]) {
			expect(await status(denied)).toBe(403);
		}
	});

	it("still serves ordinary files, so the denials are real and not a dead route", async () => {
		expect(await status("public-note.txt")).toBe(200);
	});
});

/**
 * `fs.allow` defaulted to the whole workspace root, so `/@fs/` served every
 * file in the repo. Measured on this checkout before narrowing:
 * `/@fs/<root>/scripts/sandbox.ts` and `/@fs/<root>/bun.lock` both returned
 * 200. The allowlist is the first layer and the deny list the second.
 */
describe("devViteFsAllow", () => {
	let servedRoot: string;
	let webRoot: string;
	let vite: ViteDevServer;
	let server: http.Server;
	let origin: string;

	beforeAll(async () => {
		servedRoot = mkdtempSync(path.join(tmpdir(), "dev-fs-allow-"));
		webRoot = path.join(servedRoot, "packages", "web");
		for (const rel of [
			"packages/web/index.html",
			"packages/web/src/main.js",
			"packages/core/src/refs.js",
			"node_modules/dep/index.js",
			"scripts/sandbox.ts",
			"bun.lock",
			"deploy/values.yaml",
		]) {
			const abs = path.join(servedRoot, rel);
			mkdirSync(path.dirname(abs), { recursive: true });
			// Valid JS: an allowed path still has to survive Vite's transform,
			// and a garbage body would 404 for reasons unrelated to fs.allow.
			writeFileSync(abs, `export const from = ${JSON.stringify(rel)};`);
		}

		vite = await createServer({
			root: webRoot,
			configFile: false,
			logLevel: "silent",
			server: {
				middlewareMode: true,
				fs: {
					allow: devViteFsAllow(servedRoot, webRoot),
					deny: devViteFsDeny(servedRoot),
				},
			},
			appType: "custom",
		});
		server = http.createServer(vite.middlewares);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const addr = server.address();
		if (!addr || typeof addr === "string") throw new Error("no port");
		origin = `http://127.0.0.1:${addr.port}`;
	});

	afterAll(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await vite.close();
	});

	const status = async (rel: string) =>
		(await fetch(`${origin}/@fs${path.join(servedRoot, rel)}`)).status;

	it("refuses repo trees the SPA never loads from", async () => {
		for (const blocked of ["scripts/sandbox.ts", "bun.lock", "deploy/values.yaml"]) {
			expect(await status(blocked)).toBe(403);
		}
	});

	it("still serves the web root, workspace sources and hoisted deps", async () => {
		// A crawl of the SPA's module graph (652 modules) reaches exactly three
		// files outside the web root, all under the hoisted node_modules. The
		// aliased @lobu/core subpaths are pre-bundled into the web root's own
		// node_modules/.vite/deps by esbuild, which never goes through fs.allow —
		// `packages` is allowed so a future direct-source import cannot regress.
		for (const allowed of [
			"packages/web/src/main.js",
			"packages/core/src/refs.js",
			"node_modules/dep/index.js",
		]) {
			expect(await status(allowed)).toBe(200);
		}
	});
});

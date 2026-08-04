import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";

// Orphan-reap regression: the embedded runtime fork()s this server and only
// kills it in graceful teardown, so the server must exit when its IPC channel
// closes. These tests spawn the REAL server under Node (the production
// runtime — `node dist/server.js`, via tsx for the TS source) and observe the
// exit. No mocks: the guard runs at module top-level, so only a fresh process
// per scenario exercises register-vs-check ordering honestly.

const PKG_ROOT = join(import.meta.dir, "..", "..");
const SERVER = join(import.meta.dir, "..", "server.ts");
const EXIT_REAPED = 143; // 128 + SIGTERM — "killed externally" convention.

const temporaryDirs: string[] = [];
afterAll(() => {
	for (const dir of temporaryDirs) {
		rmSync(dir, { recursive: true, force: true });
	}
});

// Spawn the server under node+tsx. `ipc: false` models standalone `npm start`
// (no IPC channel); `preload` runs before the server module and can close the
// channel from the child side to model a parent death during module load.
function spawnServer(opts: {
	port: number;
	ipc?: boolean;
	preload?: string;
}): { child: ReturnType<typeof spawn>; sawLine: (line: string) => boolean } {
	const args: string[] = [];
	if (opts.preload) args.push("--import", opts.preload);
	args.push("--import", "tsx", SERVER);
	const child = spawn("node", args, {
		cwd: PKG_ROOT,
		stdio: ["ignore", "pipe", "pipe", ...(opts.ipc === false ? [] : ["ipc"] as const)],
		env: { ...process.env, PORT: String(opts.port) },
	});
	// Rolling buffer from spawn time: pipe chunks can split the target line,
	// and output emitted before a waiter attaches must not be lost.
	let buffer = "";
	child.stdout?.on("data", (chunk: Buffer) => {
		buffer += chunk.toString();
	});
	return { child, sawLine: (line: string) => buffer.includes(line) };
}

// Wait until the rolling stdout buffer contains `line`, or the child exits.
function waitForLine(
	child: ReturnType<typeof spawn>,
	sawLine: (line: string) => boolean,
	line: string
): Promise<boolean> {
	return new Promise((resolve) => {
		if (sawLine(line)) {
			resolve(true);
			return;
		}
		const timer = setTimeout(() => resolve(false), 15000);
		const poll = setInterval(() => {
			if (sawLine(line)) {
				clearTimeout(timer);
				clearInterval(poll);
				resolve(true);
			}
		}, 50);
		child.on("exit", () => {
			clearTimeout(timer);
			clearInterval(poll);
			resolve(sawLine(line));
		});
	});
}

describe("orphan reap (forked embeddings server, node runtime)", () => {
	test("exits 143 when IPC closes after startup", async () => {
		const { child, sawLine } = spawnServer({ port: 18951 });
		const timer = setTimeout(() => child.kill("SIGKILL"), 20000);
		try {
			const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
				child.on("exit", (code, signal) => resolve({ code, signal }));
			});
			expect(await waitForLine(child, sawLine, "Listening on port")).toBe(true);
			child.disconnect();
			const { code, signal } = await exit;
			expect(signal).toBeNull();
			expect(code).toBe(EXIT_REAPED);
		} finally {
			clearTimeout(timer);
			if (child.exitCode === null) child.kill("SIGKILL");
		}
	}, 30000);

	test("exits 143 when the channel is already gone at handler registration (startup race)", async () => {
		// Node does not replay a 'disconnect' emitted before a listener exists.
		// The preload closes the channel from the child side BEFORE server.ts
		// evaluates, which is exactly the state a parent death during module
		// load leaves: process.connected false, the event already dropped.
		// Without the `process.connected` re-check the server would leak here.
		const dir = mkdtempSync(join(tmpdir(), "lobu-orphan-preload-"));
		temporaryDirs.push(dir);
		const preload = join(dir, "disconnect-preload.mjs");
		// The yield forces the event loop to process the channel close while no
		// listener exists, so 'disconnect' is dropped for real — without it Node
		// defers the event until after registration and the plain listener alone
		// would pass this test.
		writeFileSync(
			preload,
			"if (process.connected) process.disconnect();\n" +
				"await new Promise((r) => setTimeout(r, 100));\n"
		);

		const { child } = spawnServer({ port: 18952, preload });
		const timer = setTimeout(() => child.kill("SIGKILL"), 20000);
		try {
			const { code, signal } = await new Promise<{
				code: number | null;
				signal: NodeJS.Signals | null;
			}>((resolve) => {
				child.on("exit", (code, signal) => resolve({ code, signal }));
			});
			expect(signal).toBeNull();
			expect(code).toBe(EXIT_REAPED);
		} finally {
			clearTimeout(timer);
			if (child.exitCode === null) child.kill("SIGKILL");
		}
	}, 30000);

	test("standalone spawn without IPC keeps running (guard is inert)", async () => {
		const { child, sawLine } = spawnServer({ port: 18953, ipc: false });
		try {
			expect(await waitForLine(child, sawLine, "Listening on port 18953")).toBe(true);
			// Still alive a beat later — no IPC channel means nothing to reap it.
			await new Promise((r) => setTimeout(r, 500));
			expect(child.exitCode).toBeNull();
		} finally {
			child.kill("SIGKILL");
			// Await the actual exit so the test never ends with a dying child.
			await new Promise<void>((resolve) => {
				if (child.exitCode !== null) resolve();
				else child.on("exit", () => resolve());
			});
		}
	}, 30000);
});

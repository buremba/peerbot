/**
 * Contract tests for the shared server lifecycle spine.
 *
 * The point of these tests is to lock the invariants that drift between
 * `server.ts` (Postgres) and `start-local.ts` (embedded Postgres) used to break (issue
 * #948 + the #943 7-hygiene catch-up):
 *
 *   1. Middleware ordering on the Hono wrapper:
 *      peer-address stash → env-inject → sentry-5xx-capture → onError
 *   2. Route mounts: `/lobu` mounted only when lobuApp is non-null; `/` always.
 *   3. httpServer timeouts: keepAliveTimeout=75000, headersTimeout=76000.
 *   4. Shutdown ordering documented in createServerLifecycle().
 *   5. `serializeBootError` walks nested cause chains and never returns `{}`.
 *
 * The wrapper-app and serializer assertions exercise real code paths;
 * the lifecycle-shape assertions read the source so anything renaming the
 * shutdown step labels has to update the test in the same PR.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

vi.mock("@sentry/node", () => ({
	captureException: vi.fn(),
	captureMessage: vi.fn(),
}));

vi.mock("../utils/logger", () => {
	const noop = (): void => undefined;
	// Recursive `child` is required because several modules (e.g.
	// identity/connectors/google.ts) call `logger.child(...)` at module-load
	// time. Match pino's interface so any caller's `.info / .warn / .error /
	// .child` works without instrumentation.
	const make = (): Record<string, unknown> => {
		const self: Record<string, unknown> = {
			info: noop,
			warn: noop,
			error: noop,
			debug: noop,
			trace: noop,
			fatal: noop,
		};
		self.child = () => make();
		return self;
	};
	const logger = make();
	return { default: logger };
});

vi.mock("../sentry", () => {
	const reported = new WeakSet<object>();
	return {
		captureServerError: vi.fn(),
		isSentryReported: vi.fn((c: { req: unknown }) =>
			reported.has(c.req as object),
		),
		markSentryReported: vi.fn((c: { req: unknown }) => {
			reported.add(c.req as object);
		}),
		trackMCPToolCall: vi.fn(
			async <T,>(
				_toolName: string,
				_args: unknown,
				handler: () => Promise<T>,
			) => handler(),
		),
	};
});

// The wrapper imports `mainApp` from `./index` to mount at `/`. The real
// module pulls in ~1370 lines of routes + auth + connector graphs we don't
// need here, and forces a Postgres connection at load time. Replace it with
// a real Hono app constructed via async `Hono` import inside the factory so
// the mock matches the same shape the wrapper expects (Hono with `.fetch`).
vi.mock("../index", async () => {
	const { Hono } = await import("hono");
	const app = new Hono();
	app.get("/health", (c) => c.text("main-ok"));
	return {
		app,
		setViteDev: vi.fn(),
	};
});

const LIFECYCLE_SOURCE = readFileSync(
	join(dirname(fileURLToPath(import.meta.url)), "..", "server-lifecycle.ts"),
	"utf8",
);

describe("serializeBootError", () => {
	it("returns message + stack for a plain Error", async () => {
		const { serializeBootError } = await import("../server-lifecycle");
		const err = new Error("boom");
		const out = serializeBootError(err);
		expect(out.type).toBe("Error");
		expect(out.message).toBe("boom");
		expect(typeof out.stack).toBe("string");
	});

	it("walks nested cause chains", async () => {
		const { serializeBootError } = await import("../server-lifecycle");
		const inner = new Error("inner");
		const outer = new Error("outer", { cause: inner });
		const out = serializeBootError(outer);
		expect(out.message).toBe("outer");
		const cause = out.cause as Record<string, unknown> | undefined;
		expect(cause?.message).toBe("inner");
	});

	it("preserves ZodError-shaped issues array", async () => {
		const { serializeBootError } = await import("../server-lifecycle");
		const err = Object.assign(new Error("validation failed"), {
			issues: [{ path: ["DATABASE_URL"], message: "required" }],
		});
		const out = serializeBootError(err);
		expect(out.issues).toEqual([
			{ path: ["DATABASE_URL"], message: "required" },
		]);
	});

	it("handles non-object values without throwing", async () => {
		const { serializeBootError } = await import("../server-lifecycle");
		expect(serializeBootError("a string")).toEqual({
			value: "a string",
			type: "string",
		});
		expect(serializeBootError(null)).toEqual({ value: "null" });
		expect(serializeBootError(undefined)).toEqual({ value: "undefined" });
	});
});

describe("buildWrapperApp", () => {
	it("mounts mainApp at / and lobuApp at /lobu when present", async () => {
		const { buildWrapperApp } = await import("../server-lifecycle");
		const { Hono } = await import("hono");
		const lobuApp = new Hono();
		lobuApp.get("/ping", (c) => c.text("lobu-pong"));
		const wrapper = buildWrapperApp({} as never, lobuApp);

		const lobuRes = await wrapper.request("/lobu/ping");
		expect(lobuRes.status).toBe(200);
		expect(await lobuRes.text()).toBe("lobu-pong");

		const mainRes = await wrapper.request("/health");
		expect(mainRes.status).toBe(200);
		expect(await mainRes.text()).toBe("main-ok");
	});

	it("skips the /lobu mount when lobuApp is null", async () => {
		const { buildWrapperApp } = await import("../server-lifecycle");
		const wrapper = buildWrapperApp({} as never, null);

		const lobuRes = await wrapper.request("/lobu/ping");
		expect(lobuRes.status).toBe(404);
	});

	it("injects env onto c.env without dropping adapter fields", async () => {
		const { buildWrapperApp } = await import("../server-lifecycle");
		const { Hono } = await import("hono");
		const lobuApp = new Hono();
		// Probe runs against the lobuApp so it sees the wrapper's middleware.
		lobuApp.get("/probe", (c) => {
			// env was merged: app secrets are visible
			const seenSecret = (c.env as { SECRET?: string }).SECRET;
			// adapter field was preserved: `incoming` still set when the runner
			// injects it (we set a fake below to prove Object.assign doesn't drop it)
			const incoming = (c.env as { incoming?: unknown }).incoming;
			return c.json({ seenSecret, hasIncoming: incoming !== undefined });
		});
		const wrapper = buildWrapperApp({ SECRET: "shh" } as never, lobuApp);

		// Hono's `request()` helper doesn't simulate the Node adapter's
		// `c.env.incoming`. Bind an `incoming` field via a one-shot middleware
		// BEFORE the wrapper's stack runs to mimic what @hono/node-server does.
		const outer = new Hono();
		outer.use("*", async (c, next) => {
			if (!c.env) c.env = {};
			(c.env as { incoming?: unknown }).incoming = {
				socket: { remoteAddress: "127.0.0.1" },
			};
			return next();
		});
		outer.route("/", wrapper);

		const res = await outer.request("/lobu/probe");
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			seenSecret: string;
			hasIncoming: boolean;
		};
		expect(body.seenSecret).toBe("shh");
		expect(body.hasIncoming).toBe(true);
	});

	it("stashes peer remote address into c.var before env-inject runs", async () => {
		const { buildWrapperApp } = await import("../server-lifecycle");
		const { Hono } = await import("hono");
		const lobuApp = new Hono();
		lobuApp.get("/peer", (c) => c.text(c.get("peerRemoteAddress") ?? "none"));
		const wrapper = buildWrapperApp({} as never, lobuApp);

		const outer = new Hono();
		outer.use("*", async (c, next) => {
			if (!c.env) c.env = {};
			(c.env as { incoming?: unknown }).incoming = {
				socket: { remoteAddress: "10.0.0.1" },
			};
			return next();
		});
		outer.route("/", wrapper);

		const res = await outer.request("/lobu/peer");
		expect(await res.text()).toBe("10.0.0.1");
	});

	it("captures 5xx responses to Sentry via the post-response middleware", async () => {
		const { buildWrapperApp } = await import("../server-lifecycle");
		const sentry = await import("@sentry/node");
		const { Hono } = await import("hono");
		const lobuApp = new Hono();
		// Routes that try/catch internally and return c.json(..., 500) — the
		// framework never sees the exception, so onError doesn't fire. The
		// post-response middleware is the only thing that catches these.
		lobuApp.get("/silent-500", (c) => c.json({ error: "inner caught" }, 500));
		const wrapper = buildWrapperApp({} as never, lobuApp);

		const res = await wrapper.request("/lobu/silent-500");
		expect(res.status).toBe(500);
		expect(sentry.captureMessage).toHaveBeenCalled();
		const calls = (sentry.captureMessage as ReturnType<typeof vi.fn>).mock
			.calls;
		const lastCall = calls[calls.length - 1] ?? [];
		const [message, opts] = lastCall;
		expect(message).toBe("inner caught");
		expect(opts.level).toBe("error");
		expect(opts.tags.source).toBe("http_response");
	});

	it("suppresses ONLY the draining readiness 503; other health 5xx still report", async () => {
		const { buildWrapperApp } = await import("../server-lifecycle");
		const sentry = await import("@sentry/node");
		const { Hono } = await import("hono");
		const captureMessage = sentry.captureMessage as ReturnType<typeof vi.fn>;

		// Expected deploy-drain shape → suppressed (was LOBU-BACKEND-X noise).
		const draining = buildWrapperApp({} as never, new Hono());
		draining.get("/health/ready", (c) =>
			c.json({ status: "draining", service: "lobu-api" }, 503),
		);
		captureMessage.mockClear();
		const drainRes = await draining.request("/health/ready");
		expect(drainRes.status).toBe(503);
		expect(captureMessage).not.toHaveBeenCalled();

		// Same endpoint, non-draining body (e.g. DB unreachable) → still reports.
		const broken = buildWrapperApp({} as never, new Hono());
		broken.get("/health/ready", (c) =>
			c.json({ status: "error", error: "db unreachable" }, 503),
		);
		captureMessage.mockClear();
		const brokenRes = await broken.request("/health/ready");
		expect(brokenRes.status).toBe(503);
		expect(captureMessage).toHaveBeenCalled();
	});

	it("routes thrown exceptions through onError + Sentry.captureException", async () => {
		const { buildWrapperApp } = await import("../server-lifecycle");
		const sentry = await import("@sentry/node");
		const { Hono } = await import("hono");
		const lobuApp = new Hono();
		lobuApp.get("/boom", () => {
			throw new Error("thrown from route");
		});
		const wrapper = buildWrapperApp({} as never, lobuApp);

		const res = await wrapper.request("/lobu/boom");
		expect(res.status).toBe(500);
		expect(sentry.captureException).toHaveBeenCalled();
		const calls = (sentry.captureException as ReturnType<typeof vi.fn>).mock
			.calls;
		const lastCall = calls[calls.length - 1] ?? [];
		const [errArg] = lastCall;
		expect((errArg as Error).message).toBe("thrown from route");
	});

	it("does NOT double-report when onError fires after post-response middleware", async () => {
		const { buildWrapperApp } = await import("../server-lifecycle");
		const sentry = await import("@sentry/node");
		const { Hono } = await import("hono");
		const captureMessage = sentry.captureMessage as ReturnType<typeof vi.fn>;
		const captureException = sentry.captureException as ReturnType<
			typeof vi.fn
		>;
		captureMessage.mockClear();
		captureException.mockClear();

		const lobuApp = new Hono();
		lobuApp.get("/boom", () => {
			throw new Error("thrown");
		});
		const wrapper = buildWrapperApp({} as never, lobuApp);

		await wrapper.request("/lobu/boom");
		// onError marks the request as reported via markSentryReported BEFORE
		// the post-response middleware runs; the latter must skip the 5xx path.
		expect(captureException).toHaveBeenCalledTimes(1);
		expect(captureMessage).toHaveBeenCalledTimes(0);
	});
});

describe("createServerLifecycle (source-level contract)", () => {
	// These assertions read the source file. They exist so a code reviewer
	// (human or pi) can't silently reorder shutdown or drop a step without
	// updating the test in the same change. Functional ordering is also
	// exercised by an explicit grep-and-position check below.

	function indexOf(needle: string): number {
		const idx = LIFECYCLE_SOURCE.indexOf(needle);
		if (idx === -1) {
			throw new Error(
				`server-lifecycle.ts: expected substring not found: ${JSON.stringify(needle)}`,
			);
		}
		return idx;
	}

	it("locks httpServer keep-alive timeouts at 75/76s", () => {
		expect(LIFECYCLE_SOURCE).toContain("httpServer.keepAliveTimeout = 75_000");
		expect(LIFECYCLE_SOURCE).toContain("httpServer.headersTimeout = 76_000");
		// Header timeout MUST be strictly greater than keep-alive.
		expect(76_000).toBeGreaterThan(75_000);
	});

	it("runs databaseReadiness before workspace + gateway init", () => {
		const dbReady = indexOf("await databaseReadiness()");
		const workspace = indexOf("await initWorkspaceProvider()");
		const gateway = indexOf("await initLobuGateway()");
		expect(dbReady).toBeLessThan(workspace);
		expect(workspace).toBeLessThan(gateway);
	});

	it("runs preListenHooks before httpServer.listen", () => {
		const preHooks = indexOf("for (const hook of preListenHooks)");
		const listen = indexOf("httpServer.listen(port, host");
		expect(preHooks).toBeLessThan(listen);
	});

	it("starts the embedded connector worker inside the listen callback", () => {
		const listen = indexOf("httpServer.listen(port, host");
		const embedded = indexOf("embeddedWorker = startEmbeddedConnectorWorker");
		const postHooks = indexOf("for (const hook of postListenHooks)");
		expect(embedded).toBeGreaterThan(listen);
		expect(postHooks).toBeGreaterThan(listen);
		// postListenHooks fire BEFORE the embedded worker so any synchronous
		// dep-resolve check can fail-fast without leaving a worker registered.
		expect(postHooks).toBeLessThan(embedded);
	});

	it("shuts down in the documented order", () => {
		// Each step is wrapped in `safe("<step>", …)` so a failing teardown
		// can't block the rest. Order-check by the step label which is stable
		// across refactors of the wrapper.
		const worker = indexOf('safe("embeddedWorker.stop"');
		const vite = indexOf('safe("vite.close"');
		const reaper = indexOf('safe("stopReaper"');
		const scheduler = indexOf('safe("taskScheduler.stop"');
		const gateway = indexOf('safe("stopLobuGateway"');
		const db = indexOf('safe("closeDbSingleton"');
		const extra = indexOf("safe(`extraTeardown[");
		// #1191 wrapped the close in the same safe() step pattern as the rest of
		// teardown; match the stable step label, not the raw call.
		const close = indexOf('safe("httpServer.close"');

		expect(worker).toBeLessThan(vite);
		expect(vite).toBeLessThan(reaper);
		expect(reaper).toBeLessThan(scheduler);
		expect(scheduler).toBeLessThan(gateway);
		expect(gateway).toBeLessThan(db);
		expect(db).toBeLessThan(extra);
		expect(extra).toBeLessThan(close);
	});

	it("wraps every shutdown step in a safe() helper (one failing step does not skip the rest)", () => {
		// The `safe()` wrapper is what guarantees that — for example — a
		// rejecting `stopLobuGateway()` doesn't leave the listener bound and
		// the process pinned. If a future refactor inlines a raw `await` for
		// any step, this assertion catches it.
		const safeCalls = LIFECYCLE_SOURCE.match(/safe\((`extraTeardown\[|")/g);
		expect(safeCalls?.length ?? 0).toBeGreaterThanOrEqual(7);
	});

	it("single-flights concurrent shutdown signals", () => {
		// SIGTERM and SIGINT can both arrive (or one can fire twice during a
		// supervisor restart). The guard short-circuits the second entry so
		// gateway-stop / extraTeardown / process.exit don't race.
		expect(LIFECYCLE_SOURCE).toContain("let shutdownStarted = false");
		expect(LIFECYCLE_SOURCE).toContain("if (shutdownStarted)");
		expect(LIFECYCLE_SOURCE).toContain("shutdownStarted = true");
	});

	it("registers SIGTERM and SIGINT handlers", () => {
		// Accept either quote style — biome may rewrite ' → " on save.
		expect(/process\.on\(['"]SIGTERM['"]/.test(LIFECYCLE_SOURCE)).toBe(true);
		expect(/process\.on\(['"]SIGINT['"]/.test(LIFECYCLE_SOURCE)).toBe(true);
	});
});

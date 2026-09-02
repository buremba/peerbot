/**
 * Fixture connector for `isolate-executor.test.ts`.
 *
 * Each `scenario` config value exercises one boundary of the connector isolate
 * lane: chunked emit and checkpoint hooks, host-mediated fetch, timers, console
 * redaction, runaway CPU and heap, thrown errors, auth artifacts and chrome
 * dispatch. The suite compiles it for BOTH lanes so what each lane observably does
 * can be compared. It is never registered as a real connector.
 */
import {
	type ActionContext,
	type ActionResult,
	type AuthContext,
	type AuthResult,
	ConnectorRuntime,
	type EventEnvelope,
	type RuntimeConnectorDefinition,
	type SyncContext,
	type SyncResult,
} from "@lobu/connector-sdk";

interface FixtureConfig {
	scenario?: string;
	count?: number;
	url?: string;
	method?: string;
	body?: string;
	secret?: string;
}

type Dispatcher = { dispatch(actionKey: string, input: Record<string, unknown>): Promise<Record<string, unknown>> };

function event(index: number): EventEnvelope {
	return {
		origin_id: `fixture_${index}`,
		origin_type: "fixture",
		title: `Fixture event ${index}`,
		payload_text: `body ${index}`,
		occurred_at: new Date(Date.UTC(2026, 0, 1, 0, 0, index % 60)).toISOString(),
		metadata: { index },
	} as EventEnvelope;
}

export default class IsolateFixtureConnector extends ConnectorRuntime<Record<string, unknown>, FixtureConfig> {
	readonly definition: RuntimeConnectorDefinition<Record<string, unknown>, FixtureConfig> = {
		key: "isolate_fixture",
		name: "Isolate Fixture",
		description: "Exercises the connector isolate lane.",
		version: "0.0.1",
		authSchema: { methods: [{ type: "none" }] },
		feeds: {
			scenario: {
				key: "scenario",
				name: "Scenario",
				description: "Runs the scenario named in config.",
				sync: (ctx) => this.run(ctx),
				configSchema: { type: "object", properties: { scenario: { type: "string" } } },
			},
		},
	};

	async execute(ctx: ActionContext): Promise<ActionResult> {
		if (ctx.actionKey === "dispatch") {
			const dispatcher = (ctx.sessionState as { chrome_dispatcher?: Dispatcher } | null)?.chrome_dispatcher;
			if (!dispatcher) return { success: false, error: "no chrome_dispatcher on sessionState" };
			const observation = await dispatcher.dispatch("tabs.list", ctx.input);
			return { success: true, output: { observation } };
		}
		if (ctx.actionKey === "fail") return { success: false, error: "fixture action failed" };
		return { success: true, output: { echoed: ctx.input, configKeys: Object.keys(ctx.config).sort() } };
	}

	async authenticate(ctx: AuthContext): Promise<AuthResult> {
		await ctx.emit({ type: "status", message: "fixture waiting for code" });
		const signal = await ctx.awaitSignal("code", { timeoutMs: 5_000 });
		return {
			credentials: { provider: "fixture", accessToken: `tok_${String(signal.code)}` },
			metadata: { signal },
		};
	}

	private async run(ctx: SyncContext<Record<string, unknown>, FixtureConfig>): Promise<SyncResult> {
		const scenario = ctx.config.scenario ?? "emit";
		switch (scenario) {
			case "emit": {
				const count = Number(ctx.config.count ?? 250);
				const events: EventEnvelope[] = [];
				for (let i = 0; i < count; i += 1) events.push(event(i));
				await ctx.emitEvents?.(events);
				await ctx.updateCheckpoint?.({ cursor: count });
				return { events: [event(count)], checkpoint: { cursor: count + 1 }, metadata: { items_found: count + 1 } };
			}
			case "fetch": {
				const init: RequestInit = { headers: { "x-fixture": "yes" } };
				if (ctx.config.method) init.method = ctx.config.method;
				if (ctx.config.body !== undefined) {
					init.body = ctx.config.body;
					init.headers = { ...(init.headers as Record<string, string>), "content-type": "application/json" };
				}
				const res = await fetch(String(ctx.config.url), init);
				const text = await res.text();
				return {
					events: [],
					checkpoint: {
						status: res.status,
						ok: res.ok,
						url: res.url,
						redirected: res.redirected,
						contentType: res.headers.get("content-type"),
						bytes: text.length,
						text: text.slice(0, 512),
					},
				};
			}
			case "loop": {
				for (;;) {
					/* burn */
				}
			}
			case "loop_after_await": {
				await new Promise((resolve) => setTimeout(resolve, 5));
				for (;;) {
					/* burn */
				}
			}
			case "alloc": {
				const hoard: number[][] = [];
				for (;;) hoard.push(new Array(1 << 20).fill(hoard.length));
			}
			case "throw": {
				const error = new Error("fixture exploded");
				Object.assign(error, { status: 418 });
				throw error;
			}
			case "console": {
				console.log(`Authorization: Bearer ${String(ctx.config.secret)}`);
				console.warn("plain warning");
				console.error("cookie: Cookie: session=" + String(ctx.config.secret));
				console.info("info line");
				return { events: [], checkpoint: null };
			}
			case "env": {
				return {
					events: [],
					checkpoint: {
						fixture_env: process.env.FIXTURE_ENV ?? null,
						config_fixture_env: (ctx.config as Record<string, unknown>).FIXTURE_ENV ?? null,
					},
				};
			}
			case "timers": {
				const order: string[] = [];
				await new Promise<void>((resolve) => {
					setTimeout(() => order.push("t10"), 10);
					setTimeout(() => order.push("t0"), 0);
					setImmediate(() => order.push("imm"));
					queueMicrotask(() => order.push("micro"));
					Promise.resolve().then(() => order.push("promise"));
					const cancelled = setTimeout(() => order.push("cancelled"), 1);
					clearTimeout(cancelled);
					let ticks = 0;
					const interval = setInterval(() => {
						ticks += 1;
						order.push(`iv${ticks}`);
						if (ticks === 2) clearInterval(interval);
					}, 2);
					order.push("sync");
					setTimeout(resolve, 60);
				});
				return { events: [], checkpoint: { order } };
			}
			case "dispatch": {
				const dispatcher = (ctx.sessionState as { chrome_dispatcher?: Dispatcher } | null)?.chrome_dispatcher;
				if (!dispatcher) throw new Error("no chrome_dispatcher on sessionState");
				const observation = await dispatcher.dispatch("tabs.list", { from: "sync" });
				return { events: [], checkpoint: { observation } };
			}
			case "prelude": {
				const url = new URL("https://Example.COM:443/a/./b/../c d?x=1&y=a b#frag ment");
				const params = new URLSearchParams({ a: "1 2", b: "é&=" });
				params.append("a", "3");
				const controller = new AbortController();
				let abortFired = false;
				controller.signal.addEventListener("abort", () => {
					abortFired = true;
				});
				controller.abort();
				const timeoutSignal = AbortSignal.timeout(5);
				await new Promise((resolve) => timeoutSignal.addEventListener("abort", resolve));
				let throwIfAbortedName: string | null = null;
				try {
					controller.signal.throwIfAborted();
				} catch (error) {
					throwIfAbortedName = (error as Error).name;
				}
				return {
					events: [],
					checkpoint: {
						href: url.href,
						origin: url.origin,
						host: url.host,
						pathname: url.pathname,
						search: url.search,
						hash: url.hash,
						searchX: url.searchParams.get("x"),
						params: params.toString(),
						paramsAll: params.getAll("a"),
						text: new TextDecoder().decode(new TextEncoder().encode("héllo € 𝄞")),
						bytes: Array.from(new TextEncoder().encode("é€")),
						b64: btoa("hello, isolate"),
						fromB64: atob("aGVsbG8sIGlzb2xhdGU="),
						aborted: controller.signal.aborted,
						abortFired,
						abortReason: (controller.signal.reason as Error).name,
						throwIfAbortedName,
						timeoutReason: (timeoutSignal.reason as Error).name,
					},
				};
			}
			default:
				throw new Error(`unknown scenario ${scenario}`);
		}
	}
}

import { describe, expect, test } from "bun:test";
import { sessionCookieName } from "../../auth/session-cookie-scope";
import {
	collapseSessionCookies,
	resolveSession,
	sessionCookieCandidates,
} from "../../auth/resolve-session";

const HOST_ONLY = sessionCookieName(false);
const SECURE = sessionCookieName(true);

/**
 * Stand-in for Better Auth's `getSession`, faithful on the one detail that
 * decides this module: it reads exactly ONE cookie name — the one
 * `createCookieGetter` derives from `useSecureCookies` — and ignores every
 * other spelling in the jar. Production issues `__Secure-` cookies, so pass
 * `SECURE` to model prod and `HOST_ONLY` to model plain-http dev.
 */
function fakeAuth(readsName: string, liveValue: string) {
	const seen: Array<string | null> = [];
	return {
		seen,
		api: {
			getSession: async ({ headers }: { headers: Headers }) => {
				const cookie = headers.get("cookie");
				seen.push(cookie);
				for (const part of (cookie ?? "").split(";")) {
					const eq = part.indexOf("=");
					if (eq === -1) continue;
					if (part.slice(0, eq).trim() !== readsName) continue;
					// better-call's parseCookies keeps the FIRST occurrence.
					return part.slice(eq + 1).trim() === liveValue
						? { user: { id: "u1" }, session: { token: liveValue } }
						: null;
				}
				return null;
			},
		},
	};
}

describe("sessionCookieCandidates", () => {
	test("finds every session cookie, in the order sent", () => {
		expect(sessionCookieCandidates("")).toEqual([]);
		expect(sessionCookieCandidates(null)).toEqual([]);
		expect(sessionCookieCandidates(`${HOST_ONLY}=good`)).toEqual([
			{ name: HOST_ONLY, value: "good" },
		]);
		expect(
			sessionCookieCandidates(`${HOST_ONLY}=dead; ${HOST_ONLY}=good`),
		).toEqual([
			{ name: HOST_ONLY, value: "dead" },
			{ name: HOST_ONLY, value: "good" },
		]);
	});

	test("matches the exact name, never a prefix of a longer one", () => {
		expect(
			sessionCookieCandidates(`${HOST_ONLY}_other=x; ${HOST_ONLY}=good`),
		).toEqual([{ name: HOST_ONLY, value: "good" }]);
	});

	test("both spellings count, and each keeps its own name", () => {
		expect(
			sessionCookieCandidates(`${SECURE}=secure; ${HOST_ONLY}=plain`),
		).toEqual([
			{ name: SECURE, value: "secure" },
			{ name: HOST_ONLY, value: "plain" },
		]);
	});

	test("keeps the whole value, including the signature's padding '='", () => {
		expect(sessionCookieCandidates(`${HOST_ONLY}=tok.c2ln=`)).toEqual([
			{ name: HOST_ONLY, value: "tok.c2ln=" },
		]);
	});
});

describe("resolveSession", () => {
	test("passes the request through untouched for a single-cookie jar", async () => {
		const auth = fakeAuth(SECURE, "good");
		const headers = new Headers({ cookie: `${SECURE}=good` });
		expect(await resolveSession(auth, headers)).toMatchObject({
			user: { id: "u1" },
		});
		expect(auth.seen).toEqual([`${SECURE}=good`]);
	});

	test("resolves the live cookie when a dead twin is FIRST — under __Secure-", async () => {
		// The production spelling. Probing a candidate under any OTHER name is
		// invisible to Better Auth, so rewriting the jar to the unprefixed
		// basename would answer `null` for every candidate and lock out every
		// duplicated jar in prod — a worse brick than the one being fixed.
		const auth = fakeAuth(SECURE, "good");
		const headers = new Headers({
			cookie: `${SECURE}=dead; ${SECURE}=good`,
		});
		expect(await resolveSession(auth, headers)).toMatchObject({
			user: { id: "u1" },
		});
	});

	test("resolves the live cookie when a dead twin is FIRST — unprefixed", async () => {
		const auth = fakeAuth(HOST_ONLY, "good");
		const headers = new Headers({
			cookie: `${HOST_ONLY}=dead; ${HOST_ONLY}=good`,
		});
		expect(await resolveSession(auth, headers)).toMatchObject({
			user: { id: "u1" },
		});
	});

	test("resolves across mixed spellings without collapsing them to one name", async () => {
		// A jar that outlived an http→https switch holds both names at once.
		const auth = fakeAuth(SECURE, "good");
		const headers = new Headers({
			cookie: `${HOST_ONLY}=stale; ${SECURE}=good`,
		});
		expect(await resolveSession(auth, headers)).toMatchObject({
			user: { id: "u1" },
		});
	});

	test("stays null when no candidate verifies", async () => {
		const auth = fakeAuth(SECURE, "good");
		const headers = new Headers({
			cookie: `${SECURE}=dead; ${SECURE}=alsodead`,
		});
		expect(await resolveSession(auth, headers)).toBeNull();
	});

	test("keeps every other header while probing", async () => {
		const auth = fakeAuth(SECURE, "good");
		const headers = new Headers({
			cookie: `${SECURE}=dead; ${SECURE}=good`,
			origin: "https://app.lobu.ai",
		});
		let sawOrigin = true;
		const wrapped = {
			seen: auth.seen,
			api: {
				getSession: async (opts: { headers: Headers }) => {
					sawOrigin &&= opts.headers.get("origin") === "https://app.lobu.ai";
					return auth.api.getSession(opts);
				},
			},
		};
		await resolveSession(wrapped, headers);
		expect(sawOrigin).toBe(true);
	});

	test("keeps Better Auth's companion cookies in every probe", async () => {
		// `dont_remember` gates session-expiry refresh and `session_data` is the
		// cookie cache. Replacing the whole jar with one pair would drop them, so
		// a duplicated jar would get different refresh semantics from a clean one
		// — a difference unrelated to which twin is live.
		const auth = fakeAuth(SECURE, "good");
		const headers = new Headers({
			cookie: `better-auth.dont_remember=1; ${SECURE}=dead; other=keep; ${SECURE}=good`,
		});

		expect(await resolveSession(auth, headers)).toMatchObject({
			user: { id: "u1" },
		});
		// Both probes carried the companions; neither carried the other twin.
		expect(auth.seen).toEqual([
			`better-auth.dont_remember=1; other=keep; ${SECURE}=dead`,
			`better-auth.dont_remember=1; other=keep; ${SECURE}=good`,
		]);
	});

	test("bounds how many candidates one request can make it probe", async () => {
		// The Cookie header is attacker-controlled, and every probe is a session
		// lookup. A real jar holds a handful of twins at most.
		const auth = fakeAuth(SECURE, "good");
		const jar = Array.from(
			{ length: 40 },
			(_, i) => `${SECURE}=dead${i}`,
		).join("; ");
		expect(await resolveSession(auth, new Headers({ cookie: jar }))).toBeNull();
		expect(auth.seen.length).toBeLessThanOrEqual(8);
	});
});

/**
 * Better Auth's own `/api/auth/*` handler resolves the jar itself, so wrapping
 * `getSession` at our call sites does not reach it. `get-session` is how the web
 * app asks "am I signed in", so leaving that one order-dependent would keep the
 * brick visible in the UI with every internal call site already fixed.
 */
describe("collapseSessionCookies", () => {
	test("returns the very same Headers for an ordinary jar", async () => {
		const auth = fakeAuth(SECURE, "good");
		const headers = new Headers({ cookie: `${SECURE}=good` });
		// Identity, not equality: the common path must not even copy.
		expect(await collapseSessionCookies(auth, headers)).toBe(headers);
	});

	test("reduces a duplicated jar to the live cookie", async () => {
		const auth = fakeAuth(SECURE, "good");
		const headers = new Headers({
			cookie: `${SECURE}=dead; other=keep; ${SECURE}=good`,
		});
		const out = await collapseSessionCookies(auth, headers);
		expect(out.get("cookie")).toBe(`other=keep; ${SECURE}=good`);
	});

	test("strips the session cookie entirely when none verifies", async () => {
		// Handing Better Auth an arbitrary dead twin would let sign-out act on
		// it. "Not signed in" is the honest jar.
		const auth = fakeAuth(SECURE, "good");
		const headers = new Headers({
			cookie: `${SECURE}=dead; other=keep; ${SECURE}=alsodead`,
		});
		const out = await collapseSessionCookies(auth, headers);
		expect(out.get("cookie")).toBe("other=keep");
	});

	test("drops the Cookie header when nothing survives stripping", async () => {
		const auth = fakeAuth(SECURE, "good");
		const headers = new Headers({
			cookie: `${SECURE}=dead; ${SECURE}=alsodead`,
		});
		const out = await collapseSessionCookies(auth, headers);
		expect(out.get("cookie")).toBeNull();
	});

	test("keeps every other header", async () => {
		const auth = fakeAuth(SECURE, "good");
		const headers = new Headers({
			cookie: `${SECURE}=dead; ${SECURE}=good`,
			origin: "https://app.lobu.ai",
		});
		const out = await collapseSessionCookies(auth, headers);
		expect(out.get("origin")).toBe("https://app.lobu.ai");
	});
});

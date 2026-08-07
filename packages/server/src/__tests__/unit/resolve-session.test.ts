import { describe, expect, test } from "bun:test";
import { sessionCookieName } from "../../auth/session-cookie-scope";
import {
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

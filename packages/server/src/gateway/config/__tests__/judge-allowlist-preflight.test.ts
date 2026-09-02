/**
 * Boot preflight for the one allowlist state that silently disables EVERY
 * egress judge.
 *
 * `checkDomainAccess` consults the global allowlist (step 3) BEFORE the judge
 * (step 5), so `WORKER_ALLOWED_DOMAINS=*` returns `allowed: true, source:
 * "global"` for every host and no judge ever runs. `logAccessDecision`
 * deliberately drops `allowed && source === "global"` lines, so the suppression
 * produces no per-request evidence either: the traffic simply flows and the
 * operator's policy is dead config. One boot line is the only place this can
 * surface.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { checkJudgeShadowingAllowlist } from "../network-allowlist.js";

const WAD_PRESERVE = process.env.WORKER_ALLOWED_DOMAINS;
const SENTRY_PRESERVE = process.env.SENTRY_DSN;

beforeEach(() => {
  delete process.env.WORKER_ALLOWED_DOMAINS;
  delete process.env.SENTRY_DSN;
});

afterEach(() => {
  if (WAD_PRESERVE === undefined) delete process.env.WORKER_ALLOWED_DOMAINS;
  else process.env.WORKER_ALLOWED_DOMAINS = WAD_PRESERVE;
  if (SENTRY_PRESERVE === undefined) delete process.env.SENTRY_DSN;
  else process.env.SENTRY_DSN = SENTRY_PRESERVE;
});

describe("checkJudgeShadowingAllowlist", () => {
  test("unrestricted mode reports the shadowing", () => {
    process.env.WORKER_ALLOWED_DOMAINS = "*";
    const detail = checkJudgeShadowingAllowlist();
    expect(detail).not.toBeNull();
    // Must name the variable AND the consequence — a warning the operator
    // cannot act on is worse than none.
    expect(detail).toContain("WORKER_ALLOWED_DOMAINS");
    expect(detail?.toLowerCase()).toContain("judge");
  });

  test("a restricted allowlist reports nothing", () => {
    process.env.WORKER_ALLOWED_DOMAINS = "github.com,registry.npmjs.org";
    expect(checkJudgeShadowingAllowlist()).toBeNull();
  });

  test("complete isolation (unset) reports nothing — it shadows no judge", () => {
    expect(checkJudgeShadowingAllowlist()).toBeNull();
  });

  test("a single-entry allowlist is NOT unrestricted", () => {
    // Guards the `length === 1 && [0] === "*"` shape in isUnrestrictedMode:
    // a one-domain list must not be mistaken for `*`.
    process.env.WORKER_ALLOWED_DOMAINS = "github.com";
    expect(checkJudgeShadowingAllowlist()).toBeNull();
  });

  test("a list CONTAINING * alongside others is NOT unrestricted mode", () => {
    // `isUnrestrictedMode` is exact-shape, so "*,github.com" is NOT unrestricted
    // mode; `matchesDomainPattern` then treats the bare "*" as an exact host
    // that nothing matches, so only github.com is admitted and judges still
    // run. Pin the contract so a change to either side is visible here.
    process.env.WORKER_ALLOWED_DOMAINS = "*,github.com";
    expect(checkJudgeShadowingAllowlist()).toBeNull();
  });

  test("whitespace around * still counts as unrestricted", () => {
    process.env.WORKER_ALLOWED_DOMAINS = "  *  ";
    expect(checkJudgeShadowingAllowlist()).not.toBeNull();
  });

  test("SENTRY_DSN does not defeat the unrestricted check", () => {
    // loadAllowedDomains appends the Sentry host in restricted mode but must
    // leave `*` alone; if it ever appended, the array would stop being `["*"]`
    // and this preflight would silently stop firing.
    process.env.SENTRY_DSN = "https://abc@o1.ingest.sentry.io/2";
    process.env.WORKER_ALLOWED_DOMAINS = "*";
    expect(checkJudgeShadowingAllowlist()).not.toBeNull();
  });
});

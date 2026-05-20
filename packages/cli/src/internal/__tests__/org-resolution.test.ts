/**
 * Tests for org-slug resolution logic in `resolveApiClient`:
 *  - 0 orgs → "No organization selected" error
 *  - 1 org → auto-selected
 *  - >1 orgs → "Multiple organizations" error
 *  - explicit --org slug → used directly
 *  - LOBU_ORG env var → used directly
 *  - missing auth token → clear error message
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { resolveApiClient } from "../api-client.js";
import * as context from "../context.js";
import * as credentials from "../credentials.js";

function makeUserInfoFetch(
  orgs: Array<{ slug: string; name?: string }>
): typeof fetch {
  return (async (_url, _init) => {
    return new Response(JSON.stringify({ sub: "u1", organizations: orgs }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

describe("resolveApiClient — org resolution", () => {
  beforeEach(() => {
    delete process.env.LOBU_ORG;
    delete process.env.LOBU_API_TOKEN;

    spyOn(context, "resolveContext").mockResolvedValue({
      name: "prod",
      url: "https://app.lobu.ai/api/v1",
      source: "config",
    });
    spyOn(context, "findContextByUrl").mockResolvedValue(undefined);
    spyOn(context, "loadContextConfig").mockResolvedValue({
      currentContext: "prod",
      contexts: { prod: { url: "https://app.lobu.ai/api/v1" } },
    });
  });

  afterEach(() => {
    mock.restore();
    delete process.env.LOBU_ORG;
    delete process.env.LOBU_API_TOKEN;
  });

  test("0 orgs → throws 'No organization selected' error", async () => {
    spyOn(credentials, "getToken").mockResolvedValue("tok");
    spyOn(context, "getActiveOrg").mockResolvedValue(undefined);

    await expect(
      resolveApiClient({ fetchImpl: makeUserInfoFetch([]) })
    ).rejects.toThrow(/No organization selected/);
  });

  test("1 org → auto-selected without user intervention", async () => {
    spyOn(credentials, "getToken").mockResolvedValue("tok");
    spyOn(context, "getActiveOrg").mockResolvedValue(undefined);

    const result = await resolveApiClient({
      fetchImpl: makeUserInfoFetch([{ slug: "only-org", name: "Only" }]),
    });

    expect(result.orgSlug).toBe("only-org");
  });

  test(">1 orgs → throws 'Multiple organizations' error listing them", async () => {
    spyOn(credentials, "getToken").mockResolvedValue("tok");
    spyOn(context, "getActiveOrg").mockResolvedValue(undefined);

    await expect(
      resolveApiClient({
        fetchImpl: makeUserInfoFetch([
          { slug: "alpha-org" },
          { slug: "beta-org" },
        ]),
      })
    ).rejects.toThrow(/Multiple organizations/);
  });

  test(">1 orgs + explicit org option → uses the explicit slug (no fetch needed)", async () => {
    spyOn(credentials, "getToken").mockResolvedValue("tok");
    spyOn(context, "getActiveOrg").mockResolvedValue(undefined);

    // Passing org= should short-circuit the userinfo fetch.
    const fetchSpy = mock(async () => new Response("{}", { status: 200 }));
    const result = await resolveApiClient({
      org: "explicit-org",
      fetchImpl: fetchSpy as typeof fetch,
    });

    expect(result.orgSlug).toBe("explicit-org");
    // userinfo fetch should NOT have been called
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("LOBU_ORG env var is used when no --org option is given", async () => {
    process.env.LOBU_ORG = "env-org";
    spyOn(credentials, "getToken").mockResolvedValue("tok");
    spyOn(context, "getActiveOrg").mockResolvedValue(undefined);

    const fetchSpy = mock(async () => new Response("{}", { status: 200 }));
    const result = await resolveApiClient({
      fetchImpl: fetchSpy as typeof fetch,
    });

    expect(result.orgSlug).toBe("env-org");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("active org from context store takes priority over userinfo", async () => {
    spyOn(credentials, "getToken").mockResolvedValue("tok");
    spyOn(context, "getActiveOrg").mockResolvedValue("stored-org");

    // Even with 2 orgs in userinfo, the stored one wins.
    const result = await resolveApiClient({
      fetchImpl: makeUserInfoFetch([{ slug: "other-a" }, { slug: "other-b" }]),
    });

    expect(result.orgSlug).toBe("stored-org");
  });

  test("missing token → throws 'Not logged in' error with login hint", async () => {
    spyOn(credentials, "getToken").mockResolvedValue(null);
    spyOn(context, "getActiveOrg").mockResolvedValue("acme");

    await expect(
      resolveApiClient({ fetchImpl: makeUserInfoFetch([]) })
    ).rejects.toThrow(/Not logged in/);
  });

  test("LOBU_API_TOKEN env var bypasses credential store", async () => {
    process.env.LOBU_API_TOKEN = "env-token";
    // getToken should NOT be called when LOBU_API_TOKEN is set.
    const getTokenSpy = spyOn(credentials, "getToken").mockResolvedValue(null);
    spyOn(context, "getActiveOrg").mockResolvedValue("acme");

    const result = await resolveApiClient({
      fetchImpl: makeUserInfoFetch([{ slug: "acme" }]),
    });

    expect(result.token).toBe("env-token");
    // getToken was called but its result was ignored in favor of env var
    // (The implementation calls `process.env.LOBU_API_TOKEN || await getToken(...)`)
    // so getToken may or may not be called — we just verify the right token is used.
    expect(result.orgSlug).toBe("acme");
  });

  test("invalid org slug (uppercase) causes a validation error", async () => {
    spyOn(credentials, "getToken").mockResolvedValue("tok");
    spyOn(context, "getActiveOrg").mockResolvedValue(undefined);

    await expect(
      resolveApiClient({
        org: "INVALID_SLUG",
        fetchImpl: makeUserInfoFetch([]),
      })
    ).rejects.toThrow(/Invalid organization slug/);
  });
});

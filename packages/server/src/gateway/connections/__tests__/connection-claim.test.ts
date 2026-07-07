/**
 * The provider-agnostic claim ENGINE (`claimPendingConnection` /
 * `resolveClaimContext`): binds a parked (pending) subject to the claiming
 * user's org once the PROVIDER's authority verdict passes and the user confirms
 * an org. The engine owns org-resolution, two-phase confirm-before-bind,
 * idempotent already-connected success, and the terminal error taxonomy; a stub
 * provider stands in for the authority half so no DB / HTTP / Slack is needed.
 */

import { describe, expect, mock, test } from "bun:test";
import {
  type ClaimAuthorization,
  type ClaimEligibleOrg,
  type ClaimEngineDeps,
  type ClaimProvider,
  claimHttpStatus,
  claimPendingConnection,
  resolveClaimContext,
} from "../connection-claim.js";

const REF = "T-CLAIM";

/** The stub provider's pending shape — opaque to the engine. */
interface StubPending {
  ref: string;
  name: string | null;
}

function makeProvider(overrides: Partial<ClaimProvider<StubPending>> = {}): {
  provider: ClaimProvider<StubPending>;
  bind: ReturnType<typeof mock>;
  authorize: ReturnType<typeof mock>;
} {
  const bind = mock(async () => ({ bindingId: "binding-bound" }));
  const authorize = mock(
    async (): Promise<ClaimAuthorization> => ({
      status: "authorized",
      subjectName: "Acme",
    }),
  );
  const provider: ClaimProvider<StubPending> = {
    provider: "stub",
    subjectKind: "workspace",
    resolvePending: mock(async () => ({ ref: REF, name: "Acme" })),
    resolveExistingBinding: mock(async () => null),
    authorize,
    bind,
    ...overrides,
  };
  return { provider, bind, authorize };
}

function makeDeps(overrides: Partial<ClaimEngineDeps> = {}): ClaimEngineDeps {
  return {
    resolveMemberOrgs: mock(async () => [
      { id: "org-1", slug: "acme", name: "Acme", isPersonal: false },
    ]),
    resolveOrgIfMember: mock(async () => "org-1"),
    resolveOrgSlug: mock(async () => "acme"),
    ...overrides,
  };
}

// A confirmed claim always carries the org the user picked on the claim page —
// the engine rejects an org-less claim (never routes to a default org).
const input = { userId: "user-1", ref: REF, organizationId: "acme" };

describe("claimPendingConnection", () => {
  test("binds the subject on the happy path (authorized)", async () => {
    const { provider, bind } = makeProvider();
    const result = await claimPendingConnection(provider, makeDeps(), input);

    expect(result).toEqual({
      status: "ok",
      orgSlug: "acme",
      bindingId: "binding-bound",
    });
    expect(bind).toHaveBeenCalledTimes(1);
    const [boundPending, boundOrg, boundUser] = bind.mock.calls[0]!;
    expect((boundPending as StubPending).ref).toBe(REF);
    expect(boundOrg).toBe("org-1");
    expect(boundUser).toBe("user-1");
  });

  test("binds into the explicitly chosen org (membership-verified)", async () => {
    const { provider, bind } = makeProvider();
    const deps = makeDeps({
      resolveOrgIfMember: mock(async () => "org-2"),
      resolveOrgSlug: mock(async () => "other-org"),
    });
    const result = await claimPendingConnection(provider, deps, {
      ...input,
      organizationId: "other-org",
    });
    expect(result).toEqual({
      status: "ok",
      orgSlug: "other-org",
      bindingId: "binding-bound",
    });
    expect(bind.mock.calls[0]![1]).toBe("org-2");
  });

  test("rejects binding into an org the user is not a member of", async () => {
    const { provider, bind } = makeProvider();
    const deps = makeDeps({ resolveOrgIfMember: mock(async () => null) });
    const result = await claimPendingConnection(provider, deps, {
      ...input,
      organizationId: "not-mine",
    });
    expect(result).toEqual({ status: "not_member_of_org" });
    expect(bind).not.toHaveBeenCalled();
  });

  test("carries the provider's not_authorized code as payload and never binds", async () => {
    const { provider, bind } = makeProvider({
      authorize: mock(
        async (): Promise<ClaimAuthorization> => ({
          status: "not_authorized",
          code: "not_admin",
        }),
      ),
    });
    const result = await claimPendingConnection(provider, makeDeps(), input);
    expect(result).toEqual({ status: "not_authorized", code: "not_admin" });
    expect(bind).not.toHaveBeenCalled();
  });

  test("carries the provider's signin_required provider as payload", async () => {
    const { provider, bind } = makeProvider({
      authorize: mock(
        async (): Promise<ClaimAuthorization> => ({
          status: "signin_required",
          signinProvider: "slack",
        }),
      ),
    });
    const result = await claimPendingConnection(provider, makeDeps(), input);
    expect(result).toEqual({
      status: "signin_required",
      signinProvider: "slack",
    });
    expect(bind).not.toHaveBeenCalled();
  });

  test("already-connected subject is an idempotent success", async () => {
    const { provider, bind } = makeProvider({
      resolvePending: mock(async () => null),
      resolveExistingBinding: mock(async () => ({ orgSlug: "acme" })),
    });
    const result = await claimPendingConnection(provider, makeDeps(), input);
    expect(result).toEqual({
      status: "ok",
      orgSlug: "acme",
      bindingId: "",
      alreadyConnected: true,
    });
    expect(bind).not.toHaveBeenCalled();
  });

  test("404s when the subject has no install at all", async () => {
    const { provider } = makeProvider({
      resolvePending: mock(async () => null),
      resolveExistingBinding: mock(async () => null),
    });
    const result = await claimPendingConnection(provider, makeDeps(), input);
    expect(result).toEqual({ status: "no_pending" });
  });

  test("rejects an org-less claim — never binds to a default org", async () => {
    // An external OAuth install must not create a connection under an org the
    // installer never picked. A claim with no confirmed org is invalid_request,
    // NOT silently routed to the caller's default/oldest org.
    const { provider, bind } = makeProvider();
    const resolveOrgIfMember = mock(async () => "org-1");
    const deps = makeDeps({ resolveOrgIfMember });
    const result = await claimPendingConnection(provider, deps, {
      ...input,
      organizationId: undefined,
    });
    expect(result).toEqual({ status: "invalid_request" });
    expect(bind).not.toHaveBeenCalled();
    expect(resolveOrgIfMember).not.toHaveBeenCalled();
  });

  test("401s an unauthenticated caller before any work", async () => {
    const { provider } = makeProvider();
    const resolvePending = provider.resolvePending as ReturnType<typeof mock>;
    const result = await claimPendingConnection(provider, makeDeps(), {
      ...input,
      userId: null,
    });
    expect(result).toEqual({ status: "unauthenticated" });
    expect(resolvePending).not.toHaveBeenCalled();
  });

  test("400s a missing ref", async () => {
    const { provider } = makeProvider();
    expect(
      (await claimPendingConnection(provider, makeDeps(), { ...input, ref: "" }))
        .status,
    ).toBe("invalid_request");
  });

  test("maps an unexpected bind failure to claim_failed", async () => {
    const { provider } = makeProvider({
      bind: mock(async () => {
        throw new Error("secret store unavailable");
      }),
    });
    const result = await claimPendingConnection(provider, makeDeps(), input);
    expect(result).toEqual({
      status: "claim_failed",
      message: "secret store unavailable",
    });
  });
});

describe("resolveClaimContext", () => {
  test("returns the eligible orgs with the isPersonal marker (personal last)", async () => {
    const orgs: ClaimEligibleOrg[] = [
      { id: "org-team", slug: "team", name: "Team Org", isPersonal: false },
      { id: "org-me", slug: "me", name: "My Personal", isPersonal: true },
    ];
    const { provider } = makeProvider();
    const deps = makeDeps({ resolveMemberOrgs: mock(async () => orgs) });
    const ctx = await resolveClaimContext(provider, deps, input);
    expect(ctx.status).toBe("ready");
    if (ctx.status !== "ready") throw new Error("expected ready");
    expect(ctx.orgs).toEqual(orgs);
    expect(ctx.orgs[0]!.isPersonal).toBe(false);
    expect(ctx.orgs[ctx.orgs.length - 1]!.isPersonal).toBe(true);
  });

  test("surfaces the subjectName from the authorize verdict", async () => {
    const { provider } = makeProvider({
      authorize: mock(
        async (): Promise<ClaimAuthorization> => ({
          status: "authorized",
          subjectName: "Contoso HQ",
        }),
      ),
    });
    const ctx = await resolveClaimContext(provider, makeDeps(), input);
    if (ctx.status !== "ready") throw new Error("expected ready");
    expect(ctx.subjectName).toBe("Contoso HQ");
  });

  test("no_org when the claimer belongs to no orgs", async () => {
    const { provider } = makeProvider();
    const deps = makeDeps({ resolveMemberOrgs: mock(async () => []) });
    const ctx = await resolveClaimContext(provider, deps, input);
    expect(ctx).toEqual({ status: "no_org" });
  });

  test("propagates already_connected without touching orgs", async () => {
    const { provider } = makeProvider({
      resolvePending: mock(async () => null),
      resolveExistingBinding: mock(async () => ({ orgSlug: "acme" })),
    });
    const resolveMemberOrgs = mock(async () => [] as ClaimEligibleOrg[]);
    const ctx = await resolveClaimContext(
      provider,
      makeDeps({ resolveMemberOrgs }),
      input,
    );
    expect(ctx).toEqual({ status: "already_connected", orgSlug: "acme" });
    expect(resolveMemberOrgs).not.toHaveBeenCalled();
  });
});

describe("claimHttpStatus", () => {
  test("maps every status to its HTTP code", () => {
    expect(claimHttpStatus("unauthenticated")).toBe(401);
    expect(claimHttpStatus("invalid_request")).toBe(400);
    expect(claimHttpStatus("no_pending")).toBe(404);
    expect(claimHttpStatus("signin_required")).toBe(403);
    expect(claimHttpStatus("not_authorized")).toBe(403);
    expect(claimHttpStatus("not_member_of_org")).toBe(403);
    expect(claimHttpStatus("no_org")).toBe(409);
    expect(claimHttpStatus("claim_failed")).toBe(500);
  });
});

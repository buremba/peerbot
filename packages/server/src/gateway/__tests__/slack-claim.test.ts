/**
 * The Slack marketplace "claim" flow: `claimSlackWorkspace` binds a parked
 * (pending) install to the claiming user's org. Authority is the Slack
 * workspace-admin check — the caller must have signed in with Slack for the
 * workspace and be an admin/owner. There is NO secret link token; a signed-in
 * admin can always connect a pending install for their team.
 *
 * Pure unit test — `claimSlackWorkspace` takes every dependency by injection, so
 * no DB / HTTP / server boot is needed. We assert the guard ordering and, on the
 * happy path, that the bind (`claim`) runs with the resolved org.
 */

import { describe, expect, mock, test } from "bun:test";
import type { SlackPendingInstall } from "../../lobu/stores/slack-installations.js";
import {
  claimSlackWorkspace,
  type SlackClaimDeps,
} from "../connections/slack-claim.js";

const TEAM = "T-CLAIM";

function pendingInstall(
  overrides: Partial<SlackPendingInstall> = {},
): SlackPendingInstall {
  return {
    id: "1",
    teamId: TEAM,
    teamName: "Acme",
    botUserId: "B123",
    installerUserId: "U-INSTALLER",
    botToken: "xoxb-workspace-token",
    isEnterpriseInstall: false,
    ...overrides,
  };
}

/** Deps that reach the happy path; individual tests override single fields. */
function makeDeps(overrides: Partial<SlackClaimDeps> = {}): {
  deps: SlackClaimDeps;
  claim: ReturnType<typeof mock>;
} {
  const claim = mock(async () => ({ installationId: "slackinst-bound" }));
  const deps: SlackClaimDeps = {
    resolvePending: mock(async () => pendingInstall()),
    resolveActiveOrgSlug: mock(async () => null),
    resolveClaimerSlackId: mock(async () => "U-ADMIN"),
    usersInfo: mock(async () => ({ isAdmin: true, isOwner: false })),
    resolveMemberOrgs: mock(async () => [
      { id: "org-1", slug: "acme", name: "Acme" },
    ]),
    resolveOrgIfMember: mock(async () => "org-1"),
    resolveDefaultOrgId: mock(async () => "org-1"),
    claim,
    resolveOrgSlug: mock(async () => "acme"),
    ...overrides,
  };
  return { deps, claim };
}

const input = { userId: "user-1", team: TEAM };

describe("claimSlackWorkspace", () => {
  test("binds the workspace on the happy path (signed-in admin)", async () => {
    const { deps, claim } = makeDeps();
    const result = await claimSlackWorkspace(deps, input);

    expect(result).toEqual({
      status: "ok",
      orgSlug: "acme",
      installationId: "slackinst-bound",
    });
    // Bound into the resolved org with the pending row's decrypted token.
    expect(claim).toHaveBeenCalledTimes(1);
    const [boundPending, boundOrg] = claim.mock.calls[0]!;
    expect((boundPending as SlackPendingInstall).teamId).toBe(TEAM);
    expect(boundOrg).toBe("org-1");
  });

  test("owner (not admin) is also allowed to claim", async () => {
    const { deps } = makeDeps({
      usersInfo: mock(async () => ({ isAdmin: false, isOwner: true })),
    });
    const result = await claimSlackWorkspace(deps, input);
    expect(result.status).toBe("ok");
  });

  test("binds into the explicitly chosen org (membership-verified)", async () => {
    const { deps, claim } = makeDeps({
      resolveOrgIfMember: mock(async () => "org-2"),
      resolveOrgSlug: mock(async () => "other-org"),
    });
    const result = await claimSlackWorkspace(deps, {
      ...input,
      organizationId: "other-org",
    });
    expect(result).toEqual({
      status: "ok",
      orgSlug: "other-org",
      installationId: "slackinst-bound",
    });
    expect(claim.mock.calls[0]![1]).toBe("org-2");
  });

  test("rejects binding into an org the user is not a member of", async () => {
    const { deps, claim } = makeDeps({
      resolveOrgIfMember: mock(async () => null),
    });
    const result = await claimSlackWorkspace(deps, {
      ...input,
      organizationId: "not-mine",
    });
    expect(result).toEqual({ status: "not_member_of_org" });
    expect(claim).not.toHaveBeenCalled();
  });

  test("rejects a non-admin, non-owner and never binds", async () => {
    const { deps, claim } = makeDeps({
      usersInfo: mock(async () => ({ isAdmin: false, isOwner: false })),
    });
    const result = await claimSlackWorkspace(deps, input);
    expect(result).toEqual({ status: "not_admin" });
    expect(claim).not.toHaveBeenCalled();
  });

  test("requires Slack sign-in for the workspace before the admin check", async () => {
    const usersInfo = mock(async () => ({ isAdmin: true, isOwner: true }));
    const { deps, claim } = makeDeps({
      resolveClaimerSlackId: mock(async () => null),
      usersInfo,
    });
    const result = await claimSlackWorkspace(deps, input);
    expect(result).toEqual({ status: "slack_signin_required" });
    // Short-circuits before ever calling Slack or binding.
    expect(usersInfo).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
  });

  test("already-connected workspace is an idempotent success", async () => {
    const { deps, claim } = makeDeps({
      resolvePending: mock(async () => null),
      resolveActiveOrgSlug: mock(async () => "acme"),
    });
    const result = await claimSlackWorkspace(deps, input);
    expect(result).toEqual({
      status: "ok",
      orgSlug: "acme",
      installationId: "",
      alreadyConnected: true,
    });
    expect(claim).not.toHaveBeenCalled();
  });

  test("404s when the workspace has no install at all", async () => {
    const { deps } = makeDeps({
      resolvePending: mock(async () => null),
      resolveActiveOrgSlug: mock(async () => null),
    });
    const result = await claimSlackWorkspace(deps, input);
    expect(result).toEqual({ status: "no_pending_install" });
  });

  test("409s when the user has no default org", async () => {
    const { deps, claim } = makeDeps({
      resolveDefaultOrgId: mock(async () => null),
    });
    const result = await claimSlackWorkspace(deps, input);
    expect(result).toEqual({ status: "no_org" });
    expect(claim).not.toHaveBeenCalled();
  });

  test("401s an unauthenticated caller before any work", async () => {
    const { deps } = makeDeps();
    const resolvePending = deps.resolvePending as ReturnType<typeof mock>;
    const result = await claimSlackWorkspace(deps, { ...input, userId: null });
    expect(result).toEqual({ status: "unauthenticated" });
    expect(resolvePending).not.toHaveBeenCalled();
  });

  test("400s a missing team", async () => {
    const { deps } = makeDeps();
    expect(
      (await claimSlackWorkspace(deps, { ...input, team: "" })).status,
    ).toBe("invalid_request");
  });

  test("maps an unexpected bind failure to claim_failed", async () => {
    const { deps } = makeDeps({
      claim: mock(async () => {
        throw new Error("secret store unavailable");
      }),
    });
    const result = await claimSlackWorkspace(deps, input);
    expect(result).toEqual({
      status: "claim_failed",
      message: "secret store unavailable",
    });
  });
});

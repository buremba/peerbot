/**
 * Phase 3 of the Slack marketplace "claim" flow: `claimSlackWorkspace` binds a
 * parked (pending) install to the claiming user's org, but only after proving
 * the caller holds the single-use token, signed in with Slack for the workspace,
 * and is a workspace admin/owner.
 *
 * Pure unit test — `claimSlackWorkspace` takes every dependency by injection, so
 * no DB / HTTP / server boot is needed. We assert the guard ordering and, on the
 * happy path, that the bind (`claim`) runs with the resolved org.
 */

import { createHash } from "node:crypto";
import { describe, expect, mock, test } from "bun:test";
import type { SlackPendingInstall } from "../../lobu/stores/slack-installations.js";
import {
  claimSlackWorkspace,
  type SlackClaimDeps,
} from "../connections/slack-claim.js";

const TEAM = "T-CLAIM";
const REAL_TOKEN = "claim-token-abc";
const REAL_TOKEN_HASH = createHash("sha256").update(REAL_TOKEN).digest("hex");

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
    claimTokenHash: REAL_TOKEN_HASH,
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
    resolveClaimerSlackId: mock(async () => "U-ADMIN"),
    usersInfo: mock(async () => ({ isAdmin: true, isOwner: false })),
    resolveDefaultOrgId: mock(async () => "org-1"),
    claim,
    resolveOrgSlug: mock(async () => "acme"),
    ...overrides,
  };
  return { deps, claim };
}

const input = { userId: "user-1", team: TEAM, token: REAL_TOKEN };

describe("claimSlackWorkspace", () => {
  test("binds the workspace on the happy path (admin + valid token)", async () => {
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

  test("rejects a wrong claim token and never binds", async () => {
    const { deps, claim } = makeDeps();
    const result = await claimSlackWorkspace(deps, {
      ...input,
      token: "not-the-token",
    });
    expect(result).toEqual({ status: "invalid_token" });
    expect(claim).not.toHaveBeenCalled();
  });

  test("rejects when the pending row carries no claim hash", async () => {
    const { deps, claim } = makeDeps({
      resolvePending: mock(async () =>
        pendingInstall({ claimTokenHash: null }),
      ),
    });
    const result = await claimSlackWorkspace(deps, input);
    expect(result).toEqual({ status: "invalid_token" });
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

  test("404s when there is no pending install for the team", async () => {
    const { deps } = makeDeps({ resolvePending: mock(async () => null) });
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

  test("400s a missing team or token", async () => {
    const { deps } = makeDeps();
    expect(
      (await claimSlackWorkspace(deps, { ...input, team: "" })).status,
    ).toBe("invalid_request");
    expect(
      (await claimSlackWorkspace(deps, { ...input, token: "" })).status,
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

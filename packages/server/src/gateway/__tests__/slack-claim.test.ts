/**
 * The Slack adapter (`slackClaimProvider`) for the provider-agnostic claim
 * engine. This tests the AUTHORITY half Slack owns: the workspace-admin verdict
 * (`authorize`), the Grid installer-identity match, plain-workspace rejection,
 * idempotent existing-binding detection, and the bind→bindingId mapping. The
 * org-resolution / confirm-before-bind flow lives in the engine and is covered
 * by `connection-claim.test.ts`.
 *
 * Pure unit test — the adapter takes every Slack dependency by injection, so no
 * DB / HTTP / server boot is needed.
 */

import { describe, expect, mock, test } from "bun:test";
import { slackClaimProvider } from "../connections/slack-claim.js";
import type { SlackClaimProviderDeps } from "../connections/slack-claim.js";
import type { SlackPendingInstall } from "../../lobu/stores/slack-installations.js";

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
    enterpriseId: null,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<SlackClaimProviderDeps> = {}): {
  deps: SlackClaimProviderDeps;
  claim: ReturnType<typeof mock>;
} {
  const claim = mock(async () => ({ installationId: "slackinst-bound" }));
  const deps: SlackClaimProviderDeps = {
    resolvePending: mock(async () => pendingInstall()),
    resolveActiveOrgSlug: mock(async () => null),
    resolveClaimerSlackIdentities: mock(async () => [
      { teamId: TEAM, slackUserId: "U-ADMIN" },
    ]),
    usersInfo: mock(async () => ({ isAdmin: true, isOwner: false })),
    claim,
    ...overrides,
  };
  return { deps, claim };
}

describe("slackClaimProvider.authorize", () => {
  test("authorizes a signed-in workspace admin, carrying the workspace name", async () => {
    const { deps } = makeDeps();
    const provider = slackClaimProvider(deps);
    const verdict = await provider.authorize("user-1", pendingInstall());
    expect(verdict).toEqual({ status: "authorized", subjectName: "Acme" });
  });

  test("owner (not admin) is also authorized", async () => {
    const { deps } = makeDeps({
      usersInfo: mock(async () => ({ isAdmin: false, isOwner: true })),
    });
    const verdict = await slackClaimProvider(deps).authorize(
      "user-1",
      pendingInstall(),
    );
    expect(verdict.status).toBe("authorized");
  });

  test("a non-admin, non-owner is not_authorized with code not_admin", async () => {
    const { deps } = makeDeps({
      usersInfo: mock(async () => ({ isAdmin: false, isOwner: false })),
    });
    const verdict = await slackClaimProvider(deps).authorize(
      "user-1",
      pendingInstall(),
    );
    expect(verdict).toEqual({ status: "not_authorized", code: "not_admin" });
  });

  test("no workspace identity → signin_required{signinProvider:slack} before any Slack call", async () => {
    const usersInfo = mock(async () => ({ isAdmin: true, isOwner: true }));
    const { deps } = makeDeps({
      resolveClaimerSlackIdentities: mock(async () => []),
      usersInfo,
    });
    const verdict = await slackClaimProvider(deps).authorize(
      "user-1",
      pendingInstall(),
    );
    expect(verdict).toEqual({
      status: "signin_required",
      signinProvider: "slack",
    });
    expect(usersInfo).not.toHaveBeenCalled();
  });

  test("Grid org-admin with an installer-id match (enterpriseId set) is authorized without a Slack call", async () => {
    const usersInfo = mock(async () => ({ isAdmin: false, isOwner: false }));
    const { deps } = makeDeps({
      resolveClaimerSlackIdentities: mock(async () => [
        // A DIFFERENT workspace's identity — not TEAM-scoped.
        { teamId: "T-OTHER", slackUserId: "U-INSTALLER" },
      ]),
      usersInfo,
    });
    const verdict = await slackClaimProvider(deps).authorize(
      "user-1",
      pendingInstall({ installerUserId: "U-INSTALLER", enterpriseId: "E-GRID" }),
    );
    expect(verdict.status).toBe("authorized");
    expect(usersInfo).not.toHaveBeenCalled();
  });

  test("installer-id match on a PLAIN workspace (no enterpriseId) is NOT enough", async () => {
    const { deps } = makeDeps({
      resolveClaimerSlackIdentities: mock(async () => [
        { teamId: "T-OTHER", slackUserId: "U-INSTALLER" },
      ]),
    });
    const verdict = await slackClaimProvider(deps).authorize(
      "user-1",
      pendingInstall({ installerUserId: "U-INSTALLER", enterpriseId: null }),
    );
    expect(verdict).toEqual({
      status: "signin_required",
      signinProvider: "slack",
    });
  });
});

describe("slackClaimProvider.resolveExistingBinding", () => {
  test("returns the org slug when the workspace is already connected", async () => {
    const { deps } = makeDeps({
      resolveActiveOrgSlug: mock(async () => "acme"),
    });
    const existing = await slackClaimProvider(deps).resolveExistingBinding(TEAM);
    expect(existing).toEqual({ orgSlug: "acme" });
  });

  test("returns null when the workspace has no active install", async () => {
    const { deps } = makeDeps({
      resolveActiveOrgSlug: mock(async () => null),
    });
    const existing = await slackClaimProvider(deps).resolveExistingBinding(TEAM);
    expect(existing).toBeNull();
  });
});

describe("slackClaimProvider.bind", () => {
  test("maps the Slack installationId onto the engine's bindingId contract", async () => {
    const { deps, claim } = makeDeps();
    const result = await slackClaimProvider(deps).bind(
      pendingInstall(),
      "org-1",
      "user-1",
    );
    expect(result).toEqual({ bindingId: "slackinst-bound" });
    expect(claim).toHaveBeenCalledTimes(1);
    const [boundPending, boundOrg] = claim.mock.calls[0]!;
    expect((boundPending as SlackPendingInstall).teamId).toBe(TEAM);
    expect(boundOrg).toBe("org-1");
  });
});

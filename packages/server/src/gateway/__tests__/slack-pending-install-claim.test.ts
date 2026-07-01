/**
 * Phase 2 of the Slack marketplace "claim" flow: after a Slack-initiated
 * (marketplace) install is parked as a pending, unclaimed row,
 * `completeSlackPendingInstall` DMs the INSTALLER their connect link.
 *
 * This unit test stubs the Slack Web API (no HTTP), the pending-install store
 * (no DB), and the hosted-app credentials so the DM behaviour is exercised in
 * isolation. It proves: (1) with an installer id, `openDm` + `postMessage` are
 * called and the posted text carries the connect URL with the team id (no secret
 * token — authority is the Slack workspace-admin check at claim time); (2) with a
 * null installer, no DM is sent — the row is still parked.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { __resetPublicOriginCachesForTests } from "../../utils/public-origin.js";

// --- Stub the pending-install store: capture inputs, never touch Postgres. ---
const writeCalls: Array<Record<string, unknown>> = [];
mock.module("../../lobu/stores/slack-installations.js", () => ({
  writeSlackPendingInstall: mock(async (input: Record<string, unknown>) => {
    writeCalls.push(input);
    return { id: "1" };
  }),
  // Also imported by the coordinator module (webhook routing); unused here.
  getSlackInstallByTeamId: mock(async () => null),
  resolveSlackPendingByTenant: mock(async () => null),
  upsertSlackInstallByTeam: mock(async () => ({ id: "slackinst-x" })),
}));

// --- Hosted app credentials are configured (so the exchange path runs). ---
mock.module("../installation/app-install-credentials.js", () => ({
  getPrimedBundledMethod: () => ({}),
  resolveAppInstallCredentials: () => ({
    clientId: "client-id",
    clientSecret: "client-secret",
  }),
}));

// --- Stub the Slack Web API surface the coordinator uses. ---
const exchangeOAuthCode = mock(
  async (): Promise<{
    botToken: string;
    teamId: string;
    teamName: string | null;
    botUserId: string | null;
    authedUserId: string | null;
    isEnterpriseInstall: boolean;
  }> => ({
    botToken: "xoxb-installer-token",
    teamId: "T-CLAIM",
    teamName: "Acme",
    botUserId: "B123",
    authedUserId: "U-INSTALLER",
    isEnterpriseInstall: false,
  }),
);
const openDm = mock(async () => "D-INSTALLER");
const postMessage = mock(async () => undefined);
mock.module("../connections/slack-web.js", () => ({
  createSlackWebApi: () => ({ exchangeOAuthCode, openDm, postMessage }),
}));

async function loadCoordinator() {
  const mod = await import("../connections/slack-connection-coordinator.js");
  return mod.completeSlackPendingInstall;
}

function callbackRequest(): Request {
  return new Request(
    "https://gateway.example.com/slack/oauth_callback?code=the-code",
    { method: "GET" },
  );
}

describe("completeSlackPendingInstall — installer claim DM", () => {
  let savedWebUrl: string | undefined;

  beforeEach(() => {
    writeCalls.length = 0;
    exchangeOAuthCode.mockClear();
    openDm.mockClear();
    postMessage.mockClear();
    savedWebUrl = process.env.PUBLIC_WEB_URL;
    process.env.PUBLIC_WEB_URL = "https://app.lobu.ai";
    __resetPublicOriginCachesForTests();
  });

  afterEach(() => {
    if (savedWebUrl === undefined) delete process.env.PUBLIC_WEB_URL;
    else process.env.PUBLIC_WEB_URL = savedWebUrl;
    __resetPublicOriginCachesForTests();
  });

  test("DMs the installer a connect link with the team id (no secret token)", async () => {
    const completeSlackPendingInstall = await loadCoordinator();

    const result = await completeSlackPendingInstall(
      callbackRequest(),
      "https://gateway.example.com/slack/oauth_callback",
    );

    expect(result).toEqual({
      teamId: "T-CLAIM",
      teamName: "Acme",
      installerUserId: "U-INSTALLER",
    });

    // The DM is opened with the installer and the message is posted into it.
    expect(openDm).toHaveBeenCalledTimes(1);
    expect(openDm).toHaveBeenCalledWith("xoxb-installer-token", "U-INSTALLER");
    expect(postMessage).toHaveBeenCalledTimes(1);
    const [botToken, channel, text] = postMessage.mock.calls[0] as [
      string,
      string,
      string,
    ];
    expect(botToken).toBe("xoxb-installer-token");
    expect(channel).toBe("D-INSTALLER");

    // The posted text embeds the connect URL with the team id — no secret token
    // (authority is the Slack workspace-admin check at claim time).
    const match = text.match(
      /https:\/\/app\.lobu\.ai\/slack\/claim\?team=([^&\s]+)/,
    );
    expect(match).not.toBeNull();
    const [, teamParam] = match as RegExpMatchArray;
    expect(decodeURIComponent(teamParam)).toBe("T-CLAIM");
    expect(text).not.toContain("&t=");

    // The pending row is parked with the installer id and no token material.
    expect(writeCalls).toHaveLength(1);
    const parked = writeCalls[0]!;
    expect(parked.installerUserId).toBe("U-INSTALLER");
  });

  test("skips the DM when there is no installer, but still parks the pending row", async () => {
    exchangeOAuthCode.mockResolvedValueOnce({
      botToken: "xoxb-installer-token",
      teamId: "T-NOINSTALLER",
      teamName: null,
      botUserId: null,
      authedUserId: null,
      isEnterpriseInstall: false,
    });
    const completeSlackPendingInstall = await loadCoordinator();

    const result = await completeSlackPendingInstall(
      callbackRequest(),
      "https://gateway.example.com/slack/oauth_callback",
    );

    expect(result).toEqual({
      teamId: "T-NOINSTALLER",
      teamName: null,
      installerUserId: null,
    });
    // No DM without an installer to send it to.
    expect(openDm).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
    // The row is still parked (no installer to DM).
    expect(writeCalls).toHaveLength(1);
    expect(writeCalls[0]!.installerUserId).toBeNull();
  });
});

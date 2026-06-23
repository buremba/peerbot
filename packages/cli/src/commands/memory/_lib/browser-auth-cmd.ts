/**
 * Browser Auth Command
 *
 * Sets up browser auth for browser-based connectors by launching a dedicated
 * Chrome with remote debugging and storing its CDP endpoint on the auth
 * profile. The connector attaches over CDP at sync time (and harvests fresh
 * cookies from that live session for the headless fallback). There is no
 * profile-cookie copying — attaching to a real, logged-in Chrome is the only
 * capture path.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type CdpVersionInfo,
  fetchCdpVersionInfo,
  resolveCdpUrl,
} from "@lobu/connector-sdk";
import { printText } from "../../../internal/output.js";
import { resolveMcpEndpoint, restToolCall } from "./mcp.js";

/** Stub of the old getProfile() shim. resolveMcpEndpoint falls through to
 * auth store / env when config is empty, which is what we want. */
type ProfileShim = { config: Record<string, unknown> };
const emptyProfile: ProfileShim = { config: {} };

function getChromeBinary(): string {
  if (process.platform === "darwin") {
    return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  }
  if (process.platform === "linux") {
    return "/usr/bin/google-chrome";
  }
  throw new Error(`Unsupported platform: ${process.platform}`);
}

function sanitizeDirSegment(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9._-]+/g, "-");
  let start = 0;
  let end = sanitized.length;
  while (start < end && sanitized[start] === "-") start++;
  while (end > start && sanitized[end - 1] === "-") end--;
  return sanitized.slice(start, end) || "default";
}

function getDedicatedChromeProfileDir(name: string): string {
  return join(homedir(), ".lobu", "chrome-profiles", sanitizeDirSegment(name));
}

async function waitForCdpEndpoint(
  baseUrl: string,
  retries = 15
): Promise<CdpVersionInfo | null> {
  for (let i = 0; i < retries; i++) {
    const info = await fetchCdpVersionInfo(baseUrl);
    if (info) return info;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return null;
}

/**
 * The auth_data payload we write to the auth profile after a successful
 * CDP launch. Extracted so the unit test can pin its shape without
 * spawning Chrome — see cli-ux.test.ts. The crucial invariant is that
 * `user_data_dir` is NOT present: the connector-side cascade
 * (acquire.ts / browser-network.ts / browser-scraper-utils.ts) prefers
 * userDataDir over cdp_url and tries Playwright launchPersistentContext,
 * which can't open a profile dir held by the dedicated Chrome we just
 * launched. cdp_url alone keeps sync attaching live.
 */
export function buildBrowserAuthData(opts: {
  cdpUrl: string;
  profileName: string;
  capturedAt: string;
}) {
  return {
    cdp_url: opts.cdpUrl,
    captured_at: opts.capturedAt,
    captured_via: "cli" as const,
    browser_profile: opts.profileName,
  };
}

function launchDedicatedChrome(params: {
  chromeBinary: string;
  userDataDir: string;
  port: number;
  startUrl?: string;
}): void {
  mkdirSync(params.userDataDir, { recursive: true });

  const args = [
    `--user-data-dir=${params.userDataDir}`,
    `--remote-debugging-port=${params.port}`,
    "--remote-allow-origins=*",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-sync",
  ];

  if (params.startUrl) {
    args.push(params.startUrl);
  }

  const chrome = spawn(params.chromeBinary, args, {
    detached: true,
    stdio: "ignore",
  });
  chrome.unref();
}

async function resolveConnectorDomains(
  connectorKey: string,
  domainsOverride: string | undefined,
  cliProfile: ProfileShim
): Promise<string[] | null> {
  if (domainsOverride) {
    return domainsOverride.split(",").map((d) => d.trim());
  }

  const mcpUrl = await resolveMcpEndpoint(cliProfile.config);
  if (!mcpUrl) {
    printText(
      "No MCP URL configured. Use --domains to specify cookie domains manually."
    );
    return null;
  }

  const parsed = await restToolCall<any>(mcpUrl, "manage_catalog", {
    action: "list_installed",
    kinds: ["connectors"],
  });

  const installedItems: any[] = parsed?.installed?.connectors?.items ?? [];
  const connectors: any[] = installedItems.map((item: any) => ({
    ...(item.detail ?? {}),
    key: item.id,
    name: item.name,
    favicon_domain: item.detail?.favicon_domain,
  }));
  const connector = connectors.find((c: any) => c.key === connectorKey);

  if (!connector) {
    printText(`Unknown connector: ${connectorKey}`);
    return null;
  }

  const faviconDomain = connector.favicon_domain;
  if (!faviconDomain) {
    printText(
      `Connector "${connectorKey}" has no favicon_domain. Use --domains to specify cookie domains manually.`
    );
    return null;
  }

  return [faviconDomain, `.${faviconDomain}`];
}

export interface BrowserAuthOptions {
  connector: string;
  domains?: string;
  authProfileSlug?: string;
  remoteDebugPort?: string;
  dedicatedProfile?: string;
  check?: boolean;
}

export async function captureBrowserAuth(
  opts: BrowserAuthOptions
): Promise<void> {
  const args = opts;
  const cliProfile = emptyProfile;
  const connectorKey = args.connector;

  // --check: verify the CDP endpoint stored on an auth profile is reachable.
  if (args.check) {
    if (!args.authProfileSlug) {
      printText("--check requires --auth-profile-slug");
      process.exitCode = 1;
      return;
    }
    const mcpUrl = await resolveMcpEndpoint(cliProfile.config);
    if (!mcpUrl) {
      printText("No MCP URL configured.");
      process.exitCode = 1;
      return;
    }

    let parsed: any;
    try {
      parsed = await restToolCall<any>(mcpUrl, "manage_auth_profiles", {
        action: "test_auth_profile",
        auth_profile_slug: args.authProfileSlug,
      });
    } catch (err) {
      printText(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
      return;
    }
    if (parsed?.error) {
      printText(`Error: ${parsed.error}`);
      process.exitCode = 1;
      return;
    }

    if (parsed?.status === "ok") {
      if (
        typeof parsed.cdp_url === "string" &&
        parsed.cdp_url.trim().length > 0
      ) {
        const configuredCdpUrl = parsed.cdp_url.trim();
        let cdpUrl = configuredCdpUrl;
        let info: CdpVersionInfo | null = null;
        try {
          if (configuredCdpUrl.toLowerCase() === "auto") {
            cdpUrl = await resolveCdpUrl("auto");
          }
          info = await fetchCdpVersionInfo(cdpUrl);
        } catch {
          /* ignore */
        }
        if (!info) {
          printText(
            `CDP configured at ${configuredCdpUrl}, but the endpoint is not responding.`
          );
          process.exitCode = 1;
          return;
        }
        printText(`CDP endpoint live at ${cdpUrl}.`);
        if (info.Browser) {
          printText(`Browser: ${info.Browser}`);
        }
      } else {
        const expiresAt = parsed.expires_at
          ? new Date(parsed.expires_at)
          : null;
        const daysLeft = expiresAt
          ? Math.floor((expiresAt.getTime() - Date.now()) / 86400000)
          : null;
        printText(
          `${parsed.auth_cookie_name || "Auth cookie"} valid${daysLeft !== null ? ` (expires in ${daysLeft} days)` : ""}.`
        );
        if (typeof parsed.cookie_count === "number") {
          printText(`${parsed.cookie_count} cookies stored.`);
        }
      }
    } else {
      printText(parsed?.message || "Browser auth profile is not valid.");
      process.exitCode = 1;
    }
    return;
  }

  const binary = getChromeBinary();
  if (!existsSync(binary)) {
    printText(`Chrome not found at ${binary}`);
    process.exitCode = 1;
    return;
  }

  const profileName = args.dedicatedProfile || connectorKey;
  const userDataDir = getDedicatedChromeProfileDir(profileName);
  const port = parseInt(args.remoteDebugPort || "9222", 10);
  if (!Number.isFinite(port) || port <= 0) {
    printText(`Invalid --remoteDebugPort: ${args.remoteDebugPort}`);
    process.exitCode = 1;
    return;
  }

  const domains = await resolveConnectorDomains(
    connectorKey,
    args.domains,
    cliProfile
  );
  const startUrl = domains?.[0]
    ? domains[0].startsWith("http")
      ? domains[0]
      : `https://${domains[0].replace(/^\./, "")}`
    : undefined;
  const cdpUrl = `http://127.0.0.1:${port}`;

  printText(`Launching dedicated Chrome profile at ${userDataDir}`);
  printText(`CDP URL: ${cdpUrl}`);
  launchDedicatedChrome({
    chromeBinary: binary,
    userDataDir,
    port,
    startUrl,
  });

  const info = await waitForCdpEndpoint(cdpUrl);
  if (!info) {
    printText(
      `Chrome launched, but ${cdpUrl}/json/version did not become ready.`
    );
    process.exitCode = 1;
    return;
  }

  printText(`CDP endpoint ready at ${cdpUrl}`);
  if (info.Browser) {
    printText(`Browser: ${info.Browser}`);
  }

  if (args.authProfileSlug) {
    const mcpUrl = await resolveMcpEndpoint(cliProfile.config);

    if (!mcpUrl) {
      printText(
        "No MCP URL configured. Store the CDP URL on the auth profile manually."
      );
    } else {
      try {
        const parsed = await restToolCall<any>(mcpUrl, "manage_auth_profiles", {
          action: "update_auth_profile",
          auth_profile_slug: args.authProfileSlug,
          auth_data: buildBrowserAuthData({
            cdpUrl,
            profileName,
            capturedAt: new Date().toISOString(),
          }),
        });
        if (parsed?.error) {
          printText(`Error: ${parsed.error}`);
          process.exitCode = 1;
          return;
        }
        printText(`CDP URL stored on auth profile ${args.authProfileSlug}.`);
      } catch (err) {
        printText(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
        return;
      }
    }
  }

  printText("\nNext steps:");
  printText(
    "  1. Sign into the site in the dedicated Chrome window if needed."
  );
  printText(
    `  2. Run: lobu memory browser-auth --connector ${connectorKey}${args.authProfileSlug ? ` --auth-profile-slug ${args.authProfileSlug}` : ""} --check`
  );
}

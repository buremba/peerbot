/**
 * Browser Auth Command
 *
 * Captures authentication cookies from the user's local Chrome browser
 * for browser-based connectors. On macOS, decrypts the Chrome cookie store
 * directly using the Keychain encryption key. On Linux, uses headless Chrome via CDP.
 */

import { spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { get as httpGet } from "node:http";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CdpVersionInfo,
  fetchCdpVersionInfo,
  resolveCdpUrl,
} from "@lobu/connector-sdk";
import { printText } from "./output.js";

/** Stub of the old getProfile() shim. resolveMcpEndpoint falls through to
 * auth store / env when config is empty, which is what we want. */
type ProfileShim = { config: Record<string, unknown> };
const emptyProfile: ProfileShim = { config: {} };

function getChromePaths(): { binary: string; profileDir: string } {
  const home = homedir();
  if (process.platform === "darwin") {
    return {
      binary: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      profileDir: join(home, "Library/Application Support/Google/Chrome"),
    };
  }
  if (process.platform === "linux") {
    return {
      binary: "/usr/bin/google-chrome",
      profileDir: join(home, ".config/google-chrome"),
    };
  }
  throw new Error(`Unsupported platform: ${process.platform}`);
}

interface ChromeProfile {
  dir: string;
  name: string;
  email: string;
  isLastUsed: boolean;
}

interface BrowserCookie {
  name?: string;
  value?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
}

function listProfiles(profileDir: string): ChromeProfile[] {
  const localStatePath = join(profileDir, "Local State");
  if (!existsSync(localStatePath)) {
    throw new Error(`Chrome Local State not found at ${localStatePath}`);
  }

  const localState = JSON.parse(readFileSync(localStatePath, "utf8"));
  const infoCache = localState.profile?.info_cache ?? {};
  const lastUsed = localState.profile?.last_used ?? "";

  return Object.entries(infoCache).map(([dir, info]: [string, any]) => ({
    dir,
    name: info.name ?? dir,
    email: info.user_name ?? "",
    isLastUsed: dir === lastUsed,
  }));
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

async function extractCookies(
  chromeBinary: string,
  profileDir: string,
  chromeProfileDir: string,
  domains: string[]
): Promise<any[]> {
  if (process.platform === "darwin") {
    // Single source of truth lives in the connector SDK so the connector
    // subprocess (mirror mode) and this CLI capture flow share one
    // decryption codepath. The SDK helper takes an `allowDomains` list
    // and returns Playwright-ready Cookie[]; we just pass through.
    const { decryptChromeCookiesMacOS } = await import(
      "@lobu/connector-sdk/browser-mirror"
    );
    printText(
      "macOS will ask to access your browser's cookie encryption key.\n" +
        'A system dialog from "security" will appear — click "Always Allow" to avoid future prompts.'
    );
    const result = await decryptChromeCookiesMacOS({
      userDataRoot: profileDir,
      sourceProfileDir: chromeProfileDir,
      allowDomains: domains,
    });
    return result.cookies;
  }
  return extractCookiesCDP(chromeBinary, profileDir, chromeProfileDir, domains);
}

/**
 * Linux fallback: Launch headless Chrome with a copied cookie store
 * and extract via CDP. Works on Linux where cookies aren't encrypted
 * with a per-profile key.
 */
async function extractCookiesCDP(
  chromeBinary: string,
  profileDir: string,
  chromeProfileDir: string,
  domains: string[]
): Promise<any[]> {
  const { chromium } = await import("playwright");

  const port: number = await new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, () => {
      const p = (srv.address() as any).port;
      srv.close(() => resolve(p));
    });
  });

  const tmpDir = mkdtempSync(join(tmpdir(), "lobu-auth-"));
  mkdirSync(join(tmpDir, "Default"), { recursive: true });

  const cookieSrc = join(profileDir, chromeProfileDir, "Cookies");
  const journalSrc = join(profileDir, chromeProfileDir, "Cookies-journal");

  if (!existsSync(cookieSrc)) {
    rmSync(tmpDir, { recursive: true, force: true });
    throw new Error(
      `No Cookies file found in Chrome profile: ${chromeProfileDir}`
    );
  }

  copyFileSync(cookieSrc, join(tmpDir, "Default/Cookies"));
  if (existsSync(journalSrc)) {
    copyFileSync(journalSrc, join(tmpDir, "Default/Cookies-journal"));
  }

  const chrome = spawn(
    chromeBinary,
    [
      "--headless=new",
      `--remote-debugging-port=${port}`,
      "--remote-allow-origins=*",
      `--user-data-dir=${tmpDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-sync",
      "--profile-directory=Default",
    ],
    { detached: true, stdio: "ignore" }
  );
  chrome.unref();

  try {
    for (let i = 0; i < 15; i++) {
      try {
        await new Promise<void>((resolve, reject) => {
          httpGet(`http://localhost:${port}/json/version`, (res) => {
            res.on("data", () => {
              /* drain */
            });
            res.on("end", () => resolve());
          }).on("error", reject);
        });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }

    const browser = await chromium.connectOverCDP(`http://localhost:${port}`);
    const context = browser.contexts()[0]!;
    const page = context.pages()[0] || (await context.newPage());

    const primaryDomain = domains[0]!;
    const url = primaryDomain.startsWith("http")
      ? primaryDomain
      : `https://${primaryDomain}`;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
    await page.waitForTimeout(2000);

    const cookieUrls = domains.map((d) =>
      d.startsWith("http") ? d : `https://${d}`
    );
    const cookies = await context.cookies(cookieUrls);

    await browser.close();
    return cookies;
  } finally {
    try {
      process.kill(chrome.pid!);
    } catch {
      /* ignore */
    }
    await new Promise((r) => setTimeout(r, 500));
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

function scoreAuthCookie(cookie: BrowserCookie): number {
  const name = cookie.name?.toLowerCase() ?? "";
  if (!name) return Number.NEGATIVE_INFINITY;
  if (
    /^(lang|li_theme|timezone|theme|locale|tz|visitor_id|guest_id)$/.test(name)
  ) {
    return Number.NEGATIVE_INFINITY;
  }

  let score = 0;
  if (/(auth|token|session|sess|sid|jwt)/.test(name)) score += 100;
  if (/_at$/.test(name)) score += 80;
  if (cookie.httpOnly) score += 20;
  if (cookie.secure) score += 10;
  if ((cookie.value?.length ?? 0) >= 20) score += 5;
  if ((cookie.expires ?? 0) > 0) score += 5;
  return score;
}

function findLikelyAuthCookie(cookies: BrowserCookie[]): BrowserCookie | null {
  const sorted = [...cookies].sort(
    (a, b) => scoreAuthCookie(b) - scoreAuthCookie(a)
  );
  const best = sorted[0];
  return best && scoreAuthCookie(best) > 0 ? best : null;
}

async function resolveConnectorDomains(
  connectorKey: string,
  domainsOverride: string | undefined,
  cliProfile: ProfileShim
): Promise<string[] | null> {
  if (domainsOverride) {
    return domainsOverride.split(",").map((d) => d.trim());
  }

  const { resolveMcpEndpoint, restToolCall } = await import("./mcp.js");
  const mcpUrl = await resolveMcpEndpoint(cliProfile.config);
  if (!mcpUrl) {
    printText(
      "No MCP URL configured. Use --domains to specify cookie domains manually."
    );
    return null;
  }

  const parsed = await restToolCall<any>(mcpUrl, "manage_connections", {
    action: "list_connector_definitions",
  });

  const connectors: any[] = Array.isArray(parsed)
    ? parsed
    : (parsed?.connector_definitions ?? parsed?.connectors ?? []);
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
  chromeProfile?: string;
  authProfileSlug?: string;
  launchCdp?: boolean;
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

  // --check: verify stored cookies on an auth profile
  if (args.check) {
    if (!args.authProfileSlug) {
      printText("--check requires --auth-profile-slug");
      process.exitCode = 1;
      return;
    }
    const { resolveMcpEndpoint, restToolCall } = await import("./mcp.js");
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

  const { binary, profileDir } = getChromePaths();
  if (!existsSync(binary)) {
    printText(`Chrome not found at ${binary}`);
    process.exitCode = 1;
    return;
  }

  if (args.launchCdp) {
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
      const { resolveMcpEndpoint, restToolCall } = await import("./mcp.js");
      const mcpUrl = await resolveMcpEndpoint(cliProfile.config);

      if (!mcpUrl) {
        printText(
          "No MCP URL configured. Store the CDP URL on the auth profile manually."
        );
      } else {
        try {
          const parsed = await restToolCall<any>(
            mcpUrl,
            "manage_auth_profiles",
            {
              action: "update_auth_profile",
              auth_profile_slug: args.authProfileSlug,
              auth_data: {
                cdp_url: cdpUrl,
                captured_at: new Date().toISOString(),
                captured_via: "cli",
                browser_profile: profileName,
                user_data_dir: userDataDir,
              },
            }
          );
          if (parsed?.error) {
            printText(`Error: ${parsed.error}`);
            process.exitCode = 1;
            return;
          }
          printText(`CDP URL stored on auth profile ${args.authProfileSlug}.`);
        } catch (err) {
          printText(
            `Error: ${err instanceof Error ? err.message : String(err)}`
          );
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
    return;
  }

  const profiles = listProfiles(profileDir);
  if (profiles.length === 0) {
    printText("No Chrome profiles found");
    process.exitCode = 1;
    return;
  }

  let selectedProfile: ChromeProfile;

  if (args.chromeProfile) {
    const match = profiles.find(
      (p) =>
        p.name.toLowerCase() === args.chromeProfile!.toLowerCase() ||
        p.dir.toLowerCase() === args.chromeProfile!.toLowerCase()
    );
    if (!match) {
      printText(`Profile "${args.chromeProfile}" not found. Available:`);
      for (const p of profiles) {
        printText(
          `  [${p.dir}] ${p.name} (${p.email})${p.isLastUsed ? " <- last used" : ""}`
        );
      }
      process.exitCode = 1;
      return;
    }
    selectedProfile = match;
  } else {
    printText("Chrome Profiles:");
    for (let i = 0; i < profiles.length; i++) {
      const p = profiles[i];
      if (!p) continue;
      printText(
        `  [${i + 1}] ${p.name} (${p.email})${p.isLastUsed ? " <- last used" : ""}`
      );
    }

    const readline = await import("node:readline");
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const answer = await new Promise<string>((resolve) => {
      rl.question("\nPick a profile: ", resolve);
    });
    rl.close();

    const idx = parseInt(answer, 10) - 1;
    if (Number.isNaN(idx) || idx < 0 || idx >= profiles.length) {
      printText("Invalid selection");
      process.exitCode = 1;
      return;
    }
    selectedProfile = profiles[idx]!;
  }

  printText(
    `\nUsing profile: ${selectedProfile.name} (${selectedProfile.email})`
  );
  printText("Resolving connector domains...");

  const domains = await resolveConnectorDomains(
    connectorKey,
    args.domains,
    cliProfile
  );
  if (!domains) {
    process.exitCode = 1;
    return;
  }

  printText(`Cookie domains: ${domains.join(", ")}`);
  printText("Extracting cookies...");

  const cookies = await extractCookies(
    binary,
    profileDir,
    selectedProfile.dir,
    domains
  );

  if (cookies.length === 0) {
    printText(
      "No cookies found. Are you logged into the site in this Chrome profile?"
    );
    process.exitCode = 1;
    return;
  }

  const authCookie = findLikelyAuthCookie(cookies as BrowserCookie[]);
  if (!authCookie) {
    printText(
      "Warning: No likely auth cookie found. You may not be logged in."
    );
  }

  printText(`Captured ${cookies.length} cookies`);

  if (args.authProfileSlug) {
    printText("Saving cookies to auth profile...");

    const { resolveMcpEndpoint, restToolCall } = await import("./mcp.js");
    const mcpUrl = await resolveMcpEndpoint(cliProfile.config);

    if (!mcpUrl) {
      printText("No MCP URL configured. Store cookies manually.");
    } else {
      try {
        const parsed = await restToolCall<any>(mcpUrl, "manage_auth_profiles", {
          action: "update_auth_profile",
          auth_profile_slug: args.authProfileSlug,
          auth_data: {
            cookies,
            captured_at: new Date().toISOString(),
            captured_via: "cli",
            browser_profile: selectedProfile.name,
          },
        });
        if (parsed?.error) {
          printText(`Error: ${parsed.error}`);
        } else {
          printText(`Cookies stored on auth profile ${args.authProfileSlug}.`);
        }
      } catch (err) {
        printText(`Error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } else {
    printText("\nCookies ready. To store on a browser auth profile:");
    printText(
      `  lobu memory browser-auth --connector ${connectorKey} --auth-profile-slug <SLUG> --chrome-profile "${selectedProfile.name}"`
    );
  }
}

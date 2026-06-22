// Server-side capability authorization for device workers.
//
// Devices self-report their `platform` and a list of capability strings on
// each poll (see worker-api.ts). The gateway must not trust those strings
// blindly: a compromised or buggy device could claim arbitrary capabilities
// and start matching unrelated connectors. This registry maps each known
// platform to the capabilities it is allowed to advertise. Anything outside
// the allowlist is silently dropped (the device's effective capability set
// shrinks; nothing throws).
//
// The trusted-fleet path (no `platform` on the row — those workers run with
// WORKER_API_TOKEN and the `c.var.workerAuthMode !== 'user'` branch) bypasses
// authorization entirely; we trust them by definition.

// Capability strings — keep namespaced (`browser.*`, `os.*`, `ios.*`) so the
// registry stays readable as new device kinds land.
export const BROWSER_CAPABILITIES = [
  "browser.tabs",
  "browser.scripting",
  "browser.history",
  "browser.bookmarks",
  "browser.downloads",
  "browser.debugger",
  // browser.cookies intentionally absent in v1 — high-trust, not approved
] as const;

export const OS_CAPABILITIES = [
  "os.shell",
  "os.files",
  "os.notifications",
] as const;

export const IOS_CAPABILITIES = [
  "ios.notifications",
  "ios.share-sheet",
  "ios.files",
] as const;

// Capabilities the Mac bridge advertises (lobu-ai/owletto: apps/mac/Lobu/AppState.swift).
// One entry per Mac connector that runs on-device — adding a new Mac
// connector means adding its capability string here so the gateway lets
// the device claim its runs.
export const MAC_DEVICE_CAPABILITIES = [
  "screentime",
  "local_directory",
  "healthkit",
  "photos",
  "whatsapp_local",
] as const;

const PLATFORM_ALLOWLIST: Record<string, readonly string[]> = {
  macos: [
    ...OS_CAPABILITIES,
    ...BROWSER_CAPABILITIES,
    ...MAC_DEVICE_CAPABILITIES,
  ],
  ios: IOS_CAPABILITIES,
  "chrome-extension": BROWSER_CAPABILITIES,
};

export interface CapabilityAuthorizationResult {
  authorized: string[];
  dropped: string[];
}

// Returns the subset of `declared` that the platform is allowed to advertise,
// plus the dropped tail for logging. `platform` of null/undefined/unknown is
// treated as "untrusted, unknown" and returns an empty authorized set —
// callers (worker-api.ts) gate on `workerAuthMode === 'user'` before calling
// this so trusted fleet workers never reach here.
export function authorizeCapabilities(
  platform: string | null | undefined,
  declared: readonly string[]
): CapabilityAuthorizationResult {
  const allowed = platform ? PLATFORM_ALLOWLIST[platform] : undefined;
  if (!allowed) {
    return { authorized: [], dropped: [...declared] };
  }
  const allowedSet = new Set(allowed);
  const authorized: string[] = [];
  const dropped: string[] = [];
  for (const cap of declared) {
    if (allowedSet.has(cap)) {
      authorized.push(cap);
    } else {
      dropped.push(cap);
    }
  }
  return { authorized, dropped };
}

export function isKnownPlatform(platform: string | null | undefined): boolean {
  return !!platform && platform in PLATFORM_ALLOWLIST;
}

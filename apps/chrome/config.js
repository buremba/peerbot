// Build-time-ish config for the extension. Edited at packaging time per
// channel (dev / preview / production). Service worker imports this; do not
// fetch remote config — MV3 forbids remote code, and a runtime fetch is
// indistinguishable from one to a reviewer.
//
// The gateway URL is configurable at first run — Lobu users self-host, so the
// extension can't ship with a fixed origin. DEFAULT_GATEWAY_URL is what the
// pairing screen pre-fills; the value the user confirms is persisted to
// chrome.storage.local under STORAGE_KEY_GATEWAY_URL and read by all gateway
// callers from then on.

export const DEFAULT_GATEWAY_URL = "http://localhost:8787";

export const STORAGE_KEY_GATEWAY_URL = "owletto.gatewayUrl";

export async function getGatewayUrl() {
  const stored = await chrome.storage.local.get(STORAGE_KEY_GATEWAY_URL);
  return stored[STORAGE_KEY_GATEWAY_URL] ?? null;
}

// /embedded is served by the same gateway origin — owletto-web is mounted on
// the gateway, not a separate host. So the sidepanel iframe target derives
// from whatever URL the user configured.
export async function getEmbeddedAppUrl() {
  const base = await getGatewayUrl();
  return base ? `${base.replace(/\/$/, "")}/embedded` : null;
}

export const DEFAULT_CAPABILITIES = [
  "browser.tabs",
  "browser.scripting",
  "browser.debugger",
];

export const OPTIONAL_CAPABILITIES = {
  history: "browser.history",
  bookmarks: "browser.bookmarks",
};

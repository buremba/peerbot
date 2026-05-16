// Build-time-ish config for the extension. Edited at packaging time per
// channel (dev / preview / production). Service worker imports this; do not
// fetch remote config — MV3 forbids remote code, and a runtime fetch is
// indistinguishable from one to a reviewer.

// Dev default. For preview/production builds, swap these to the real hostnames
// and update the matching entries in manifest.json's `host_permissions`.
export const GATEWAY_URL = "http://localhost:8787";

export const EMBEDDED_APP_URL = "http://localhost:8787/embedded";

export const DEFAULT_CAPABILITIES = [
  "browser.tabs",
  "browser.scripting",
  "browser.debugger",
];

export const OPTIONAL_CAPABILITIES = {
  history: "browser.history",
  bookmarks: "browser.bookmarks",
};

// MV3 service worker.
//
// Lifecycle: install → open pairing.html (OAuth device-authorization flow
// against the gateway, same as the Mac app) → on success the pairing page
// stores {workerId, accessToken, refreshToken, clientId, clientSecret?} in
// chrome.storage.local → this worker starts polling /api/workers/poll.
//
// Capabilities advertised on each poll are the intersection of
// DEFAULT_CAPABILITIES + any optional Chrome permissions the user has
// currently granted (history, bookmarks). The gateway re-authorizes the set
// against @lobu/core/capabilities, so anything that slips past here gets
// dropped server-side — but we still send a clean set.
//
// Native-messaging SSO with the Mac bridge is v2 (see SCOPE.md).

import {
  DEFAULT_CAPABILITIES,
  GATEWAY_URL,
  OPTIONAL_CAPABILITIES,
} from "./config.js";
import { installBridge } from "./bridge.js";

const STORAGE_KEYS = {
  workerId: "owletto.workerId",
  accessToken: "owletto.accessToken",
  refreshToken: "owletto.refreshToken",
  clientId: "owletto.clientId",
  clientSecret: "owletto.clientSecret",
  pairedAt: "owletto.pairedAt",
};

const POLL_INTERVAL_MS = 5_000;
let pollTimer = null;

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === "install") {
    await openPairing();
  }
});

chrome.runtime.onStartup.addListener(() => {
  void ensureConnected();
});

// Pairing happens in pairing.html, which writes the token into
// chrome.storage.local once OAuth completes. Watch for that — the service
// worker may have decided "no token, stop polling" before pairing finished,
// and without this listener it would never wake up until the next browser
// restart.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes[STORAGE_KEYS.accessToken]?.newValue) {
    startPolling();
  }
});

chrome.action.onClicked.addListener(async (tab) => {
  if (tab.windowId !== undefined) {
    await chrome.sidePanel.open({ windowId: tab.windowId });
  }
});

installBridge();

void ensureConnected();

async function ensureConnected() {
  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.workerId,
    STORAGE_KEYS.accessToken,
  ]);
  if (!stored[STORAGE_KEYS.accessToken] || !stored[STORAGE_KEYS.workerId]) {
    await openPairing();
    return;
  }
  startPolling();
}

async function openPairing() {
  await chrome.tabs.create({ url: chrome.runtime.getURL("pairing.html") });
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(pollOnce, POLL_INTERVAL_MS);
  void pollOnce();
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function pollOnce() {
  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.workerId,
    STORAGE_KEYS.accessToken,
  ]);
  const workerId = stored[STORAGE_KEYS.workerId];
  const token = stored[STORAGE_KEYS.accessToken];
  if (!workerId || !token) {
    stopPolling();
    return;
  }
  const capabilities = await computeAdvertisedCapabilities();
  try {
    const res = await fetch(`${GATEWAY_URL}/api/workers/poll`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        worker_id: workerId,
        platform: "chrome-extension",
        app_version: chrome.runtime.getManifest().version,
        capabilities,
      }),
    });
    if (res.status === 401) {
      // Token rejected. v1: drop creds and re-pair. v2: try refresh_token first.
      await chrome.storage.local.remove([
        STORAGE_KEYS.workerId,
        STORAGE_KEYS.accessToken,
        STORAGE_KEYS.refreshToken,
      ]);
      stopPolling();
      await openPairing();
      return;
    }
    // Run-claim body is consumed by the v2 run executor.
    await res.json().catch(() => null);
  } catch (err) {
    console.warn("[owletto] poll failed", err);
  }
}

async function computeAdvertisedCapabilities() {
  const caps = Object.fromEntries(DEFAULT_CAPABILITIES.map((c) => [c, true]));
  for (const [perm, cap] of Object.entries(OPTIONAL_CAPABILITIES)) {
    const granted = await chrome.permissions.contains({ permissions: [perm] });
    if (granted) caps[cap] = true;
  }
  return caps;
}

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
  OPTIONAL_CAPABILITIES,
  getGatewayUrl,
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
  const gatewayUrl = await getGatewayUrl();
  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.workerId,
    STORAGE_KEYS.accessToken,
  ]);
  // Need a gateway URL AND a token. Either missing → user goes (back) to
  // setup. pairing.html branches between the URL-setup step and the OAuth
  // step based on what's already stored.
  if (
    !gatewayUrl ||
    !stored[STORAGE_KEYS.accessToken] ||
    !stored[STORAGE_KEYS.workerId]
  ) {
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
  const gatewayUrl = await getGatewayUrl();
  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.workerId,
    STORAGE_KEYS.accessToken,
  ]);
  const workerId = stored[STORAGE_KEYS.workerId];
  const token = stored[STORAGE_KEYS.accessToken];
  if (!gatewayUrl || !workerId || !token) {
    stopPolling();
    return;
  }
  const capabilities = await computeAdvertisedCapabilities();
  try {
    const res = await fetch(`${gatewayUrl}/api/workers/poll`, {
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
    const body = await res.json().catch(() => null);
    if (body?.run_id) {
      void executeRun(body, workerId, token, gatewayUrl);
    }
  } catch (err) {
    console.warn("[owletto] poll failed", err);
  }
}

// Minimal run executor — handles the chrome.tabs connector end-to-end and
// fails any other claimed run with a clear marker so the gateway doesn't
// keep retrying us. Real-deal execution (heartbeat, multi-batch streaming,
// action runs, error classification) is in SCOPE.md's v2 backlog.
async function executeRun(run, workerId, token, gatewayUrl) {
  const { run_id, connector_key } = run;
  console.log("[owletto] claimed run", { run_id, connector_key });

  if (connector_key !== "chrome.tabs") {
    await postJson(`${gatewayUrl}/api/workers/complete`, token, {
      run_id,
      worker_id: workerId,
      status: "failed",
      error_message: `Owletto for Chrome v0.1 only handles 'chrome.tabs' runs; got '${connector_key}'`,
    });
    return;
  }

  try {
    const tabs = await chrome.tabs.query({});
    const now = new Date().toISOString();
    const items = tabs
      .filter((t) => typeof t.url === "string" && t.url.length > 0)
      .map((t) => ({
        id: `tab-${t.id}`,
        title: t.title ?? t.url,
        payload_type: "text",
        payload_text: t.title ? `${t.title}\n${t.url}` : t.url,
        occurred_at: now,
        source_url: t.url,
        origin_type: "tab_snapshot",
        semantic_type: "tab_snapshot",
        metadata: {
          source: "chrome_tabs",
          origin_id: `tab-${t.id}`,
          url: t.url,
          title: t.title,
          window_id: t.windowId,
          active: t.active,
        },
      }));

    if (items.length > 0) {
      await postJson(`${gatewayUrl}/api/workers/stream`, token, {
        type: "batch",
        run_id,
        worker_id: workerId,
        items,
      });
    }

    await postJson(`${gatewayUrl}/api/workers/complete`, token, {
      run_id,
      worker_id: workerId,
      status: "success",
      items_collected: items.length,
    });
    console.log("[owletto] completed run", { run_id, items: items.length });
  } catch (err) {
    console.error("[owletto] run failed", err);
    try {
      await postJson(`${gatewayUrl}/api/workers/complete`, token, {
        run_id,
        worker_id: workerId,
        status: "failed",
        error_message: err instanceof Error ? err.message : String(err),
      });
    } catch {}
  }
}

async function postJson(url, token, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${url} → ${res.status} ${text.slice(0, 200)}`);
  }
  return res.json().catch(() => null);
}

async function computeAdvertisedCapabilities() {
  const caps = Object.fromEntries(DEFAULT_CAPABILITIES.map((c) => [c, true]));
  for (const [perm, cap] of Object.entries(OPTIONAL_CAPABILITIES)) {
    const granted = await chrome.permissions.contains({ permissions: [perm] });
    if (granted) caps[cap] = true;
  }
  return caps;
}

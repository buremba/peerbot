// Standard RFC 8628 OAuth device-authorization flow, identical to what the
// Owletto Mac app does (apps/mac/Lobu/OAuthClient.swift +
// apps/mac/Lobu/AppState.swift:signIn). No new gateway endpoint required —
// the extension is just another OAuth public client.
//
// Before pairing can begin, the user must tell the extension where their
// Owletto gateway is hosted (no fixed origin — self-hosted product). The
// setup step at the top of this file validates the URL by hitting the
// well-known OAuth discovery doc, then requests a chrome.permissions origin
// grant for that host so subsequent fetches don't hit CORS.
//
// Pairing steps once the gateway URL is locked in:
//   1. GET  /.well-known/oauth-authorization-server  → discovery
//   2. POST <registration_endpoint>                  → dynamic client registration
//   3. POST <device_authorization_endpoint>          → device_code + user_code
//   4. Open verification_uri_complete in a tab; poll <token_endpoint> until
//      grant_type=device_code returns an access_token.
//   5. Persist {workerId, access_token, refresh_token, client_id, ...} into
//      chrome.storage.local. background.js drives the worker poll loop with
//      it from there.

import {
  DEFAULT_GATEWAY_URL,
  STORAGE_KEY_GATEWAY_URL,
  getGatewayUrl,
} from "./config.js";

const STORAGE_KEYS = {
  workerId: "owletto.workerId",
  accessToken: "owletto.accessToken",
  refreshToken: "owletto.refreshToken",
  clientId: "owletto.clientId",
  clientSecret: "owletto.clientSecret",
  pairedAt: "owletto.pairedAt",
};

// Matches apps/mac/Lobu/OAuthClient.swift:89.
const SCOPE = "device_worker:run profile:read mcp:read";

// Native-messaging host installed by the Owletto Mac app. When present, it
// short-circuits the OAuth dance by minting a child device token through
// POST /api/me/devices/mint-child-token using the Mac app's bearer.
const NATIVE_HOST = "ai.owletto.bridge";
const NATIVE_HANDSHAKE_TIMEOUT_MS = 2500;

const setup = document.getElementById("setup");
const setupStatus = document.getElementById("setup-status");
const gatewayUrlInput = document.getElementById("gateway-url");
const verifyUrlBtn = document.getElementById("verify-url");

const welcome = document.getElementById("welcome");
const serverSummary = document.getElementById("server-summary");
const codeView = document.getElementById("code-view");
const codeEl = document.getElementById("code");
const pollStatus = document.getElementById("poll-status");
const status = document.getElementById("status");
const startBtn = document.getElementById("start");
const cancelBtn = document.getElementById("cancel");
const changeServerBtn = document.getElementById("change-server");

let pollTimer = null;
let gatewayUrl = null;

verifyUrlBtn.addEventListener("click", () => {
  void verifyAndSaveGatewayUrl();
});

gatewayUrlInput.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") void verifyAndSaveGatewayUrl();
});

changeServerBtn?.addEventListener("click", () => {
  setup.hidden = false;
  welcome.hidden = true;
  setupStatus.textContent = "";
});

startBtn.addEventListener("click", () => {
  void pair().catch((err) => {
    status.textContent = err.message;
    startBtn.disabled = false;
  });
});

cancelBtn.addEventListener("click", () => {
  if (pollTimer) clearInterval(pollTimer);
  window.close();
});

void initSetupStep();

async function initSetupStep() {
  // Auto-pair via the Mac bridge when present — skips both the URL-setup
  // step and the OAuth dance.
  const auto = await tryNativeAutoPair();
  if (auto) {
    pollStatus.textContent = "Paired automatically via Owletto Mac ✓";
    welcome.hidden = true;
    codeView.hidden = false;
    codeEl.textContent = "··· auto ···";
    setTimeout(() => window.close(), 800);
    return;
  }

  const existing = await getGatewayUrl();
  gatewayUrlInput.value = existing || DEFAULT_GATEWAY_URL;
  if (existing) {
    gatewayUrl = existing;
    showWelcome();
  } else {
    setup.hidden = false;
    gatewayUrlInput.focus();
    gatewayUrlInput.select();
  }
}

// Returns true if pairing completed via the Mac bridge; false otherwise.
// Failures are silent — any "the Mac app isn't installed / isn't signed in"
// path falls back to the regular URL+OAuth flow.
async function tryNativeAutoPair() {
  let port;
  try {
    port = chrome.runtime.connectNative(NATIVE_HOST);
  } catch {
    return false;
  }
  const response = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        port.disconnect();
      } catch {}
      resolve(null);
    }, NATIVE_HANDSHAKE_TIMEOUT_MS);
    port.onMessage.addListener((msg) => {
      clearTimeout(timer);
      try {
        port.disconnect();
      } catch {}
      resolve(msg);
    });
    port.onDisconnect.addListener(() => {
      clearTimeout(timer);
      resolve(null);
    });
    try {
      port.postMessage({ op: "pair", platform: "chrome-extension" });
    } catch {
      clearTimeout(timer);
      resolve(null);
    }
  });
  if (
    !response ||
    typeof response !== "object" ||
    !response.gateway_url ||
    !response.worker_id ||
    !response.access_token
  ) {
    return false;
  }
  // Request a Chrome host-permission grant for the returned gateway origin —
  // /api/workers/poll calls from background.js need it (CORS).
  let cleanBase;
  try {
    const url = new URL(response.gateway_url);
    cleanBase = `${url.protocol}//${url.host}`;
  } catch {
    return false;
  }
  const granted = await chrome.permissions.request({
    origins: [`${cleanBase}/*`],
  });
  if (!granted) {
    return false;
  }
  const workerId = response.worker_id;
  await chrome.storage.local.set({
    [STORAGE_KEY_GATEWAY_URL]: cleanBase,
    [STORAGE_KEYS.workerId]: workerId,
    [STORAGE_KEYS.accessToken]: response.access_token,
    [STORAGE_KEYS.refreshToken]: null,
    [STORAGE_KEYS.clientId]: null,
    [STORAGE_KEYS.clientSecret]: null,
    [STORAGE_KEYS.pairedAt]: Date.now(),
  });
  return true;
}

function showWelcome() {
  setup.hidden = true;
  welcome.hidden = false;
  serverSummary.textContent = `Server: ${gatewayUrl}`;
}

async function verifyAndSaveGatewayUrl() {
  const raw = gatewayUrlInput.value.trim();
  if (!raw) {
    setupStatus.textContent = "Enter a URL.";
    return;
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    setupStatus.textContent = "That doesn't look like a valid URL.";
    return;
  }
  if (!/^https?:$/.test(url.protocol)) {
    setupStatus.textContent = "URL must use http:// or https://.";
    return;
  }
  const cleanBase = `${url.protocol}//${url.host}`;

  verifyUrlBtn.disabled = true;
  setupStatus.textContent = "Requesting permission to talk to that origin…";
  const granted = await chrome.permissions.request({
    origins: [`${cleanBase}/*`],
  });
  if (!granted) {
    setupStatus.textContent =
      "Permission declined. The extension can't talk to that server without it.";
    verifyUrlBtn.disabled = false;
    return;
  }

  setupStatus.textContent = "Checking that the server speaks Owletto…";
  let discovery;
  try {
    const res = await fetch(
      `${cleanBase}/.well-known/oauth-authorization-server`,
      { headers: { accept: "application/json" } },
    );
    if (!res.ok) throw new Error(`${cleanBase} returned ${res.status}`);
    discovery = await res.json();
  } catch (err) {
    setupStatus.textContent = `Couldn't reach an Owletto server at ${cleanBase}: ${
      err instanceof Error ? err.message : String(err)
    }`;
    verifyUrlBtn.disabled = false;
    return;
  }
  if (!discovery.device_authorization_endpoint) {
    setupStatus.textContent =
      "That server doesn't advertise device authorization — wrong URL?";
    verifyUrlBtn.disabled = false;
    return;
  }

  await chrome.storage.local.set({ [STORAGE_KEY_GATEWAY_URL]: cleanBase });
  gatewayUrl = cleanBase;
  setupStatus.textContent = "";
  verifyUrlBtn.disabled = false;
  showWelcome();
}

async function pair() {
  if (!gatewayUrl) {
    throw new Error("Owletto server URL not set.");
  }
  startBtn.disabled = true;
  status.textContent = "Discovering Owletto…";
  const discovery = await getJson(
    `${gatewayUrl}/.well-known/oauth-authorization-server`,
  );

  status.textContent = "Registering this extension…";
  const client = await postJson(discovery.registration_endpoint, {
    client_name: "Owletto for Chrome",
    software_id: "owletto-chrome",
    software_version: chrome.runtime.getManifest().version,
    grant_types: [
      "urn:ietf:params:oauth:grant-type:device_code",
      "refresh_token",
    ],
    token_endpoint_auth_method: "none",
    scope: SCOPE,
  });

  status.textContent = "Requesting code…";
  const authz = await postJson(discovery.device_authorization_endpoint, {
    client_id: client.client_id,
    scope: SCOPE,
  });

  codeEl.textContent = authz.user_code;
  welcome.hidden = true;
  codeView.hidden = false;

  if (authz.verification_uri_complete) {
    await chrome.tabs.create({ url: authz.verification_uri_complete });
  } else if (authz.verification_uri) {
    await chrome.tabs.create({ url: authz.verification_uri });
  }

  const deadline = Date.now() + (authz.expires_in ?? 600) * 1000;
  let intervalMs = Math.max((authz.interval ?? 5) * 1000, 1000);

  pollTimer = setInterval(async () => {
    if (Date.now() > deadline) {
      clearInterval(pollTimer);
      pollStatus.textContent = "Code expired. Try again.";
      return;
    }
    let response;
    try {
      response = await fetchJson(discovery.token_endpoint, {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: client.client_id,
        device_code: authz.device_code,
        ...(client.client_secret
          ? { client_secret: client.client_secret }
          : {}),
      });
    } catch (err) {
      pollStatus.textContent = `Failed: ${err.message}`;
      return;
    }
    if (response.status === "pending") {
      pollStatus.textContent = "Waiting for approval…";
      if (response.error === "slow_down") intervalMs += 5000;
      return;
    }
    if (response.status !== "ok") {
      clearInterval(pollTimer);
      pollStatus.textContent = `Failed: ${response.error ?? response.status}`;
      return;
    }

    clearInterval(pollTimer);

    const workerId =
      (await chrome.storage.local.get(STORAGE_KEYS.workerId))[
        STORAGE_KEYS.workerId
      ] ?? crypto.randomUUID();

    await chrome.storage.local.set({
      [STORAGE_KEYS.workerId]: workerId,
      [STORAGE_KEYS.accessToken]: response.tokens.access_token,
      [STORAGE_KEYS.refreshToken]: response.tokens.refresh_token ?? null,
      [STORAGE_KEYS.clientId]: client.client_id,
      [STORAGE_KEYS.clientSecret]: client.client_secret ?? null,
      [STORAGE_KEYS.pairedAt]: Date.now(),
    });
    pollStatus.textContent = "Paired ✓";
    setTimeout(() => window.close(), 800);
  }, intervalMs);
}

async function getJson(url) {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.json();
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${url} → ${res.status} ${text.slice(0, 200)}`);
  }
  return res.json();
}

// Token-endpoint poll: 200 → ok, 400 with body.error in (authorization_pending,
// slow_down) → still pending. Other non-2xx is a hard failure.
async function fetchJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.ok) return { status: "ok", tokens: data };
  if (data?.error === "authorization_pending" || data?.error === "slow_down") {
    return { status: "pending", error: data.error };
  }
  return { status: "error", error: data?.error ?? String(res.status) };
}

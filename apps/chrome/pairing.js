// Standard RFC 8628 OAuth device-authorization flow, identical to what the
// Owletto Mac app does (apps/mac/Lobu/OAuthClient.swift +
// apps/mac/Lobu/AppState.swift:signIn). No new gateway endpoint required —
// the extension is just another OAuth public client.
//
// Steps:
//   1. GET  /.well-known/oauth-authorization-server  → discovery
//   2. POST <registration_endpoint>                  → dynamic client registration
//   3. POST <device_authorization_endpoint>          → device_code + user_code
//   4. Open verification_uri_complete in a tab; poll <token_endpoint> until
//      grant_type=device_code returns an access_token.
//   5. Persist {workerId, access_token, refresh_token, client_id, ...} into
//      chrome.storage.local. background.js drives the worker poll loop with
//      it from there.

import { GATEWAY_URL } from "./config.js";

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

const welcome = document.getElementById("welcome");
const codeView = document.getElementById("code-view");
const codeEl = document.getElementById("code");
const pollStatus = document.getElementById("poll-status");
const status = document.getElementById("status");
const startBtn = document.getElementById("start");
const cancelBtn = document.getElementById("cancel");

let pollTimer = null;

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

async function pair() {
  startBtn.disabled = true;
  status.textContent = "Discovering Owletto…";
  const discovery = await getJson(
    `${GATEWAY_URL}/.well-known/oauth-authorization-server`,
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

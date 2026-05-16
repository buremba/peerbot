// Permissions management page. Each row corresponds to one optional Chrome
// permission that maps to a capability advertised on the next worker poll
// (the background service worker recomputes the capability set every cycle
// via chrome.permissions.contains, so this page doesn't need to nudge it).
//
// Revoke is supported the same way Chrome's own extension settings would —
// chrome.permissions.remove drops the permission for the duration of this
// installation.

import { STORAGE_KEY_GATEWAY_URL, getGatewayUrl } from "./config.js";

const statusEl = document.getElementById("status");

// Render the configured gateway URL.
const serverUrlDisplay = document.getElementById("server-url-display");
const changeServerBtn = document.getElementById("change-server");

async function refreshServerRow() {
  const url = await getGatewayUrl();
  serverUrlDisplay.textContent = url ?? "(not set)";
}
void refreshServerRow();

changeServerBtn.addEventListener("click", async () => {
  // Clear everything tied to the current pairing: token + URL. The pairing
  // page will then re-prompt for both.
  await chrome.storage.local.remove([
    STORAGE_KEY_GATEWAY_URL,
    "owletto.workerId",
    "owletto.accessToken",
    "owletto.refreshToken",
    "owletto.clientId",
    "owletto.clientSecret",
    "owletto.pairedAt",
  ]);
  await chrome.tabs.create({ url: chrome.runtime.getURL("pairing.html") });
  statusEl.textContent = "Stored credentials cleared. Set up the new server in the new tab.";
  await refreshServerRow();
});

const rows = Array.from(
  document.querySelectorAll(".row[data-perm]:not([data-perm='server'])"),
);

async function refreshRow(row) {
  const perm = row.dataset.perm;
  const button = row.querySelector(".toggle");
  const granted = await chrome.permissions.contains({ permissions: [perm] });
  button.dataset.granted = String(granted);
  button.textContent = granted ? "Revoke" : "Grant";
}

for (const row of rows) {
  void refreshRow(row);
  const button = row.querySelector(".toggle");
  button.addEventListener("click", async () => {
    const perm = row.dataset.perm;
    const granted = button.dataset.granted === "true";
    button.disabled = true;
    statusEl.textContent = "";
    try {
      if (granted) {
        const ok = await chrome.permissions.remove({ permissions: [perm] });
        statusEl.textContent = ok
          ? `Revoked ${perm}.`
          : `Couldn't revoke ${perm} — try removing it from chrome://extensions.`;
      } else {
        const ok = await chrome.permissions.request({ permissions: [perm] });
        statusEl.textContent = ok
          ? `Granted ${perm}. Owletto will start advertising ${row.dataset.cap} on the next poll.`
          : `Permission declined.`;
      }
    } catch (err) {
      statusEl.textContent = `Failed: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      await refreshRow(row);
      button.disabled = false;
    }
  });
}

// Keep the UI in sync if the user revokes the permission elsewhere
// (chrome://extensions) while this tab is open.
chrome.permissions.onAdded.addListener(() => {
  for (const row of rows) void refreshRow(row);
});
chrome.permissions.onRemoved.addListener(() => {
  for (const row of rows) void refreshRow(row);
});

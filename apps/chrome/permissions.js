// Permissions management page. Each row corresponds to one optional Chrome
// permission that maps to a capability advertised on the next worker poll
// (the background service worker recomputes the capability set every cycle
// via chrome.permissions.contains, so this page doesn't need to nudge it).
//
// Revoke is supported the same way Chrome's own extension settings would —
// chrome.permissions.remove drops the permission for the duration of this
// installation.

const statusEl = document.getElementById("status");

const rows = Array.from(document.querySelectorAll(".row[data-perm]"));

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

// Sidepanel shell. Either shows the gate (when unpaired) or mounts the
// owletto-web /embedded route in an iframe. A runtime port to the service
// worker proxies postMessage from the iframe — the iframe never holds an
// extension token, and the extension only acts on the named-ops protocol in
// bridge.js.

import { EMBEDDED_APP_URL } from "./config.js";

const STORAGE_KEYS = {
  workerId: "owletto.workerId",
  accessToken: "owletto.accessToken",
};
const EMBEDDED_ORIGIN = new URL(EMBEDDED_APP_URL).origin;

const gate = document.getElementById("gate");
const pairBtn = document.getElementById("pair");
const frame = document.getElementById("app");

pairBtn.addEventListener("click", async () => {
  await chrome.tabs.create({ url: chrome.runtime.getURL("pairing.html") });
});

(async () => {
  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.workerId,
    STORAGE_KEYS.accessToken,
  ]);
  if (!stored[STORAGE_KEYS.accessToken]) {
    gate.hidden = false;
    return;
  }
  // The token is *not* forwarded to the iframe — owletto-web has its own
  // session. The fragment is just an install identifier so the embedded UI
  // knows which Chrome profile context to show.
  const url = new URL(EMBEDDED_APP_URL);
  url.hash = `worker=${encodeURIComponent(stored[STORAGE_KEYS.workerId])}`;
  frame.src = url.toString();
  frame.hidden = false;
})();

// Bridge: forward iframe postMessage → runtime port. Reply: port message →
// iframe postMessage. Origin check on both ends.
const port = chrome.runtime.connect({ name: "owletto.sidepanel" });

const pending = new Map();
let nextId = 1;

window.addEventListener("message", (ev) => {
  if (ev.origin !== EMBEDDED_ORIGIN) return;
  const { id: requestedId, op, params } = ev.data ?? {};
  if (typeof op !== "string") return;
  const id = `req-${nextId++}`;
  pending.set(id, { requestedId, source: ev.source });
  port.postMessage({ id, op, params, origin: EMBEDDED_ORIGIN });
});

port.onMessage.addListener((msg) => {
  const entry = pending.get(msg.id);
  if (!entry) return;
  pending.delete(msg.id);
  entry.source?.postMessage(
    {
      id: entry.requestedId,
      ok: msg.ok,
      result: msg.result,
      error: msg.error,
    },
    EMBEDDED_ORIGIN,
  );
});

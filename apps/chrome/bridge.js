// Typed postMessage broker between the sidepanel iframe (owletto-web at
// /embedded) and the extension service worker. Pi's review called this out as
// a security boundary: the iframe is hosted code we trust today, but we
// design the protocol as if it might not be. Deny-by-default, named ops only,
// origin checks, correlation IDs. No "run script X on tab Y" RPC ever.
//
// Wire-level shape:
//   iframe → extension: { id, op: "<name>", params?: object }
//   extension → iframe: { id, ok: true, result?: object }
//                     | { id, ok: false, error: string }

import { getEmbeddedAppUrl } from "./config.js";

const ALLOWED_OPS = new Set([
  "getActiveTabContext",
  "listTabs",
  "openTab",
  "closeTab",
  "focusTab",
  "captureVisibleTab",
  "requestOptionalPermission",
]);

async function expectedEmbeddedOrigin() {
  const url = await getEmbeddedAppUrl();
  return url ? new URL(url).origin : null;
}

export function installBridge() {
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== "owletto.sidepanel") return;
    // The sidepanel forwards iframe messages over a runtime port so the
    // service worker can stay asleep until needed.
    port.onMessage.addListener(async (msg) => {
      const { id, op, params, origin } = msg ?? {};
      if (typeof id !== "string" || typeof op !== "string") {
        return; // unsigned/malformed, drop silently
      }
      const expected = await expectedEmbeddedOrigin();
      if (!expected || origin !== expected) {
        port.postMessage({ id, ok: false, error: "untrusted_origin" });
        return;
      }
      if (!ALLOWED_OPS.has(op)) {
        port.postMessage({ id, ok: false, error: "unknown_op" });
        return;
      }
      try {
        const result = await dispatch(op, params ?? {});
        port.postMessage({ id, ok: true, result });
      } catch (err) {
        port.postMessage({
          id,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });
  });
}

async function dispatch(op, params) {
  switch (op) {
    case "getActiveTabContext": {
      const [tab] = await chrome.tabs.query({
        active: true,
        lastFocusedWindow: true,
      });
      if (!tab) return null;
      return { tabId: tab.id, url: tab.url, title: tab.title };
    }
    case "listTabs": {
      const tabs = await chrome.tabs.query({});
      return tabs.map((t) => ({
        tabId: t.id,
        url: t.url,
        title: t.title,
        windowId: t.windowId,
        active: t.active,
      }));
    }
    case "openTab": {
      const tab = await chrome.tabs.create({
        url: stringOrThrow(params.url, "url"),
        active: params.active !== false,
      });
      return { tabId: tab.id };
    }
    case "closeTab": {
      await chrome.tabs.remove(numberOrThrow(params.tabId, "tabId"));
      return { closed: true };
    }
    case "focusTab": {
      const tabId = numberOrThrow(params.tabId, "tabId");
      await chrome.tabs.update(tabId, { active: true });
      return { focused: true };
    }
    case "captureVisibleTab": {
      const dataUrl = await chrome.tabs.captureVisibleTab(undefined, {
        format: "png",
      });
      return { dataUrl };
    }
    case "requestOptionalPermission": {
      const perm = stringOrThrow(params.permission, "permission");
      const granted = await chrome.permissions.request({ permissions: [perm] });
      return { granted };
    }
    default:
      throw new Error("unhandled_op");
  }
}

function stringOrThrow(v, name) {
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`missing_param:${name}`);
  }
  return v;
}

function numberOrThrow(v, name) {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new Error(`missing_param:${name}`);
  }
  return v;
}

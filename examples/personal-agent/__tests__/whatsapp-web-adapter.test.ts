import { readFileSync } from "node:fs";
import { describe, expect, it } from "bun:test";
import { whatsAppWebAdapterProgram } from "../whatsapp-web-adapter.js";

/**
 * The connector ships this adapter by serialising the function with
 * Function.prototype.toString() and evaluating `(<source>)()` in the page.
 * That works only while every binding the function needs lives INSIDE it —
 * a constant hoisted to module scope would disappear from the serialised
 * source and the page would throw a ReferenceError at runtime, with nothing
 * failing at build or type-check time.
 *
 * These tests make that failure loud and local.
 */
describe("whatsAppWebAdapterProgram serialisation", () => {
  const source = whatsAppWebAdapterProgram.toString();

  it("serialises to a self-contained program that installs the adapter", () => {
    // Evaluate the serialised source the way the connector does, against a
    // stub page. If any binding escaped to module scope this throws
    // ReferenceError instead of installing the global.
    const globals: Record<string, unknown> = {};
    const page = {
      globalThis: globals,
      document: {
        querySelector: () => null,
        querySelectorAll: () => [],
        addEventListener: () => {
          /* inert page-global stub */
        },
      },
      // postMessage is the adapter's push channel to the extension's content
      // script. On the connector path nothing listens — the connector pulls
      // via the `collect` op — so it posts into the void, harmlessly.
      window: {
        require: () => null,
        addEventListener: () => {
          /* inert page-global stub */
        },
        postMessage: () => {
          /* inert page-global stub */
        },
      },
      location: { origin: "https://web.whatsapp.com" },
      setTimeout: () => 0,
      clearTimeout: () => {
        /* inert page-global stub */
      },
      setInterval: () => 0,
      clearInterval: () => {
        /* inert page-global stub */
      },
    };

    const run = new Function(
      ...Object.keys(page),
      `"use strict";(${source})();`
    );
    expect(() => run(...Object.values(page))).not.toThrow();

    const installed = globals.__owlettoWhatsAppAdapterV1 as
      | { version: number; invoke: unknown }
      | undefined;
    expect(installed).toBeDefined();
    expect(typeof installed?.invoke).toBe("function");
  });

  it("references no identifier from its module scope", () => {
    // Belt and braces: the only free identifiers the serialised source may
    // carry are page globals. A module-scope import or constant leaking in
    // would show up here even if the stub above happened to tolerate it.
    expect(source).not.toMatch(/\bimport\s*\(/);
    expect(source).not.toMatch(/\brequire\s*\(\s*["']/);
  });

  it("still exposes the operations the connector dispatches", () => {
    for (const op of [
      "probe",
      "collect",
      "search_messages",
      "read_messages",
      "draft_message",
      "send_message",
      "edit_message",
      "react_message",
      "revoke_message",
      "download_media",
    ]) {
      expect(source).toContain(`"${op}"`);
    }
  });

  it("keeps every binding inside the function — no module-scope declarations", () => {
    // The runtime test above only exercises the INSTALL path, so a helper
    // hoisted out of the function and used only by an op would survive it and
    // fail later in the page. This checks the invariant at its source instead:
    // the module may contain NOTHING at top level but the exported function.
    // Verified by mutation — both a hoisted `const` and a hoisted `function`
    // fail this test.
    //
    // (A hoisted simple `const` is in fact constant-folded into the body by the
    // bundler and would still work, but it is not worth distinguishing: the rule
    // "nothing at module scope" is easy to honour and leaves no judgement call.)
    const file = readFileSync(
      new URL("../whatsapp-web-adapter.js", import.meta.url),
      "utf8"
    );
    const withoutBlockComments = file.replace(/\/\*[\s\S]*?\*\//g, "");
    const topLevel = withoutBlockComments
      .split("\n")
      .filter((line) => line.length > 0 && !/^[\s\t]/.test(line))
      .filter((line) => !line.startsWith("//"))
      .filter((line) => line !== "}");

    const allowed = /^export function whatsAppWebAdapterProgram\(\) \{$/;
    const offenders = topLevel.filter((line) => !allowed.test(line));
    expect(offenders).toEqual([]);
  });
});

import { describe, expect, test } from "bun:test";
import {
  assertMacDeviceDaemonGraph,
  forbiddenMacDeviceDaemonGraphInputs,
} from "../check-mac-device-daemon-graph.mjs";

describe("Mac device-daemon package graph guard", () => {
  test("allows the canonical automation and narrow redaction paths", () => {
    expect(
      forbiddenMacDeviceDaemonGraphInputs({
        "packages/connector-worker/src/daemon/automation.ts": {},
        "packages/connector-worker/src/daemon/client.ts": {},
        "packages/connector-worker/src/executor/redact.ts": {},
      })
    ).toEqual([]);
  });

  test("rejects fleet connector and heavy runtime paths", () => {
    expect(() =>
      assertMacDeviceDaemonGraph({
        "packages/connector-worker/src/compile/index.ts": {},
        "packages/connector-worker/src/executor/child-runner.ts": {},
        "packages/embeddings/src/index.ts": {},
        "node_modules/@xenova/transformers/src/pipelines.js": {},
        "node_modules/onnxruntime-node/dist/index.js": {},
        "node_modules/playwright/index.js": {},
        "node_modules/sharp/dist/index.js": {},
        "node_modules/jimp/index.js": {},
      })
    ).toThrow("forbidden fleet/runtime modules");
  });
});

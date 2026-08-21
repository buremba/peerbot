import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as os from "node:os";
import {
  loadDeviceState,
  saveDeviceState,
  workerTokenPrefix,
} from "../internal/device-state";

describe("workerTokenPrefix", () => {
  test("truncates a long token to a privacy-safe prefix", () => {
    expect(workerTokenPrefix("owl_pat_abcdefghijklmnop")).toBe("owl_pat_abcd");
  });

  test("returns null when no token is present", () => {
    expect(workerTokenPrefix(undefined)).toBeNull();
  });
});

describe("device-state cache", () => {
  let dir: string;
  afterEach(() => {
    mock.restore();
    rmSync(dir, { recursive: true, force: true });
  });

  test("round-trips a saved state and loads it back", async () => {
    dir = mkdtempSync(join(tmpdir(), "lobu-device-state-"));
    spyOn(os, "homedir").mockReturnValue(dir);

    await saveDeviceState("local", {
      workerId: "macos:myhost",
    });

    const loaded = await loadDeviceState("local");
    expect(loaded?.workerId).toBe("macos:myhost");
  });

  test("returns null when no state exists", async () => {
    dir = mkdtempSync(join(tmpdir(), "lobu-device-state-"));
    spyOn(os, "homedir").mockReturnValue(dir);

    expect(await loadDeviceState("local")).toBeNull();
  });

  test("returns null for an empty or invalid workerId", async () => {
    dir = mkdtempSync(join(tmpdir(), "lobu-device-state-"));
    spyOn(os, "homedir").mockReturnValue(dir);

    await saveDeviceState("local", {
      workerId: "macos:x",
    });
    // Corrupt the file to simulate an invalid payload.
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      join(dir, ".lobu", "devices", "local.json"),
      JSON.stringify({ workerTokenPrefix: "x" })
    );

    expect(await loadDeviceState("local")).toBeNull();
  });

  test("sanitizes the context name for the file path", async () => {
    dir = mkdtempSync(join(tmpdir(), "lobu-device-state-"));
    spyOn(os, "homedir").mockReturnValue(dir);

    await saveDeviceState("prod/api v1", {
      workerId: "macos:host",
    });

    // The context name with slashes/spaces becomes a single safe filename.
    const { readdirSync } = await import("node:fs");
    const files = readdirSync(join(dir, ".lobu", "devices"));
    expect(files).toHaveLength(1);
    expect(files[0]).not.toMatch(/[/\s]/);
  });
});

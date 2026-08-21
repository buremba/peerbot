import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
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

  test("never echoes a token it cannot truncate", () => {
    // The wizard prints this value followed by an ellipsis, so returning a
    // short token verbatim would leak the live secret under a label claiming
    // it was truncated. Anything too short to shorten is withheld entirely.
    for (const short of ["owl_pat_ab", "owl_pat_abcd", "x"]) {
      expect(workerTokenPrefix(short)).toBeNull();
    }
  });

  test("a real-length PAT keeps only a non-reconstructable stem", () => {
    const token = `owl_pat_${"a".repeat(24)}`;
    const prefix = workerTokenPrefix(token) as string;
    expect(token.startsWith(prefix)).toBe(true);
    expect(prefix.length).toBeLessThan(token.length);
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
    expect(statSync(join(dir, ".lobu", "devices")).mode & 0o777).toBe(0o700);
    expect(
      statSync(join(dir, ".lobu", "devices", "local.json")).mode & 0o777
    ).toBe(0o600);
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
    writeFileSync(
      join(dir, ".lobu", "devices", "local.json"),
      JSON.stringify({ workerTokenPrefix: "x" })
    );

    expect(await loadDeviceState("local")).toBeNull();
  });

  test("repairs a corrupt cache atomically while preserving the bad payload", async () => {
    dir = mkdtempSync(join(tmpdir(), "lobu-device-state-"));
    spyOn(os, "homedir").mockReturnValue(dir);
    const devicesDir = join(dir, ".lobu", "devices");
    mkdirSync(devicesDir, { recursive: true });
    writeFileSync(join(devicesDir, "local.json"), "not-json\n");

    const saved = await saveDeviceState("local", {
      workerId: "headless:repaired",
    });

    expect(saved.workerId).toBe("headless:repaired");
    expect((await loadDeviceState("local"))?.workerId).toBe(
      "headless:repaired"
    );
    expect(
      readdirSync(devicesDir).some((name) => name.includes(".corrupt-"))
    ).toBe(true);
  });

  test("concurrent first writes converge on one durable worker identity", async () => {
    dir = mkdtempSync(join(tmpdir(), "lobu-device-state-"));
    spyOn(os, "homedir").mockReturnValue(dir);

    const results = await Promise.all([
      saveDeviceState("local", { workerId: "headless:first" }),
      saveDeviceState("local", { workerId: "headless:second" }),
    ]);
    const loaded = await loadDeviceState("local");

    expect(results[0]?.workerId).toBe(results[1]?.workerId);
    expect(loaded?.workerId).toBe(results[0]?.workerId);
    expect(
      readdirSync(join(dir, ".lobu", "devices")).filter((name) =>
        name.endsWith(".tmp")
      )
    ).toHaveLength(0);
  });

  test("sanitizes the context name for the file path", async () => {
    dir = mkdtempSync(join(tmpdir(), "lobu-device-state-"));
    spyOn(os, "homedir").mockReturnValue(dir);

    await saveDeviceState("prod/api v1", {
      workerId: "macos:host",
    });

    // The context name with slashes/spaces becomes a single safe filename.
    const files = readdirSync(join(dir, ".lobu", "devices"));
    expect(files).toHaveLength(1);
    expect(files[0]).not.toMatch(/[/\s]/);
  });
});

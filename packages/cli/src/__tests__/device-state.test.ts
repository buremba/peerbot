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
import * as os from "node:os";
import { join } from "node:path";
import { loadDeviceState, saveDeviceState } from "../internal/device-state";

describe("device-state cache", () => {
  let home: string | undefined;

  afterEach(() => {
    mock.restore();
    if (home) rmSync(home, { recursive: true, force: true });
    home = undefined;
  });

  function useTemporaryHome(): string {
    home = mkdtempSync(join(tmpdir(), "lobu-device-state-"));
    spyOn(os, "homedir").mockReturnValue(home);
    return home;
  }

  test("round-trips owner-only state scoped to context and platform", async () => {
    const dir = useTemporaryHome();

    await saveDeviceState("local", "macos", {
      workerId: "macos:myhost",
    });

    expect(await loadDeviceState("local", "macos")).toEqual({
      workerId: "macos:myhost",
    });
    expect(await loadDeviceState("local", "headless")).toBeNull();
    expect(await loadDeviceState("prod", "macos")).toBeNull();

    const devicesDir = join(dir, ".config", "lobu", "devices");
    const [file] = readdirSync(devicesDir);
    expect(file).not.toMatch(/[/\s]/);
    expect(statSync(devicesDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(devicesDir, file as string)).mode & 0o777).toBe(0o600);
  });

  test("returns null for absent or malformed state", async () => {
    const dir = useTemporaryHome();
    const devicesDir = join(dir, ".config", "lobu", "devices");
    mkdirSync(devicesDir, { recursive: true });
    writeFileSync(join(devicesDir, "local--macos.json"), "not-json\n");

    expect(await loadDeviceState("missing", "macos")).toBeNull();
    expect(await loadDeviceState("local", "macos")).toBeNull();
    await expect(
      saveDeviceState("local", "macos", { workerId: "macos:myhost" })
    ).rejects.toThrow(/already exists or is unreadable/);
  });

  test("rejects a concurrent first setup instead of starting two daemons", async () => {
    useTemporaryHome();

    const results = await Promise.allSettled([
      saveDeviceState("local", "macos", { workerId: "macos:first" }),
      saveDeviceState("local", "macos", { workerId: "macos:second" }),
    ]);

    expect(
      results.filter((result) => result.status === "fulfilled")
    ).toHaveLength(1);
    const rejection = results.find((result) => result.status === "rejected");
    expect(String(rejection?.reason)).toContain("already exists");
    expect((await loadDeviceState("local", "macos"))?.workerId).toMatch(
      /^macos:(first|second)$/
    );
  });
});

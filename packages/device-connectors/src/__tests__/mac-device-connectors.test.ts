import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { deviceManifestHash } from "@lobu/connector-sdk";
import { validateDeviceConnectorManifests } from "../../../server/src/worker-api/device-manifests";
import {
  macDeviceConnectorDefinitions,
  macDeviceConnectorManifests,
  macDeviceConnectorRegistry,
} from "../mac.js";

const expectedOriginHashes: Record<string, string> = {
  "apple.calendar":
    "8285ad44d7a5497db19aa29bf8d39d550c592520f1961030e3e74bfd516369b8",
  "apple.computer_use":
    "de92336c43209145199c8155213d7834016b9fcbcccd19979600b0a9a98b8c60",
  "apple.health":
    "317b2acb1349f3ad26ed8dd76e71f5d035772725e7c669a7ccc00484623a87f8",
  "apple.photos":
    "75045fdb71ff2c2dc9a4580ff89820905dae8b64992352162a56ccb977d3b6a1",
  "apple.reminders":
    "d0bb3ac50eeb17568a49057f0b715b692f966aac2397205d17946eabb42e858c",
  "apple.screen_time":
    "fd814d97dd172e23712c294205b682274135fd7a3e3134b7cde4db03fa061ff9",
  "apple.system_audio":
    "d92ec48e520b4c8041754e8b0da5e0c50e79d06887cb893e3586493b7bd766bc",
  "local.directory":
    "2a4695c3d064bf6dcb89bcf935b81be0ee2c9ce56785a024b4ac844d7cf4157b",
  "os.shell":
    "4d9446e6bfb7ec6a7d2c4decfb74fe45fc683d42fa37c0e88af29e572d7621ea",
};

describe("Mac device connector registry", () => {
  test("is sorted, unique, and excludes the retired Mac WhatsApp connector", () => {
    const keys = macDeviceConnectorDefinitions.map(({ key }) => key);
    expect(keys).toEqual([...keys].sort());
    expect(new Set(keys).size).toBe(keys.length);
    expect(macDeviceConnectorRegistry["whatsapp.local"]).toBeUndefined();
    expect(keys).toEqual(Object.keys(expectedOriginHashes).sort());
  });

  test("matches the merged Owletto Mac manifests semantically", () => {
    for (const manifest of macDeviceConnectorManifests) {
      const withoutBridgeMarker = {
        ...manifest,
        runtime: { ...manifest.runtime },
      };
      delete withoutBridgeMarker.runtime.execution;
      expect(deviceManifestHash(withoutBridgeMarker)).toBe(
        expectedOriginHashes[manifest.key]
      );
      expect(manifest.runtime.platforms).toContain("macos");
      expect(manifest.auth_schema).toEqual({ methods: [{ type: "none" }] });
    }
    expect(
      macDeviceConnectorManifests.find((m) => m.key === "local.directory")
        ?.feeds_schema.files
    ).toMatchObject({
      userManaged: true,
    });
    expect(
      macDeviceConnectorManifests.find((m) => m.key === "apple.computer_use")
        ?.actions_schema
    ).toMatchObject({
      screenshot: {
        annotations: {
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
    });
  });

  test("every generated manifest is accepted by the server validator", () => {
    const result = validateDeviceConnectorManifests({
      platform: "macos",
      capabilities: macDeviceConnectorManifests.map(
        (manifest) => manifest.required_capability
      ),
      manifests: macDeviceConnectorManifests,
    });
    expect(result.accepted).toBe(true);
    expect(result.manifests).toHaveLength(macDeviceConnectorManifests.length);
  });

  test("the checked-in artifact is generated from the registry", () => {
    const artifact = JSON.parse(
      readFileSync(
        new URL(
          "../../generated/macos-device-connector-manifests.json",
          import.meta.url
        ),
        "utf8"
      )
    );
    expect(artifact).toEqual(macDeviceConnectorManifests);
  });
});

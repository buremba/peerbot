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
    "651726471a9460e3219b762019ee0e0de24e7c254c4d0a9bb65337c6dab4092e",
  "apple.computer_use":
    "de92336c43209145199c8155213d7834016b9fcbcccd19979600b0a9a98b8c60",
  "apple.health":
    "7730cc6494b352f6eca7d9c7c75c01af63af791019846b48c39c714b068a93a8",
  "apple.photos":
    "24f880e5464959e04a9e7067b78d8eca99f6ecd7efd55a8f7f32a8cd97117592",
  "apple.reminders":
    "cd2536c7227fb9961f3b0e33befd346b17fa71d41aac44e7b763fd304c71649a",
  "apple.screen_time":
    "4c0b696a51bd101b76da3a2e3444b0a87e74e0f7e8a03c2e13113e2af1c19d78",
  "apple.system_audio":
    "81e7f98165717c71ae6438b21da4de56eec1fc4478559fadba0b34681c09b378",
  "local.directory":
    "c8c30ae1f994edae5a53caa228beca07b3706c79afa4c07de2fe358be1864bcf",
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

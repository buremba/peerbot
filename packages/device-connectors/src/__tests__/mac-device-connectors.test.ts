import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { deviceManifestHash } from "@lobu/connector-sdk/device-manifest-hash";
import { validateDeviceConnectorManifests } from "../../../server/src/worker-api/device-manifests";
import {
  macDeviceConnectorDefinitions,
  macDeviceConnectorManifests,
  macDeviceConnectorRegistry,
} from "../mac.js";

const expectedOriginHashes: Record<string, string> = {
  "apple.calendar":
    "934f8866eae6b13db330ec784e9f731ac57684726fa9c8d1f57f4de07aa09adc",
  "apple.computer_use":
    "de92336c43209145199c8155213d7834016b9fcbcccd19979600b0a9a98b8c60",
  "apple.health":
    "95d01cbd942d6af5f201656e2b6ed320e3e6559723ad3f9de619b524451f70e4",
  "apple.photos":
    "0e140bd9a6d8f88fd1a750033a54b3157961c2046d0d18de08e16a9a566718e5",
  "apple.reminders":
    "ccaf18f1c403ce2ae125388a7d5a720f33a0ef656c69a2a4bde45d7b364c5de1",
  "apple.screen_time":
    "882dc20d30bfa79387b6fc88dfa0a97719823bf29ea9dacb6e53fd881198e084",
  "apple.system_audio":
    "f6c7024f9a9c82b124ece768b8a30b255de0a6d3d0e57fbf20c6044daf035766",
  "local.directory":
    "6846173d4a56d58677375f654cb10f04844b275280ec1cfb18d4d24b0fca89ee",
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

  test("apple.photos advertises only what the PhotoKit bridge populates", () => {
    const photos = macDeviceConnectorManifests.find(
      (manifest) => manifest.key === "apple.photos"
    );
    expect(photos).toBeDefined();

    const library = photos?.feeds_schema.library;
    const photoKind = library?.eventKinds?.photo;
    expect(library).toBeDefined();
    expect(photoKind).toBeDefined();

    // The Mac bridge reads PhotoKit's public API only; people, captions,
    // keywords and OCR text live in the Photos.sqlite bundle and are not
    // read today. The feed is metadata-only (`operations: ["sync"]`, no
    // action schema), so image bytes are not fetchable either. No catalog
    // string may promise any of it. The one advertised key the bridge does
    // not fill is place_name, which geo enrichment fills server-side.
    const unsupported = /people|caption|keyword|ocr|image bytes/i;
    expect(photos?.description).toContain("PhotoKit");
    expect(photos?.description).not.toMatch(unsupported);
    expect(library?.description).not.toMatch(unsupported);
    expect(photoKind?.description).not.toMatch(unsupported);

    const metadataKeys = Object.keys(
      photoKind?.metadataSchema?.properties ?? {}
    );
    expect(metadataKeys).toContain("asset_local_id");
    for (const key of metadataKeys) {
      expect(key).not.toMatch(unsupported);
    }

    expect(photos?.runtime.scopes).toEqual(["date", "location", "albums"]);
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

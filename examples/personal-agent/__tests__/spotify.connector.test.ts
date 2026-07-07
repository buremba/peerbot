import { beforeAll, describe, expect, mock, test } from "bun:test";
import { connectorSdkMock } from "./connector-sdk.mock";

// Stub @lobu/connector-sdk so the connector imports without the browser stack.
mock.module("@lobu/connector-sdk", connectorSdkMock);

let trackKey: any;

beforeAll(async () => {
  const mod = await import("../spotify.connector");
  trackKey = mod.trackKey;
});

describe("trackKey", () => {
  test("uses the catalog id when present", () => {
    expect(
      trackKey({
        id: "6rguovIe3aoqPhdpiDVOae",
        uri: "spotify:track:6rguovIe3aoqPhdpiDVOae",
      })
    ).toBe("6rguovIe3aoqPhdpiDVOae");
  });

  // Regression: local files / unavailable tracks have id === null. Keying the
  // origin_id on `track.id` directly produced `..._track_null` for ALL of them,
  // so they collided and the dedup path superseded distinct tracks down to one
  // surviving row (observed in prod: 50 distinct local tracks → 6 current rows).
  test("falls back to the uri when id is null so distinct local tracks stay distinct", () => {
    const a = trackKey({
      id: null,
      uri: "spotify:local:Artist+A:Album:Track+A:200",
    });
    const b = trackKey({
      id: null,
      uri: "spotify:local:Artist+B:Album:Track+B:240",
    });

    expect(a).toBe("spotify:local:Artist+A:Album:Track+A:200");
    expect(b).toBe("spotify:local:Artist+B:Album:Track+B:240");
    expect(a).not.toBe(b);
    // Neither collapses onto the old `null` collision key.
    expect(a).not.toBe("null");
    expect(b).not.toBe("null");
  });
});

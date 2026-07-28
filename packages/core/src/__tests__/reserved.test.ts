import { describe, expect, it } from "bun:test";
import {
  INFERENCE_ROW_KEY_PREFIX,
  isReservedEntityTypeSlug,
  isSystemEntityType,
  RESERVED_ENTITY_TYPE_SLUGS,
  RESERVED_PATHS,
  SANDBOX_PROVIDER_KEY_PREFIX,
  SANDBOX_ROW_KEY_PREFIX,
} from "../reserved";

describe("isSystemEntityType", () => {
  it("is solely the $ slug prefix", () => {
    expect(isSystemEntityType({ slug: "$member" })).toBe(true);
    expect(isSystemEntityType({ slug: "$resource" })).toBe(true);
    expect(isSystemEntityType({ slug: "channel" })).toBe(false);
    expect(isSystemEntityType({ slug: "person" })).toBe(false);
    expect(isSystemEntityType({})).toBe(false);
  });
});

describe("isReservedEntityTypeSlug", () => {
  it("blocks $ prefix and reserved names", () => {
    expect(isReservedEntityTypeSlug("$member")).toBe(true);
    expect(isReservedEntityTypeSlug("$resource")).toBe(true);
    expect(isReservedEntityTypeSlug("memory")).toBe(true);
    expect(isReservedEntityTypeSlug("person")).toBe(false);
    expect(isReservedEntityTypeSlug("channel")).toBe(false);
  });
});

describe("lists", () => {
  it("exports path and entity-type reserved sets", () => {
    expect(RESERVED_PATHS).toContain("memory");
    expect(RESERVED_PATHS).toContain("www");
    expect(RESERVED_ENTITY_TYPE_SLUGS).toContain("organization");
  });
});

describe("connector-key namespace prefixes", () => {
  it("pins the shared prefixes the SPA and URL builders depend on", () => {
    // These are a cross-repo contract: owletto re-exports them and its
    // detail-route parsers slice on them, so the values must not drift.
    expect(INFERENCE_ROW_KEY_PREFIX).toBe("inference-provider:");
    expect(SANDBOX_ROW_KEY_PREFIX).toBe("sandbox:");
    expect(SANDBOX_PROVIDER_KEY_PREFIX).toBe("sandbox-provider:");
  });
});

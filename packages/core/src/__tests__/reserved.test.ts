import { describe, expect, it } from "bun:test";
import {
  isReservedEntityTypeSlug,
  isSystemEntityType,
  RESERVED_ENTITY_TYPE_SLUGS,
  RESERVED_PATHS,
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

  it("blocks live routes missing from OWNER_ROUTE_SEGMENTS and deleted legacy segments", () => {
    // /$owner/entity-types is a live route absent from OWNER_ROUTE_SEGMENTS —
    // an entity type with that slug would get its list page permanently
    // shadowed by the static route.
    expect(isReservedEntityTypeSlug("entity-types")).toBe(true);
    // Deleted legacy routes stay reserved via REMOVED_OWNER_SEGMENTS: chat
    // history still contains their URLs (`events` is append-only), so no
    // entity type may ever claim a dead URL.
    expect(isReservedEntityTypeSlug("inference-providers")).toBe(true);
    expect(isReservedEntityTypeSlug("environments")).toBe(true);
    expect(isReservedEntityTypeSlug("infrastructure")).toBe(true);
  });
});

describe("lists", () => {
  it("exports path and entity-type reserved sets", () => {
    expect(RESERVED_PATHS).toContain("memory");
    expect(RESERVED_PATHS).toContain("www");
    expect(RESERVED_ENTITY_TYPE_SLUGS).toContain("organization");
  });
});

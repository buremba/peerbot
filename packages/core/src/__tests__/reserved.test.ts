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
});

describe("lists", () => {
  it("exports path and entity-type reserved sets", () => {
    expect(RESERVED_PATHS).toContain("memory");
    expect(RESERVED_PATHS).toContain("www");
    expect(RESERVED_ENTITY_TYPE_SLUGS).toContain("organization");
  });
});

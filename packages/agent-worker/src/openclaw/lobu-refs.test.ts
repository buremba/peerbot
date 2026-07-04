import { describe, expect, it } from "vitest";
import { buildRefContextHint, parseLobuRefs } from "./lobu-refs";

describe("parseLobuRefs", () => {
  it("parses tokens in order and skips unknown kinds", () => {
    const text =
      "check @[entity:42:Spotify](/acme/company/spotify) and @[bogus:9:X](/a) and @[connection:7:Stripe](/acme/connectors/stripe/7)";
    expect(parseLobuRefs(text)).toEqual([
      {
        kind: "entity",
        id: "42",
        label: "Spotify",
        path: "/acme/company/spotify",
      },
      {
        kind: "connection",
        id: "7",
        label: "Stripe",
        path: "/acme/connectors/stripe/7",
      },
    ]);
  });

  it("returns [] for plain text", () => {
    expect(parseLobuRefs("no refs, just an email a@b.com")).toEqual([]);
  });
});

describe("buildRefContextHint", () => {
  it("is empty when there are no refs", () => {
    expect(buildRefContextHint("hello world")).toBe("");
  });

  it("lists each referenced object with kind, label, path", () => {
    const hint = buildRefContextHint(
      "see @[entity:42:Spotify](/acme/company/spotify)"
    );
    expect(hint).toContain('entity "Spotify" → /acme/company/spotify');
    expect(hint).toContain("resolve_path");
  });

  it("surfaces a sql ref's decoded query inline, not its #sql= path", () => {
    // Encode like owletto's sqlRefPath: percent-escape the sub-delims that
    // `encodeURIComponent` leaves raw (notably `)`, which closes the token).
    const query = "SELECT id FROM events WHERE ts > now()";
    const encoded = encodeURIComponent(query).replace(
      /[()'!*~]/g,
      (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
    );
    const token = `@[sql:recent:Recent](#sql=${encoded})`;
    const hint = buildRefContextHint(`watch ${token}`);
    expect(hint).toContain(`sql "Recent": ${query}`);
    expect(hint).not.toContain("#sql=");
  });
});

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, mock, test } from "bun:test";
import { connectorSdkMock } from "./connector-sdk.mock";

// Stub @lobu/connector-sdk (it pulls in playwright) so the connector imports
// without the browser stack. Shared superset — see connector-sdk.mock.ts.
mock.module("@lobu/connector-sdk", connectorSdkMock);

let LinkedInTakeoutConnector: any;
let normalizeLinkedInSlug: any;
let LINKEDIN_IDENTITY: any;

beforeAll(async () => {
  const connectorMod = await import("../linkedin-takeout.connector");
  LinkedInTakeoutConnector = connectorMod.default;
  const identityMod = await import("../linkedin-identity");
  normalizeLinkedInSlug = identityMod.normalizeLinkedInSlug;
  LINKEDIN_IDENTITY = identityMod.LINKEDIN_IDENTITY;
});

describe("normalizeLinkedInSlug", () => {
  test("collapses protocol / www / case / trailing-slash / bare-slug variants to one slug", () => {
    const canonical = "jane-doe";
    const variants = [
      "https://www.linkedin.com/in/jane-doe/",
      "http://linkedin.com/in/jane-doe",
      "https://www.linkedin.com/in/Jane-Doe",
      "https://www.LinkedIn.com/in/Jane-Doe/?trk=contacts",
      "linkedin.com/in/jane-doe#section",
      "jane-doe",
    ];
    for (const v of variants) {
      expect(normalizeLinkedInSlug(v)).toBe(canonical);
    }
  });

  test("preserves the full alphanumeric slug (with the trailing id hash)", () => {
    expect(
      normalizeLinkedInSlug("https://www.linkedin.com/in/tolga-ozen-65b10513a")
    ).toBe("tolga-ozen-65b10513a");
  });

  test("rejects empty, non-/in/ URLs, and junk", () => {
    expect(normalizeLinkedInSlug("")).toBe(null);
    expect(normalizeLinkedInSlug("   ")).toBe(null);
    expect(normalizeLinkedInSlug(null)).toBe(null);
    expect(normalizeLinkedInSlug(undefined)).toBe(null);
    // A non-profile URL has no `/in/` segment; the whole string fails the
    // slug charset (slashes/dots are not slug chars).
    expect(normalizeLinkedInSlug("https://www.linkedin.com/company/acme")).toBe(
      null
    );
    expect(normalizeLinkedInSlug("https://example.com/profile")).toBe(null);
  });
});

describe("LinkedInTakeoutConnector identity attributions", () => {
  test("connections feed mints a person keyed on linkedin_slug + email, neither primary", () => {
    const def = new LinkedInTakeoutConnector().definition;
    const attr = def.feeds.connections.eventKinds.connection.attributions?.[0];
    expect(attr).toBeDefined();
    expect(attr.autoCreate).toBe(true);
    expect(attr.target.entityType).toBe("person");
    expect(attr.target.titlePath).toBe("author_name");

    const identities = attr.target.identities;
    const slug = identities.find(
      (i: { namespace: string }) => i.namespace === LINKEDIN_IDENTITY.SLUG
    );
    expect(slug).toMatchObject({
      namespace: "linkedin_slug",
      eventPath: "metadata.linkedin_slug",
    });
    // Equal-weight cross-channel matching: no primary until the live connector.
    expect(slug.primary).toBeUndefined();

    const email = identities.find(
      (i: { namespace: string }) => i.namespace === "email"
    );
    expect(email).toMatchObject({
      namespace: "email",
      eventPath: "metadata.email",
    });
    expect(email.primary).toBeUndefined();

    // The full URL survives only as a display trait, never as an identity.
    expect(
      identities.some(
        (i: { namespace: string }) => i.namespace === "linkedin_url"
      )
    ).toBe(false);
    expect(attr.traits.linkedin_url).toMatchObject({
      eventPath: "metadata.linkedin_url",
      behavior: "prefer_non_empty",
    });
  });

  test("messages feed attributes the sender via their profile-url slug", () => {
    const def = new LinkedInTakeoutConnector().definition;
    const attr = def.feeds.messages.eventKinds.message.attributions?.[0];
    expect(attr).toBeDefined();
    expect(attr.autoCreate).toBe(true);
    expect(attr.role).toBe("authored_by");
    expect(attr.target.identities).toEqual([
      {
        namespace: "linkedin_slug",
        eventPath: "metadata.sender_linkedin_slug",
      },
    ]);
  });

  test("a real connections row emits the metadata the slug identity resolves", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "li-takeout-"));
    writeFileSync(
      path.join(dir, "Connections.csv"),
      [
        "First Name,Last Name,URL,Email Address,Company,Position,Connected On",
        "Jane,Doe,https://www.LinkedIn.com/in/Jane-Doe/,jane@acme.com,Acme,CEO,01 Jan 2024",
      ].join("\n")
    );

    const connector = new LinkedInTakeoutConnector();
    const events = (connector as any).readConnections(dir);
    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event.origin_type).toBe("connection");
    expect(event.author_name).toBe("Jane Doe");

    // The connection attribution's identity specs point at exactly these keys.
    const attr =
      connector.definition.feeds.connections.eventKinds.connection
        .attributions[0];
    for (const identity of attr.target.identities) {
      const value = resolvePath(event, identity.eventPath);
      expect(value).toBeTruthy();
    }
    // Full URL survives as a display trait...
    expect(resolvePath(event, "metadata.linkedin_url")).toBe(
      "https://www.LinkedIn.com/in/Jane-Doe/"
    );
    expect(resolvePath(event, "metadata.email")).toBe("jane@acme.com");
    // ...but the connector emits the ALREADY-canonical slug the identity keys
    // on, since the server won't run this example connector's normalizer. The
    // case-variant URL collapses to `jane-doe` at emit time.
    const slugSpec = attr.target.identities.find(
      (i: { namespace: string }) => i.namespace === "linkedin_slug"
    );
    expect(slugSpec.eventPath).toBe("metadata.linkedin_slug");
    expect(resolvePath(event, "metadata.linkedin_slug")).toBe("jane-doe");
  });
});

function resolvePath(obj: any, dotPath: string): unknown {
  return dotPath.split(".").reduce((acc, key) => acc?.[key], obj);
}

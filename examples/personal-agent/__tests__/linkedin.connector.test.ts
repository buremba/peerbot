import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, mock, test } from "bun:test";
import { connectorSdkMock } from "./connector-sdk.mock";

// Stub @lobu/connector-sdk (it pulls in playwright) so the connector imports
// without the browser stack. Shared superset — see connector-sdk.mock.ts.
mock.module("@lobu/connector-sdk", connectorSdkMock);

let LinkedInConnector: any;
let buildHomeFeedEvents: any;
let parseHomeFeedAuthor: any;
let isHomeFeedNoise: any;
let filterPostsSinceCheckpoint: any;
let parseCompanyUpdates: any;
let normalizeLinkedInSlug: any;
let normalizeLinkedInMemberId: any;
let LINKEDIN_IDENTITY: any;

beforeAll(async () => {
  const mod = await import("../linkedin.connector");
  LinkedInConnector = mod.default;
  buildHomeFeedEvents = mod.buildHomeFeedEvents;
  parseHomeFeedAuthor = mod.parseHomeFeedAuthor;
  isHomeFeedNoise = mod.isHomeFeedNoise;
  filterPostsSinceCheckpoint = mod.filterPostsSinceCheckpoint;
  parseCompanyUpdates = mod.parseCompanyUpdates;
  const identityMod = await import("../linkedin-identity");
  normalizeLinkedInSlug = identityMod.normalizeLinkedInSlug;
  normalizeLinkedInMemberId = identityMod.normalizeLinkedInMemberId;
  LINKEDIN_IDENTITY = identityMod.LINKEDIN_IDENTITY;
});

describe("filterPostsSinceCheckpoint", () => {
  test("drops posts at or before the saved timestamp", () => {
    const posts = [
      {
        id: "103",
        text: "Newest",
        author: "OpenAI",
        likes: 3,
        comments: 1,
        shares: 0,
        publishedAt: new Date("2026-03-29T12:00:00.000Z"),
      },
      {
        id: "102",
        text: "Seen already",
        author: "OpenAI",
        likes: 2,
        comments: 0,
        shares: 0,
        publishedAt: new Date("2026-03-28T12:00:00.000Z"),
      },
      {
        id: "101",
        text: "Older",
        author: "OpenAI",
        likes: 1,
        comments: 0,
        shares: 0,
        publishedAt: new Date("2026-03-27T12:00:00.000Z"),
      },
    ];

    expect(
      filterPostsSinceCheckpoint(posts, {
        last_post_id: "102",
        last_timestamp: "2026-03-28T12:00:00.000Z",
      }).map((post: { id: string }) => post.id)
    ).toEqual(["103"]);
  });

  test("understands legacy li_post_ checkpoint ids", () => {
    const posts = [
      {
        id: "202",
        text: "Newer",
        author: "OpenAI",
        likes: 3,
        comments: 1,
        shares: 0,
        publishedAt: new Date("2026-03-29T12:00:00.000Z"),
      },
      {
        id: "201",
        text: "Checkpoint",
        author: "OpenAI",
        likes: 2,
        comments: 0,
        shares: 0,
        publishedAt: new Date("2026-03-28T12:00:00.000Z"),
      },
      {
        id: "200",
        text: "Too old",
        author: "OpenAI",
        likes: 1,
        comments: 0,
        shares: 0,
        publishedAt: new Date("2026-03-27T12:00:00.000Z"),
      },
    ];

    expect(
      filterPostsSinceCheckpoint(posts, {
        last_post_id: "li_post_201",
      }).map((post: { id: string }) => post.id)
    ).toEqual(["202"]);
  });
});

describe("buildHomeFeedEvents", () => {
  test("maps a token-id row to li_home_<token> with /feed/ source_url", () => {
    const occurredAt = new Date("2026-05-29T12:00:00.000Z");
    const events = buildHomeFeedEvents(
      [
        {
          id: "aBc123_token",
          body: "Hello from the home feed, this body is long enough",
          author: "Jane Doe",
        },
      ],
      occurredAt
    );

    expect(events).toHaveLength(1);
    const [ev] = events;
    expect(ev.origin_id).toBe("li_home_aBc123_token");
    expect(ev.payload_text).toBe(
      "Hello from the home feed, this body is long enough"
    );
    expect(ev.author_name).toBe("Jane Doe");
    expect(ev.origin_type).toBe("post");
    // Token id is NOT numeric → no urn:li:activity permalink, link to /feed/.
    expect(ev.source_url).toBe("https://www.linkedin.com/feed/");
    expect(ev.occurred_at).toBe(occurredAt);
    expect(ev.metadata).toEqual({ author: "Jane Doe" });
  });

  test("defaults author to empty string when no author and no parseable body", () => {
    // Body long enough to survive the noise filter but with no " • " marker.
    const [ev] = buildHomeFeedEvents(
      [
        {
          id: "tok",
          body: "a plain body with no author marker whatsoever here",
        },
      ],
      new Date()
    );
    expect(ev.author_name).toBe("");
    expect(ev.metadata).toEqual({ author: "" });
  });

  test("prefers row.author over body parse when the DOM selector won", () => {
    const [ev] = buildHomeFeedEvents(
      [
        {
          id: "tok",
          body: "Feed post Hugo Lu • 1st Founder at Orchestra 4h • Yesterday Snowflake popped",
          author: "DOM Author",
        },
      ],
      new Date()
    );
    expect(ev.author_name).toBe("DOM Author");
    expect(ev.metadata).toEqual({ author: "DOM Author" });
  });

  test("strips the connection-degree marker from a DOM-selector author", () => {
    const [ev] = buildHomeFeedEvents(
      [
        {
          id: "tok",
          body: "Julien Hurault 1st Julien Hurault • 1st Freelance Data Eng newsletter",
          author: "Julien Hurault • 1st",
        },
      ],
      new Date()
    );
    expect(ev.author_name).toBe("Julien Hurault");
    expect(ev.metadata).toEqual({ author: "Julien Hurault" });
  });

  test("falls back to body-parsed author when row.author is empty", () => {
    const [ev] = buildHomeFeedEvents(
      [
        {
          id: "tok",
          body: "Feed post Hugo Lu • 1st Founder at Orchestra 4h • Yesterday Snowflake popped",
          author: "   ",
        },
      ],
      new Date()
    );
    expect(ev.author_name).toBe("Hugo Lu");
    expect(ev.metadata).toEqual({ author: "Hugo Lu" });
  });

  test("drops rows without id or body and dedupes by id", () => {
    const longBody =
      "this body is definitely longer than thirty characters for the test";
    const events = buildHomeFeedEvents(
      [
        { id: "a", body: longBody },
        {
          id: "",
          body: "no id but long enough body to pass the noise filter check",
        },
        { id: "b" }, // no body
        {
          id: "a",
          body: "dup id with a sufficiently long body to pass the noise filter",
        },
      ],
      new Date()
    );
    expect(events.map((e: { origin_id: string }) => e.origin_id)).toEqual([
      "li_home_a",
    ]);
  });

  test("drops promoted, suggested, and too-short noise rows end-to-end", () => {
    const occurredAt = new Date("2026-05-29T12:00:00.000Z");
    const events = buildHomeFeedEvents(
      [
        {
          id: "keep1",
          body: "Feed post Hugo Lu • 1st Founder at Orchestra 4h • Yesterday Snowflake popped",
        },
        {
          id: "keep2",
          body: "Feed post Sabri Karagönen reposted this Hardal 17h • Follow Hardal is now integrated with Bruin",
        },
        {
          id: "ad",
          body: "Feed post Attio 52,728 followers Promoted Introducing GTM Atlas the new way to map your market",
        },
        {
          id: "sug",
          body: "Feed post Suggested Matt Graham • 2nd CEO @ RapidDev building fast",
        },
        { id: "short", body: "Load more comments" },
      ],
      occurredAt
    );
    expect(events.map((e: { origin_id: string }) => e.origin_id)).toEqual([
      "li_home_keep1",
      "li_home_keep2",
    ]);
    expect(events.map((e: { author_name: string }) => e.author_name)).toEqual([
      "Hugo Lu",
      "Hardal",
    ]);
  });
});

describe("parseHomeFeedAuthor", () => {
  test("extracts the leading name before the connection-degree marker", () => {
    expect(
      parseHomeFeedAuthor(
        "Feed post Hugo Lu • 1st Founder at Orchestra 4h • Yesterday Snowflake popped"
      )
    ).toBe("Hugo Lu");
  });

  test("handles an emoji-laden headline", () => {
    expect(
      parseHomeFeedAuthor(
        "Feed post Arpit Choudhury • 1st I am the calmest when the music is loud 🔊 1h • Today"
      )
    ).toBe("Arpit Choudhury");
  });

  test('takes the original poster after "reposted this"', () => {
    expect(
      parseHomeFeedAuthor(
        "Feed post Sabri Karagönen reposted this Hardal 17h • Follow Hardal is now integrated with Bruin"
      )
    ).toBe("Hardal");
  });

  test('returns empty string when no " • " marker is present', () => {
    expect(
      parseHomeFeedAuthor("Feed post some text with no marker at all")
    ).toBe("");
  });

  test("returns empty string for empty input", () => {
    expect(parseHomeFeedAuthor("")).toBe("");
  });

  test("caps the result to 60 chars", () => {
    const longName = "A".repeat(100);
    expect(
      parseHomeFeedAuthor(`Feed post ${longName} • 1st headline`).length
    ).toBe(60);
  });
});

describe("isHomeFeedNoise", () => {
  test("drops empty or too-short bodies", () => {
    expect(isHomeFeedNoise("")).toBe(true);
    expect(isHomeFeedNoise("Load more comments")).toBe(true);
  });

  test("drops promoted ads", () => {
    expect(
      isHomeFeedNoise(
        "Feed post Attio 52,728 followers Promoted Introducing GTM Atlas the new way to map your market"
      )
    ).toBe(true);
  });

  test("drops suggested rows", () => {
    expect(
      isHomeFeedNoise("Feed post Suggested Matt Graham • 2nd CEO @ RapidDev")
    ).toBe(true);
  });

  test("keeps a normal post", () => {
    expect(
      isHomeFeedNoise(
        "Feed post Hugo Lu • 1st Founder at Orchestra 4h • Yesterday Snowflake popped"
      )
    ).toBe(false);
  });
});

describe("LinkedInConnector home_feed", () => {
  test("declares a home_feed feed with no required company_url", () => {
    const def = new LinkedInConnector().definition;
    expect(def.feeds.home_feed).toBeDefined();
    expect(def.feeds.home_feed.configSchema.required).toBeUndefined();
  });

  test("syncHomeFeed dispatches cs_scrape and maps rows to events", async () => {
    const calls: Array<{ action: string; input: Record<string, unknown> }> = [];
    const dispatcher = {
      dispatch: async (action: string, input: Record<string, unknown>) => {
        calls.push({ action, input });
        return {
          tab_id: 1,
          cs_scrape: true,
          result: {
            loggedIn: true,
            rows: [
              {
                id: "tok1",
                body: "post one with a body long enough to pass the noise filter",
                author: "Alice",
              },
              {
                id: "tok2",
                body: "post two with a body long enough to pass the noise filter",
                author: "Bob",
              },
            ],
          },
        };
      },
    };

    const connector = new LinkedInConnector();
    const ctx = {
      feedKey: "home_feed",
      config: { max_scrolls: 4 },
      checkpoint: {},
      sessionState: { chrome_dispatcher: dispatcher },
    };
    const res = await connector.sync(ctx);

    // Dispatched a cs_scrape navigate against /feed/ with the home-feed config.
    expect(calls).toHaveLength(1);
    expect(calls[0].action).toBe("navigate");
    expect(calls[0].input.cs_scrape).toBe(true);
    expect(calls[0].input.persistent).toBe(true);
    expect(calls[0].input.url).toBe("https://www.linkedin.com/feed/");
    expect(
      (calls[0].input.scrape_config as { scroll: { max: number } }).scroll.max
    ).toBe(4);

    expect(res.events).toHaveLength(2);
    expect(res.events[0].origin_id).toBe("li_home_tok1");
    expect(res.events[1].origin_id).toBe("li_home_tok2");
    expect(res.metadata.backend).toBe("extension-cs-scrape");
  });

  test("throws a clear error when not logged into LinkedIn", async () => {
    const dispatcher = {
      dispatch: async () => ({ result: { loggedIn: false, rows: [] } }),
    };
    const connector = new LinkedInConnector();
    const ctx = {
      feedKey: "home_feed",
      config: {},
      checkpoint: {},
      sessionState: { chrome_dispatcher: dispatcher },
    };
    await expect(connector.sync(ctx)).rejects.toThrow(
      /Not logged into LinkedIn/
    );
  });
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

describe("LinkedInConnector takeout identity attributions", () => {
  test("connections feed mints a person keyed on linkedin_slug + email, neither primary", () => {
    const def = new LinkedInConnector().definition;
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
    const def = new LinkedInConnector().definition;
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

    const connector = new LinkedInConnector();
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

  test("applied_jobs feed reads the user's own job postings CSV", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "li-takeout-jobs-"));
    const connector = new LinkedInConnector();
    // readJobs is source-agnostic; the applied_jobs feedKey routes here.
    const events = (connector as any).readJobs(dir);
    expect(Array.isArray(events)).toBe(true);
    // The definition exposes the renamed feed key, not the old "jobs" takeout.
    expect(connector.definition.feeds.applied_jobs).toBeDefined();
    expect(connector.definition.feeds.applied_jobs.name).toBe("Applied Jobs");
  });
});

describe("LinkedInConnector auth schema", () => {
  test("is none-only so a takeout/extension connection needs no OAuth handshake", () => {
    const def = new LinkedInConnector().definition;
    const methods = def.authSchema.methods;
    expect(methods).toHaveLength(1);
    expect(methods[0].type).toBe("none");
    // No oauth method — the server would otherwise pick it as authoritative and
    // force a LinkedIn OAuth flow before a connection could be created, blocking
    // the takeout + extension use cases (no feed consumes an OAuth token).
    expect(methods.some((m: { type: string }) => m.type === "oauth")).toBe(
      false
    );
  });
});

describe("normalizeLinkedInMemberId", () => {
  test("reduces fsd_profile / member URNs and bare ids to the id token", () => {
    expect(normalizeLinkedInMemberId("urn:li:fsd_profile:ACoAAB1234xyz")).toBe(
      "ACoAAB1234xyz"
    );
    expect(normalizeLinkedInMemberId("urn:li:member:987654")).toBe("987654");
    expect(normalizeLinkedInMemberId("ACoAAB1234xyz")).toBe("ACoAAB1234xyz");
  });

  test("rejects empty / non-id junk", () => {
    expect(normalizeLinkedInMemberId("")).toBe(null);
    expect(normalizeLinkedInMemberId(null)).toBe(null);
    expect(normalizeLinkedInMemberId(undefined)).toBe(null);
    // A slash-bearing URL is not a bare id token.
    expect(normalizeLinkedInMemberId("https://x.com/in/foo")).toBe(null);
  });

  test("rejects a NON-person URN so a company id never becomes a person id", () => {
    // The whole point: a company actor's urn must not normalize to a person id.
    expect(normalizeLinkedInMemberId("urn:li:fsd_company:99")).toBe(null);
    expect(normalizeLinkedInMemberId("urn:li:organization:123")).toBe(null);
    // A bare colon-string that isn't a person URN is rejected too.
    expect(normalizeLinkedInMemberId("foo:bar")).toBe(null);
  });
});

describe("LinkedInConnector live post author identity (member id)", () => {
  test("parseCompanyUpdates extracts author member id + slug from the Voyager actor", () => {
    // Minimal Voyager-shaped payload: an element referencing an actor in
    // `included`, the actor carrying an fsd_profile urn + a /in/ profile URL.
    const json = {
      included: [
        {
          entityUrn: "urn:li:actor:1",
          name: { text: "Jane Doe" },
          description: { text: "CEO at Acme" },
          "*miniProfile": "urn:li:fsd_profile:ACoAABcdef123",
          navigationContext: {
            actionTarget: "https://www.linkedin.com/in/Jane-Doe/",
          },
        },
      ],
      data: {
        data: {
          feed: {
            "*elements": [
              {
                entityUrn: "urn:li:activity:7200000000000000000",
                "*commentary": null,
                commentary: { text: { text: "Hello world" } },
                "*actor": "urn:li:actor:1",
              },
            ],
          },
        },
      },
    };

    const posts = parseCompanyUpdates("", json);
    expect(posts).toHaveLength(1);
    const [post] = posts;
    expect(post.author).toBe("Jane Doe");
    expect(post.authorMemberId).toBe("ACoAABcdef123");
    // The case-variant /in/ URL collapses to the canonical slug.
    expect(post.authorSlug).toBe("jane-doe");
  });

  test("a company-authored post (no member urn) yields no member id", () => {
    const json = {
      included: [
        {
          entityUrn: "urn:li:actor:2",
          name: { text: "Acme Inc" },
          // company actor: a fsd_company urn, not fsd_profile
          "*miniProfile": "urn:li:fsd_company:99",
          navigationContext: {
            actionTarget: "https://www.linkedin.com/company/acme/",
          },
        },
      ],
      data: {
        data: {
          feed: {
            "*elements": [
              {
                entityUrn: "urn:li:activity:1",
                commentary: { text: { text: "We are hiring" } },
                "*actor": "urn:li:actor:2",
              },
            ],
          },
        },
      },
    };
    const [post] = parseCompanyUpdates("", json);
    expect(post.authorMemberId).toBeUndefined();
    // /company/ URL is not a person slug.
    expect(post.authorSlug).toBeUndefined();
  });

  test("company_updates post attribution matches member id + slug equal-weight (neither primary)", () => {
    const def = new LinkedInConnector().definition;
    const attr = def.feeds.company_updates.eventKinds.post.attributions?.[0];
    expect(attr).toBeDefined();
    expect(attr.role).toBe("authored_by");
    expect(attr.autoCreate).toBe(true);
    // NO createWhen gate: a member_id-primary mint-gate would fork the existing
    // slug-keyed takeout person. Equal-weight union binds them instead.
    expect(attr.target.createWhen).toBeUndefined();

    const memberId = attr.target.identities.find(
      (i: { namespace: string }) => i.namespace === LINKEDIN_IDENTITY.MEMBER_ID
    );
    expect(memberId).toMatchObject({
      namespace: "linkedin_member_id",
      eventPath: "metadata.author_member_id",
    });
    // CRITICAL: member_id is NOT primary — a primary that misses would mint a
    // new person and fork the takeout-first slug person.
    expect(memberId.primary).toBeUndefined();

    const slug = attr.target.identities.find(
      (i: { namespace: string }) => i.namespace === LINKEDIN_IDENTITY.SLUG
    );
    expect(slug).toMatchObject({
      namespace: "linkedin_slug",
      eventPath: "metadata.author_linkedin_slug",
    });
    expect(slug.primary).toBeUndefined();
  });

  test("parseCompanyUpdates reads the miniProfile urn as a bare string too", () => {
    // Voyager sometimes gives `miniProfile` as the urn STRING itself (not a ref
    // or an object). Codex flagged this shape as previously missed.
    const json = {
      included: [
        {
          entityUrn: "urn:li:actor:3",
          name: { text: "Bare Shape" },
          miniProfile: "urn:li:fsd_profile:ACoAABbareXYZ",
        },
      ],
      data: {
        data: {
          feed: {
            "*elements": [
              {
                entityUrn: "urn:li:activity:3",
                commentary: { text: { text: "post body" } },
                "*actor": "urn:li:actor:3",
              },
            ],
          },
        },
      },
    };
    const [post] = parseCompanyUpdates("", json);
    expect(post.authorMemberId).toBe("ACoAABbareXYZ");
  });
});

function resolvePath(obj: any, dotPath: string): unknown {
  return dotPath.split(".").reduce((acc, key) => acc?.[key], obj);
}

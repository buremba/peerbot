import { beforeAll, describe, expect, mock, test } from "bun:test";
import { connectorSdkMock } from "./connector-sdk.mock";

// Stub @lobu/connector-sdk (it pulls in playwright) so the connector imports
// without the browser stack. Shared superset — see connector-sdk.mock.ts.
mock.module("@lobu/connector-sdk", connectorSdkMock);

// biome-ignore lint/suspicious/noExplicitAny: dynamic import after mock
let LinkedInConnector: any;
// biome-ignore lint/suspicious/noExplicitAny: dynamic import after mock
let buildHomeFeedEvents: any;
// biome-ignore lint/suspicious/noExplicitAny: dynamic import after mock
let parseHomeFeedAuthor: any;
// biome-ignore lint/suspicious/noExplicitAny: dynamic import after mock
let isHomeFeedNoise: any;
// biome-ignore lint/suspicious/noExplicitAny: dynamic import after mock
let filterPostsSinceCheckpoint: any;

beforeAll(async () => {
  const mod = await import("../linkedin.connector");
  LinkedInConnector = mod.default;
  buildHomeFeedEvents = mod.buildHomeFeedEvents;
  parseHomeFeedAuthor = mod.parseHomeFeedAuthor;
  isHomeFeedNoise = mod.isHomeFeedNoise;
  filterPostsSinceCheckpoint = mod.filterPostsSinceCheckpoint;
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

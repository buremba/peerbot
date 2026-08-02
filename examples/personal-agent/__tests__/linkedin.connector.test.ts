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
let homeFeedObjectAllSupported: any;
let parseHomeFeedAuthor: any;
let isHomeFeedNoise: any;
let filterPostsSinceCheckpoint: any;
let parseCompanyUpdates: any;
let normalizeLinkedInSlug: any;
let normalizeLinkedInMemberId: any;
let LINKEDIN_IDENTITY: any;
let normalizeLinkedInPostUrl: any;
let isLinkedInAuthWall: any;
let pickCommentButtonRef: any;
let pickCommentTextboxRef: any;
let isCommentSubmitLabel: any;
let isCommentOpenLabel: any;
let prepareLinkedInComment: any;
let buildFillCommentExpression: any;
let buildInjectHandoffBannerExpression: any;
let truncateHandoffReason: any;
let normalizeCommentMatchText: any;
let commentBodiesMatch: any;
let buildScrapeCommentsExpression: any;
let verifyLinkedInStagedComment: any;

beforeAll(async () => {
  const mod = await import("../linkedin.connector");
  LinkedInConnector = mod.default;
  buildHomeFeedEvents = mod.buildHomeFeedEvents;
  homeFeedObjectAllSupported = mod.homeFeedObjectAllSupported;
  parseHomeFeedAuthor = mod.parseHomeFeedAuthor;
  isHomeFeedNoise = mod.isHomeFeedNoise;
  filterPostsSinceCheckpoint = mod.filterPostsSinceCheckpoint;
  parseCompanyUpdates = mod.parseCompanyUpdates;
  normalizeLinkedInPostUrl = mod.normalizeLinkedInPostUrl;
  isLinkedInAuthWall = mod.isLinkedInAuthWall;
  pickCommentButtonRef = mod.pickCommentButtonRef;
  pickCommentTextboxRef = mod.pickCommentTextboxRef;
  isCommentSubmitLabel = mod.isCommentSubmitLabel;
  isCommentOpenLabel = mod.isCommentOpenLabel;
  prepareLinkedInComment = mod.prepareLinkedInComment;
  buildFillCommentExpression = mod.buildFillCommentExpression;
  buildInjectHandoffBannerExpression = mod.buildInjectHandoffBannerExpression;
  truncateHandoffReason = mod.truncateHandoffReason;
  normalizeCommentMatchText = mod.normalizeCommentMatchText;
  commentBodiesMatch = mod.commentBodiesMatch;
  buildScrapeCommentsExpression = mod.buildScrapeCommentsExpression;
  verifyLinkedInStagedComment = mod.verifyLinkedInStagedComment;
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
  test("uses the scraped post permalink when LinkedIn exposes one", () => {
    const [event] = buildHomeFeedEvents(
      [
        {
          id: "opaque_component_key",
          body: "Feed post Ada Lovelace • 1st A durable agents post with enough body text",
          author: "Ada Lovelace",
          post_url:
            "/feed/update/urn:li:activity:7345678901234567890?utm_source=feed",
        },
      ],
      new Date("2026-08-01T12:00:00.000Z")
    );

    expect(event.source_url).toBe(
      "https://www.linkedin.com/feed/update/urn:li:activity:7345678901234567890"
    );
  });

  test("builds a permalink from the share id embedded in current feed cards", () => {
    const [event] = buildHomeFeedEvents(
      [
        {
          id: "opaque_component_key",
          body: "Feed post Ada Lovelace • 1st A durable agents post with enough body text",
          author: "Ada Lovelace",
          post_identity:
            "translatable-commentary-ContentUrnShareUrn(shareUrn=ShareUrn(shareId=7485276857911828480))",
        },
      ],
      new Date("2026-08-01T12:00:00.000Z")
    );

    // A shareId is not an activity id; keep the source URN namespace.
    expect(event.source_url).toBe(
      "https://www.linkedin.com/feed/update/urn:li:share:7485276857911828480"
    );
  });

  test("keeps the ugcPost namespace for ugcPostId feed cards", () => {
    const [event] = buildHomeFeedEvents(
      [
        {
          id: "opaque_component_key",
          body: "Feed post Ada Lovelace • 1st A durable agents post with enough body text",
          author: "Ada Lovelace",
          post_identity: "urn:li:ugcPost:7485276857911828481",
        },
      ],
      new Date("2026-08-01T12:00:00.000Z")
    );

    expect(event.source_url).toBe(
      "https://www.linkedin.com/feed/update/urn:li:ugcPost:7485276857911828481"
    );
  });

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

  test("uses the post author when the DOM selector finds the reacting member", () => {
    const [ev] = buildHomeFeedEvents(
      [
        {
          id: "tok",
          body: "Feed post Deb Mukherjee likes this 🦔 james hawkins • 2nd self driving software and co-ceo at posthog 8h • Connect",
          author: "Deb Mukherjee",
        },
      ],
      new Date()
    );
    // Leading emoji decoration on the actor name is stripped for a clean title.
    expect(ev.author_name).toBe("james hawkins");
    // No profile href on this row → engagement is named but not identified.
    expect(ev.metadata).toEqual({
      author: "james hawkins",
      social_actor: "Deb Mukherjee",
      social_action: "like",
    });
  });

  test("strips Visit website CTA fused into the author after a repost banner", () => {
    // Production body: company page CTA text sits next to the original author.
    const [ev] = buildHomeFeedEvents(
      [
        {
          id: "tok",
          body: "Feed post Emir Karabeg reposted this Sim Visit website 2h • Follow Sim Retreat Malibu ‘26 11 2 2",
          links: [
            {
              href: "https://www.linkedin.com/in/emirkarabeg/",
              name: "View Emir Karabeg’s profile",
            },
          ],
        },
      ],
      new Date()
    );
    expect(ev.author_name).toBe("Sim");
    expect(ev.metadata).toMatchObject({
      author: "Sim",
      social_actor: "Emir Karabeg",
      social_action: "repost",
      social_actor_slug: "emirkarabeg",
    });
  });

  test("matches emoji-prefixed DOM engager to banner actor (keeps engagement attribution)", () => {
    // DOM text often keeps the leading emoji; banner parse strips it. Without
    // normalizing both sides, the banner is discarded and the engager is
    // mis-emitted as the post author with their slug.
    const [ev] = buildHomeFeedEvents(
      [
        {
          id: "tok",
          body: "Feed post Deb Mukherjee likes this 🦔 james hawkins • 2nd self driving 8h • Connect",
          author: "🦔 Deb Mukherjee",
          author_control_label: "Open control menu for post by james hawkins",
          links: [
            {
              href: "https://www.linkedin.com/in/debgotwired/",
              name: "View Deb Mukherjee’s profile",
            },
            {
              href: "https://www.linkedin.com/in/jameshawkins/",
              name: "View james hawkins’s profile",
            },
          ],
        },
      ],
      new Date()
    );
    expect(ev.author_name).toBe("james hawkins");
    expect(ev.metadata).toMatchObject({
      author: "james hawkins",
      social_actor: "Deb Mukherjee",
      social_action: "like",
      social_actor_slug: "debgotwired",
      author_linkedin_slug: "jameshawkins",
    });
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

  test("resolves the author slug by matching the control-menu label on a plain card", () => {
    const [ev] = buildHomeFeedEvents(
      [
        {
          id: "tok",
          body: "Feed post Maria Malykh • 1st Founder & CTO | Automating R&D Tax 3h • I'm not an early planner",
          author_control_label: "Open control menu for post by Maria Malykh",
          links: [
            {
              href: "https://www.linkedin.com/in/maria-malykh-ilyina/?miniProfileUrn=abc",
              name: "View Maria Malykh’s profile",
            },
          ],
        },
      ],
      new Date()
    );
    expect(ev.author_name).toBe("Maria Malykh");
    expect(ev.metadata).toEqual({
      author: "Maria Malykh",
      author_linkedin_slug: "maria-malykh-ilyina",
      author_profile_url: "https://www.linkedin.com/in/maria-malykh-ilyina",
    });
  });

  test("uses the control-menu author when the body header is stale", () => {
    const [ev] = buildHomeFeedEvents(
      [
        {
          id: "tok",
          body: "Feed post Stale Header • 2nd Founder 3h • Current post body",
          author_control_label: "Open control menu for post by Current Author",
          links: [
            {
              href: "https://www.linkedin.com/in/current-author/",
              name: "View Current Author’s profile",
            },
          ],
        },
      ],
      new Date()
    );
    expect(ev.author_name).toBe("Current Author");
    expect(ev.metadata).toMatchObject({
      author: "Current Author",
      author_linkedin_slug: "current-author",
    });
  });

  test("attributes engager and author by name on a social-context card", () => {
    // The engager is named by the banner, the author by the control-menu label.
    // Each resolves to its own link by name — order-independent.
    const [ev] = buildHomeFeedEvents(
      [
        {
          id: "tok",
          body: "Feed post Deb Mukherjee likes this Adam Robinson • 2nd CEO @ MoltSets 8h • Connect unlimited contact data",
          author_control_label: "Open control menu for post by Adam Robinson",
          links: [
            {
              href: "https://www.linkedin.com/in/debgotwired/",
              name: "View Deb Mukherjee’s profile",
            },
            {
              href: "https://www.linkedin.com/in/adam-robinson/",
              name: "View Adam Robinson’s profile",
            },
          ],
        },
      ],
      new Date()
    );
    expect(ev.metadata).toEqual({
      author: "Adam Robinson",
      social_actor: "Deb Mukherjee",
      social_action: "like",
      social_actor_slug: "debgotwired",
      social_actor_profile_url: "https://www.linkedin.com/in/debgotwired",
      author_linkedin_slug: "adam-robinson",
      author_profile_url: "https://www.linkedin.com/in/adam-robinson",
    });
  });

  test("keeps engagement attribution when the author link comes first", () => {
    const [ev] = buildHomeFeedEvents(
      [
        {
          id: "tok",
          body: "Feed post Deb Mukherjee likes this Adam Robinson • 2nd CEO 8h • Connect",
          author: "Adam Robinson",
          author_control_label: "Open control menu for post by Adam Robinson",
          links: [
            {
              href: "https://www.linkedin.com/in/adam-robinson/",
              name: "View Adam Robinson’s profile",
            },
            {
              href: "https://www.linkedin.com/in/debgotwired/",
              name: "View Deb Mukherjee’s profile",
            },
          ],
        },
      ],
      new Date()
    );
    expect(ev.metadata).toMatchObject({
      author_linkedin_slug: "adam-robinson",
      social_actor: "Deb Mukherjee",
      social_actor_slug: "debgotwired",
    });
  });

  test("ignores post-body mention links when resolving the author", () => {
    // A mention link the author didn't write must never be picked as the author.
    // Only the link whose accessible name matches the control-menu author wins.
    const [ev] = buildHomeFeedEvents(
      [
        {
          id: "tok",
          body: "Feed post Adam Robinson • 2nd CEO 8h • Connect shoutout to a friend",
          author_control_label: "Open control menu for post by Adam Robinson",
          links: [
            {
              href: "https://www.linkedin.com/in/adam-robinson/",
              name: "View Adam Robinson’s profile",
            },
            {
              href: "https://www.linkedin.com/in/some-mention/",
              name: "View Some Mention’s profile",
            },
          ],
        },
      ],
      new Date()
    );
    expect(ev.metadata).toMatchObject({
      author_linkedin_slug: "adam-robinson",
    });
    expect(ev.metadata).not.toHaveProperty("social_actor_slug");
  });

  test("gives a company author no person slug even with a person mention present", () => {
    // The control-menu author is a company (no /in/ link); a person mention in
    // the post must not be promoted to author.
    const [ev] = buildHomeFeedEvents(
      [
        {
          id: "tok",
          body: "Feed post Deb Mukherjee likes this MoltSets 8h • Follow",
          author_control_label: "Open control menu for post by MoltSets",
          links: [
            {
              href: "https://www.linkedin.com/in/debgotwired/",
              name: "View Deb Mukherjee’s profile",
            },
            {
              href: "https://www.linkedin.com/company/moltsets/",
              name: "View company: MoltSets",
            },
            {
              href: "https://www.linkedin.com/in/some-mention/",
              name: "View Some Mention’s profile",
            },
          ],
        },
      ],
      new Date()
    );
    expect(ev.metadata).toEqual({
      author: "MoltSets",
      social_actor: "Deb Mukherjee",
      social_action: "like",
      social_actor_slug: "debgotwired",
      social_actor_profile_url: "https://www.linkedin.com/in/debgotwired",
    });
  });

  test("does not promote a same-named person mention over a company author", () => {
    // Name collision: the author is the company "Adam" and a person mention is
    // also named "Adam". Matching by name alone would wrongly attribute the
    // person; a company anchor sharing the name must block person attribution.
    const [ev] = buildHomeFeedEvents(
      [
        {
          id: "tok",
          body: "Feed post Adam • 2nd Company update mentioning a same-named person here",
          author_control_label: "Open control menu for post by Adam",
          links: [
            {
              href: "https://www.linkedin.com/company/adam/",
              name: "View company: Adam",
            },
            {
              href: "https://www.linkedin.com/in/adam-person/",
              name: "View Adam’s profile",
            },
          ],
        },
      ],
      new Date()
    );
    expect(ev.metadata).not.toHaveProperty("author_linkedin_slug");
  });

  test("does not attribute when two distinct members share the author's name", () => {
    // Two different "Jane Doe" profiles match the name — ambiguous, so neither
    // is attributed rather than guessing one.
    const [ev] = buildHomeFeedEvents(
      [
        {
          id: "tok",
          body: "Feed post Jane Doe • 2nd Founder posting something long enough to keep",
          author_control_label: "Open control menu for post by Jane Doe",
          links: [
            {
              href: "https://www.linkedin.com/in/jane-doe-1/",
              name: "View Jane Doe’s profile",
            },
            {
              href: "https://www.linkedin.com/in/jane-doe-2/",
              name: "View Jane Doe’s profile",
            },
          ],
        },
      ],
      new Date()
    );
    expect(ev.metadata).not.toHaveProperty("author_linkedin_slug");
  });

  test("ignores a malformed non-array links field", () => {
    // A stale/garbled field must yield no slugs rather than crashing or minting
    // garbage — normalizeHomeFeedLinks accepts only a real array.
    const [ev] = buildHomeFeedEvents(
      [
        {
          id: "tok",
          body: "Feed post Adam Robinson • 2nd CEO 8h • Connect",
          author_control_label: "Open control menu for post by Adam Robinson",
          links: "Adam Robinson" as unknown as never,
        },
      ],
      new Date()
    );
    expect(ev.metadata).not.toHaveProperty("author_linkedin_slug");
    expect(ev.metadata).not.toHaveProperty("author_profile_url");
  });

  // Fixtures recorded from the live linkedin.com/feed/ DOM on 2026-07-22 via
  // the paired Owletto extension. They pin three observed shapes: an
  // actor-less "Recommended for you" banner, an engagement card whose author is
  // a COMPANY, and a promoted "follow this Page" card whose leading links belong
  // to followers, not the author.
  test("live DOM: actor-less banner author resolves by control label", () => {
    const [ev] = buildHomeFeedEvents(
      [
        {
          id: "r1",
          body: "Feed post Recommended for you Victor Baron • 2nd Founder & CEO at Ampere All-In-One Financial Service For Businesses | Building First-world App Busine",
          author_control_label: "Open control menu for post by Victor Baron",
          links: [
            {
              href: "https://www.linkedin.com/in/victor-baron/",
              name: "View Victor Baron’s profile",
            },
            {
              href: "https://www.linkedin.com/company/openai/",
              name: "View company: OpenAI",
            },
            {
              href: "https://www.linkedin.com/company/google/",
              name: "View company: Google",
            },
          ],
        },
      ],
      new Date()
    );
    expect(ev.author_name).toBe("Victor Baron");
    expect(ev.metadata).toEqual({
      author: "Victor Baron",
      author_linkedin_slug: "victor-baron",
      author_profile_url: "https://www.linkedin.com/in/victor-baron",
    });
  });

  test("live DOM: engagement card with a company author gives the author no person slug", () => {
    const [ev] = buildHomeFeedEvents(
      [
        {
          id: "r5",
          body: "Feed post Onur Demirtaş likes this Swipeline TR 13h • Follow Twitter'ın kurucu ortağı ve Block'un CEO'su Jack Dorsey, X hesabından paylaştığı gönderiy",
          author_control_label: "Open control menu for post by Swipeline TR",
          links: [
            {
              href: "https://www.linkedin.com/in/onurdmrts/",
              name: "View Onur Demirtaş’s profile",
            },
            {
              href: "https://www.linkedin.com/company/swipelinetr/posts/",
              name: "View company: Swipeline TR",
            },
          ],
        },
      ],
      new Date()
    );
    expect(ev.author_name).toBe("Swipeline TR");
    expect(ev.metadata).toEqual({
      author: "Swipeline TR",
      social_actor: "Onur Demirtaş",
      social_action: "like",
      social_actor_slug: "onurdmrts",
      social_actor_profile_url: "https://www.linkedin.com/in/onurdmrts",
    });
  });

  test("live DOM: a 'follow this Page' promoted card is dropped as noise", () => {
    // The leading links belong to connections who follow the page, NOT the
    // author (CodeRabbit). It is filtered before routing; this pins that.
    const events = buildHomeFeedEvents(
      [
        {
          id: "r3",
          body: "Feed post Gorkem Cetin, Matthew Gregory and 22 other connections follow this Page CodeRabbit 36,825 followers Promoted Build vs. Buy: What does an AI ",
          author_control_label: "Open control menu for post by CodeRabbit",
          links: [
            {
              href: "https://www.linkedin.com/in/gorkemcetin/",
              name: "Gorkem Cetin",
            },
            {
              href: "https://www.linkedin.com/in/matthewgregory/",
              name: "Matthew Gregory",
            },
            {
              href: "https://www.linkedin.com/company/coderabbitai/posts/",
              name: "View company: CodeRabbit",
            },
          ],
        },
      ],
      new Date()
    );
    expect(events).toHaveLength(0);
  });

  test("keeps both roles when the same member authors and engages", () => {
    const [ev] = buildHomeFeedEvents(
      [
        {
          id: "tok",
          body: "Feed post Adam Robinson reposted this Adam Robinson • 2nd CEO 8h • Connect",
          author_control_label: "Open control menu for post by Adam Robinson",
          links: [
            {
              href: "https://www.linkedin.com/in/adam-robinson/",
              name: "View Adam Robinson’s profile",
            },
          ],
        },
      ],
      new Date()
    );
    expect(ev.metadata).toMatchObject({
      social_actor: "Adam Robinson",
      social_actor_slug: "adam-robinson",
      author_linkedin_slug: "adam-robinson",
    });
  });

  test("omits the author slug when a social card exposes only the engager link", () => {
    const [ev] = buildHomeFeedEvents(
      [
        {
          id: "tok",
          body: "Feed post Deb Mukherjee likes this Adam Robinson • 2nd CEO 8h • Connect",
          author_control_label: "Open control menu for post by Adam Robinson",
          links: [
            {
              href: "https://www.linkedin.com/in/debgotwired/",
              name: "View Deb Mukherjee’s profile",
            },
          ],
        },
      ],
      new Date()
    );
    // Only the engager exposes a link; the author is named but not linked.
    expect(ev.metadata).toMatchObject({ social_actor_slug: "debgotwired" });
    expect(ev.metadata).not.toHaveProperty("author_linkedin_slug");
  });

  test("preserves a comma suffix in the engager's display name", () => {
    const [ev] = buildHomeFeedEvents(
      [
        {
          id: "tok",
          body: "Feed post John Smith, MBA likes this Alice Jones • 2nd Founder 2h • Follow",
          author: "John Smith, MBA",
          author_control_label: "Open control menu for post by Alice Jones",
          links: [
            {
              href: "https://www.linkedin.com/in/john-smith/",
              name: "View John Smith, MBA’s profile",
            },
          ],
        },
      ],
      new Date()
    );
    expect(ev.metadata).toMatchObject({
      author: "Alice Jones",
      social_actor: "John Smith, MBA",
      social_actor_slug: "john-smith",
    });
  });

  test("does not treat an action phrase in the DOM author's name as a banner", () => {
    const [ev] = buildHomeFeedEvents(
      [
        {
          id: "tok",
          body: "Feed post We Love This Company • 2nd Community 2h • Follow",
          author: "We Love This Company",
          author_control_label:
            "Open control menu for post by We Love This Company",
          links: [
            {
              href: "https://www.linkedin.com/in/we-love-this-company/",
              name: "View We Love This Company’s profile",
            },
          ],
        },
      ],
      new Date()
    );
    expect(ev.author_name).toBe("We Love This Company");
    expect(ev.metadata).toEqual({
      author: "We Love This Company",
      author_linkedin_slug: "we-love-this-company",
      author_profile_url: "https://www.linkedin.com/in/we-love-this-company",
    });
  });

  test("captures comment and repost engagement actions", () => {
    const events = buildHomeFeedEvents(
      [
        {
          id: "c",
          body: "Feed post Barry McCardel commented Caroline Haynes • 2nd GTM at Hex 20h • Follow After an incredible year",
          links: [
            {
              href: "https://www.linkedin.com/in/barrymccardel/",
              name: "View Barry McCardel’s profile",
            },
          ],
        },
        {
          id: "r",
          body: "Feed post Sabri Karagönen reposted this Hardal 17h • Follow Hardal is now integrated with Bruin",
          links: [
            {
              href: "https://www.linkedin.com/in/sabrikaragonen/",
              name: "View Sabri Karagönen’s profile",
            },
          ],
        },
      ],
      new Date()
    );
    expect(events[0].metadata).toMatchObject({
      author: "Caroline Haynes",
      social_actor: "Barry McCardel",
      social_action: "comment",
      social_actor_slug: "barrymccardel",
    });
    expect(events[1].metadata).toMatchObject({
      author: "Hardal",
      social_actor: "Sabri Karagönen",
      social_action: "repost",
      social_actor_slug: "sabrikaragonen",
    });
  });

  test('keeps only the first engager name on an "and N others" banner', () => {
    const [ev] = buildHomeFeedEvents(
      [
        {
          id: "tok",
          body: "Feed post Ali Veli and 3 others like this Ayşe Yılmaz • 2nd Data engineer 4h • Connect",
          links: [
            {
              href: "https://www.linkedin.com/in/aliveli/",
              name: "View Ali Veli’s profile",
            },
          ],
        },
      ],
      new Date()
    );
    expect(ev.metadata).toMatchObject({
      author: "Ayşe Yılmaz",
      social_actor: "Ali Veli",
      social_action: "like",
      social_actor_slug: "aliveli",
    });
  });

  test("attributes the href to the author on an actor-less banner card", () => {
    // "Voices worth following" / "Recommended for you" have no engager; the
    // author resolves by the control-menu label.
    const [ev] = buildHomeFeedEvents(
      [
        {
          id: "tok",
          body: "Feed post Voices worth following Elizabeth Reid • 2nd VP, Search 13h • Follow Bonjour France!",
          author_control_label: "Open control menu for post by Elizabeth Reid",
          links: [
            {
              href: "https://www.linkedin.com/in/elizabeth-reid-56356724/",
              name: "View Elizabeth Reid’s profile",
            },
          ],
        },
      ],
      new Date()
    );
    expect(ev.author_name).toBe("Elizabeth Reid");
    expect(ev.metadata).toEqual({
      author: "Elizabeth Reid",
      author_linkedin_slug: "elizabeth-reid-56356724",
      author_profile_url: "https://www.linkedin.com/in/elizabeth-reid-56356724",
    });
  });

  test("emits no slug fields when the row has no profile href", () => {
    const [ev] = buildHomeFeedEvents(
      [
        {
          id: "tok",
          body: "Feed post Hugo Lu • 1st Founder at Orchestra 4h • Yesterday Snowflake popped",
        },
      ],
      new Date()
    );
    expect(ev.metadata).toEqual({ author: "Hugo Lu" });
  });

  test("does not attribute a later person link to a company author", () => {
    const [ev] = buildHomeFeedEvents(
      [
        {
          id: "tok",
          body: "Feed post Acme Corp • 3rd+ Company update with a tagged member",
          author: "Acme Corp",
          author_control_label: "Open control menu for post by Acme Corp",
          links: [
            {
              href: "https://www.linkedin.com/company/acme/",
              name: "View company: Acme Corp",
            },
            {
              href: "https://www.linkedin.com/in/tagged-member/",
              name: "View Tagged Member’s profile",
            },
          ],
        },
      ],
      new Date()
    );
    expect(ev.metadata).toEqual({ author: "Acme Corp" });
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

describe("homeFeedObjectAllSupported", () => {
  test("true when a row returns links as an array", () => {
    expect(
      homeFeedObjectAllSupported([
        { id: "a", links: [{ href: "/in/x", name: "View X’s profile" }] },
      ])
    ).toBe(true);
  });

  test("false when the extension returns links as a string (no objectAll)", () => {
    // An older extension ignores the take and returns the field as plain text.
    expect(
      homeFeedObjectAllSupported([
        { id: "a", links: "some card text" as unknown as never },
      ])
    ).toBe(false);
  });

  test("assumes supported when no row carries a links field", () => {
    // A batch of link-less cards is not evidence of a stale extension.
    expect(homeFeedObjectAllSupported([{ id: "a" }, { id: "b" }])).toBe(true);
  });

  test("true if any row is an array even when others are link-less", () => {
    expect(
      homeFeedObjectAllSupported([{ id: "a" }, { id: "b", links: [] }])
    ).toBe(true);
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

  test('strips a "likes this" social-context banner before the author', () => {
    expect(
      parseHomeFeedAuthor(
        "Feed post Deb Mukherjee likes this 🦔 james hawkins • 2nd self driving software and co-ceo at posthog 8h • Connect this is what happens"
      )
    ).toBe("james hawkins");
    expect(
      parseHomeFeedAuthor(
        "Feed post Onur Demirtaş likes this Erkan Ayan • 2nd erkanayan.net 8h • Connect 📍 something"
      )
    ).toBe("Erkan Ayan");
  });

  test('strips a "commented" social-context banner before the author', () => {
    expect(
      parseHomeFeedAuthor(
        "Feed post Barry McCardel commented Caroline Haynes • 2nd GTM at Hex 20h • Follow After an incredible run"
      )
    ).toBe("Caroline Haynes");
    expect(
      parseHomeFeedAuthor(
        "Feed post Joseph Jacks commented Roelof Botha • 3rd+ Investor 3h • Follow I am hiring"
      )
    ).toBe("Roelof Botha");
  });

  test('strips a "finds this insightful" banner before the author', () => {
    expect(
      parseHomeFeedAuthor(
        "Feed post Arpit Choudhury finds this insightful Paul Walsh • 2nd Online safety & security 5h • Follow"
      )
    ).toBe("Paul Walsh");
  });

  test('strips a plural "and N others like this" banner before the author', () => {
    expect(
      parseHomeFeedAuthor(
        "Feed post Ali Veli and 3 others like this Ayşe Yılmaz • 2nd Data engineer 4h • Connect"
      )
    ).toBe("Ayşe Yılmaz");
  });

  test('strips a "Recommended for you" banner before the author', () => {
    expect(
      parseHomeFeedAuthor(
        "Feed post Recommended for you Rich Nicholls, MBA • 3rd+ Director of Operations & Compliance 1d • Follow"
      )
    ).toBe("Rich Nicholls, MBA");
  });

  test("takes the author after stacked social-context banners", () => {
    expect(
      parseHomeFeedAuthor(
        "Feed post Alice likes this Bob reposted this Carol 5h • Follow"
      )
    ).toBe("Carol");
  });

  test('strips a "Voices worth following" banner before the author', () => {
    expect(
      parseHomeFeedAuthor(
        "Feed post Voices worth following Elizabeth Reid • 2nd VP, Search 13h • Follow Bonjour France!"
      )
    ).toBe("Elizabeth Reid");
  });

  test('recovers the author from an expanded-post "Author" badge row without a degree marker', () => {
    expect(
      parseHomeFeedAuthor(
        "Daniel Kravtsov Author CEO, Improvado | Building the Agentic Marketing OS | A revenue ecosystem"
      )
    ).toBe("Daniel Kravtsov");
    expect(parseHomeFeedAuthor("Q Author Founder and CEO")).toBe("Q");
    expect(
      parseHomeFeedAuthor(
        "Daniel Kravtsov Author CEO who likes this approach to marketing"
      )
    ).toBe("Daniel Kravtsov");
  });

  test('keeps only the leading name on a "Premium Profile" badge row', () => {
    expect(
      parseHomeFeedAuthor(
        "Joseph Jacks Premium Profile 1st Joseph Jacks • 1st Autodidact. 2h Epic run at a16z"
      )
    ).toBe("Joseph Jacks");
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

  test("drops LinkedIn ad / boost promos without a real member header", () => {
    // Production empties: no " • " degree marker, no Author badge — pure promo.
    expect(
      isHomeFeedNoise(
        "Feed post Get more leads with boosting Boost your best content on LinkedIn to get more quality leads Learn more"
      )
    ).toBe(true);
    expect(
      isHomeFeedNoise(
        "Feed post Try LinkedIn Ads Build your brand and drive quality leads. Spend €200 to get an extra"
      )
    ).toBe(true);
  });

  test("keeps a member post that discusses LinkedIn Ads in the body", () => {
    expect(
      isHomeFeedNoise(
        "Feed post Jane Doe • 1st Growth lead 2h • Follow Why Try LinkedIn Ads still works for B2B pipelines"
      )
    ).toBe(false);
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

  test("declares the slug/engagement fields on the post metadata schema", () => {
    const def = new LinkedInConnector().definition;
    const props = def.feeds.home_feed.eventKinds.post.metadataSchema.properties;
    expect(props.author_linkedin_slug).toBeDefined();
    expect(props.social_actor).toBeDefined();
    expect(props.social_action).toBeDefined();
    expect(props.social_actor_slug).toBeDefined();
  });

  test("declares author and engager attributions keyed on linkedin_slug", () => {
    const def = new LinkedInConnector().definition;
    const attributions = def.feeds.home_feed.eventKinds.post.attributions ?? [];
    const authoredBy = attributions.find(
      (rule: { role: string }) => rule.role === "authored_by"
    );
    const mentions = attributions.find(
      (rule: { role: string }) => rule.role === "mentions"
    );

    expect(authoredBy).toBeDefined();
    expect(authoredBy.autoCreate).toBe(true);
    expect(authoredBy.target.entityType).toBe("person");
    expect(authoredBy.target.identities).toEqual([
      {
        namespace: LINKEDIN_IDENTITY.SLUG,
        eventPath: "metadata.author_linkedin_slug",
      },
    ]);

    expect(mentions).toBeDefined();
    expect(mentions.autoCreate).toBe(true);
    expect(mentions.target.entityType).toBe("person");
    expect(mentions.target.titlePath).toBe("metadata.social_actor");
    expect(mentions.target.identities).toEqual([
      {
        namespace: LINKEDIN_IDENTITY.SLUG,
        eventPath: "metadata.social_actor_slug",
      },
    ]);
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
    expect(calls[0].input.persistent).toBe(false);
    expect(calls[0].input.focus).toBe(false);
    expect(calls[0].input.url).toBe("https://www.linkedin.com/feed/");
    expect(
      (calls[0].input.scrape_config as { scroll: { max: number } }).scroll.max
    ).toBe(4);
    const cfg = calls[0].input.scrape_config as {
      fields: {
        links: {
          selector: string;
          take: string;
          parts: Record<string, unknown>;
        };
        author_control_label: { selector: string; attr: string };
      };
    };
    // objectAll captures each anchor with its href + accessible name, so the
    // author/engager are matched by NAME rather than DOM position.
    expect(cfg.fields.links.take).toBe("objectAll");
    expect(cfg.fields.links.selector).toContain("/company/");
    expect(Object.keys(cfg.fields.links.parts)).toContain("href");
    expect(cfg.fields.author_control_label.selector).toContain(
      "control menu for post by"
    );

    expect(res.events).toHaveLength(2);
    expect(res.events[0].origin_id).toBe("li_home_tok1");
    expect(res.events[1].origin_id).toBe("li_home_tok2");
    expect(res.metadata.backend).toBe("extension-cs-scrape");
    // These mock rows carry no links field, so support is assumed.
    expect(res.metadata.object_all_supported).toBe(true);
  });

  test("min_scrolls/max_scrolls pick a scroll budget in range each run", async () => {
    const scrollMaxes: number[] = [];
    const dispatcher = {
      dispatch: async (_action: string, input: Record<string, unknown>) => {
        scrollMaxes.push(
          (input.scrape_config as { scroll: { max: number } }).scroll.max
        );
        return {
          tab_id: 1,
          cs_scrape: true,
          result: { loggedIn: true, rows: [] },
        };
      },
    };
    const connector = new LinkedInConnector();
    const realRandom = Math.random;
    // Force mid-range pick: min + floor(0.5 * (max-min+1)) = 6 + floor(2.5) = 8
    Math.random = () => 0.5;
    try {
      const res = await connector.sync({
        feedKey: "home_feed",
        config: { min_scrolls: 6, max_scrolls: 10 },
        checkpoint: {},
        sessionState: { chrome_dispatcher: dispatcher },
      });
      expect(scrollMaxes).toEqual([8]);
      expect(res.metadata.scrolls_this_run).toBe(8);
    } finally {
      Math.random = realRandom;
    }
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

describe("prepare_comment helpers", () => {
  test("normalizeLinkedInPostUrl accepts urls, urns, and bare ids", () => {
    expect(normalizeLinkedInPostUrl("7312345678901234567")).toBe(
      "https://www.linkedin.com/feed/update/urn:li:activity:7312345678901234567"
    );
    expect(normalizeLinkedInPostUrl("li_post_7312345678901234567")).toBe(
      "https://www.linkedin.com/feed/update/urn:li:activity:7312345678901234567"
    );
    expect(
      normalizeLinkedInPostUrl("urn:li:activity:7312345678901234567")
    ).toBe(
      "https://www.linkedin.com/feed/update/urn:li:activity:7312345678901234567"
    );
    expect(
      normalizeLinkedInPostUrl(
        "https://www.linkedin.com/feed/update/urn:li:activity:7312345678901234567/"
      )
    ).toBe(
      "https://www.linkedin.com/feed/update/urn:li:activity:7312345678901234567"
    );
    expect(
      normalizeLinkedInPostUrl(
        "https://www.linkedin.com/feed/?updateEntityUrn=urn%3Ali%3Aactivity%3A7312345678901234567"
      )
    ).toBe(
      "https://www.linkedin.com/feed/update/urn:li:activity:7312345678901234567"
    );
    expect(
      normalizeLinkedInPostUrl(
        "http://www.linkedin.com/posts/example_activity-7312345678901234567-x"
      )
    ).toBe(
      "https://www.linkedin.com/feed/update/urn:li:activity:7312345678901234567"
    );
    expect(
      normalizeLinkedInPostUrl("https://www.linkedin.com/feed/")
    ).toBeNull();
    expect(normalizeLinkedInPostUrl("ftp://linkedin.com/post")).toBeNull();
    expect(normalizeLinkedInPostUrl("https://evil.example/x")).toBeNull();
    expect(normalizeLinkedInPostUrl("")).toBeNull();
  });

  test("isLinkedInAuthWall detects login walls", () => {
    expect(isLinkedInAuthWall("https://www.linkedin.com/login")).toBe(true);
    expect(isLinkedInAuthWall("https://www.linkedin.com/authwall")).toBe(true);
    expect(
      isLinkedInAuthWall(
        "https://www.linkedin.com/feed/update/urn:li:activity:1"
      )
    ).toBe(false);
  });

  test("submit labels are never treated as open-composer controls", () => {
    expect(isCommentSubmitLabel("Post")).toBe(true);
    expect(isCommentSubmitLabel("Submit")).toBe(true);
    expect(isCommentSubmitLabel("Send")).toBe(true);
    expect(isCommentSubmitLabel("Post comment")).toBe(true);
    expect(isCommentSubmitLabel("Comment")).toBe(false);
    expect(isCommentOpenLabel("Comment")).toBe(true);
    expect(isCommentOpenLabel("Post")).toBe(false);
    expect(isCommentOpenLabel("Post a comment")).toBe(true);
  });

  test("pickComment*Ref finds composer controls without selecting Post", () => {
    const tree = [
      { ref_id: 1, role: "button", name: "Like", tag: "button" },
      { ref_id: 2, role: "button", name: "Comment", tag: "button" },
      { ref_id: 3, role: "button", name: "Repost", tag: "button" },
      { ref_id: 4, role: "textbox", name: "Add a comment…", tag: "div" },
      { ref_id: 5, role: "button", name: "Post", tag: "button" },
    ];
    expect(pickCommentButtonRef(tree, 7)).toEqual({
      document_epoch: 7,
      ref_id: 2,
    });
    expect(pickCommentTextboxRef(tree, 7)).toEqual({
      document_epoch: 7,
      ref_id: 4,
    });
    expect(pickCommentButtonRef(tree, 7)?.ref_id).not.toBe(5);
  });

  test("buildFillCommentExpression embeds body safely and never auto-submits", () => {
    const expr = buildFillCommentExpression('hello "world"\nline2');
    expect(expr).toContain('hello \\"world\\"');
    expect(expr).toContain("insertText");
    expect(expr).toContain("isSubmitLabel");
    expect(expr).toContain("submitted: false");
    expect(expr).not.toMatch(
      /dispatchKeyEvent|key:\s*['"]Enter['"]|Meta\+Enter/i
    );
    expect(expr).toContain("composer_not_found");
  });

  test("truncateHandoffReason caps length for the banner", () => {
    expect(truncateHandoffReason("  short  ")).toBe("short");
    expect(truncateHandoffReason("")).toBeUndefined();
    const long = "x".repeat(200);
    const t = truncateHandoffReason(long, 40)!;
    expect(t.length).toBeLessThanOrEqual(40);
    expect(t.endsWith("…")).toBe(true);
  });

  test("buildInjectHandoffBannerExpression is Lobu-branded and not a submit", () => {
    const expr = buildInjectHandoffBannerExpression({
      reason: 'Met them at "AI" meetup',
    });
    expect(expr).toContain("lobu-handoff-banner");
    expect(expr).toContain("Lobu staged this comment");
    expect(expr).toContain("Owletto side panel");
    expect(expr).toContain('Met them at \\"AI\\" meetup');
    expect(expr).not.toMatch(/click\(\)\s*;[\s\S]*Post|Post[\s\S]*\.click\(/);
  });

  test("definition declares prepare_comment write action with human gate", () => {
    const c = new LinkedInConnector();
    const action = c.definition.actions?.prepare_comment;
    expect(action?.key).toBe("prepare_comment");
    expect(action?.requiresApproval).toBe(true);
    expect(action?.kind).toBe("write");
    expect(action?.annotations?.destructiveHint).toBe(false);
    expect(action?.inputSchema?.anyOf).toEqual([
      { required: ["post_url"] },
      { required: ["activity_id"] },
    ]);
    expect(c.definition.version).toBe("3.4.0");
    expect(String(action?.description ?? "")).toMatch(/NEVER submits/i);
  });

  test("definition declares verify_staged_comment as read-only", () => {
    const c = new LinkedInConnector();
    const action = c.definition.actions?.verify_staged_comment;
    expect(action?.key).toBe("verify_staged_comment");
    expect(action?.requiresApproval).toBe(false);
    expect(action?.kind).toBe("read");
    expect(action?.annotations?.destructiveHint).toBe(false);
    expect(action?.annotations?.idempotentHint).toBe(true);
    expect(
      action?.outputSchema?.properties?.match?.properties?.match_kind?.enum
    ).toEqual(["exact", "prefix", "contains"]);
  });

  test("commentBodiesMatch normalizes without accepting weak partial matches", () => {
    expect(normalizeCommentMatchText("  Hello\nWorld  ")).toBe("hello world");
    expect(commentBodiesMatch("Hello world", "Hello world").ok).toBe(true);
    expect(commentBodiesMatch("Hello world", "Hello world").kind).toBe("exact");
    expect(
      commentBodiesMatch(
        "A sufficiently distinctive draft body that continues after truncation",
        "A sufficiently distinctive draft body"
      ).kind
    ).toBe("prefix");
    expect(
      commentBodiesMatch(
        "a reasonably long draft body",
        "Prefix a reasonably long draft body suffix"
      ).kind
    ).toBe("contains");
    expect(
      commentBodiesMatch(
        "Great insight followed by the rest of the staged draft",
        "Great insight"
      ).ok
    ).toBe(false);
    expect(
      commentBodiesMatch(
        "This staged draft has an embedded generic phrase",
        "staged draft"
      ).ok
    ).toBe(false);
    expect(commentBodiesMatch("hello", "goodbye").ok).toBe(false);
  });

  test("buildScrapeCommentsExpression is read-only (no submit)", () => {
    const expr = buildScrapeCommentsExpression();
    expect(expr).toContain("comments-comment-item");
    expect(expr).not.toMatch(
      /insertText|dispatchKeyEvent|key:\s*['"]Enter['"]/
    );
    expect(expr).not.toMatch(/Post[\s\S]*\.click\(/);
  });

  test("prepareLinkedInComment stamps conversation handoff on navigate", async () => {
    const log: Array<{ key: string; input: Record<string, unknown> }> = [];
    const dispatcher = {
      dispatch: async (key: string, input: Record<string, unknown>) => {
        log.push({ key, input });
        if (key === "navigate") {
          return {
            tab_id: 9,
            current_url:
              "https://www.linkedin.com/feed/update/urn:li:activity:7312345678901234567",
          };
        }
        if (key === "wait_for_selector") return { found: true };
        if (key === "evaluate") {
          return {
            value: { ok: true, reason: "typed", preview: "hi" },
          };
        }
        if (key === "focus_tab" || key === "show_notification") return {};
        throw new Error(`unexpected ${key}`);
      },
    };
    const result = await prepareLinkedInComment(dispatcher, {
      postUrl: "7312345678901234567",
      body: "hi there draft",
      agentId: "agent_abc",
      threadId: "thread_xyz",
      messageId: "msg_1",
      notify: false,
      banner: false,
    });
    const nav = log.find((e) => e.key === "navigate");
    expect(nav?.input.holder_agent_id).toBe("agent_abc");
    expect(nav?.input.holder_thread_id).toBe("thread_xyz");
    expect(nav?.input.holder_message_id).toBe("msg_1");
    expect(result.agent_id).toBe("agent_abc");

    log.length = 0;
    const incomplete = await prepareLinkedInComment(dispatcher, {
      postUrl: "7312345678901234567",
      body: "another draft",
      agentId: "agent_without_thread",
      notify: false,
      banner: false,
    });
    const incompleteNav = log.find((e) => e.key === "navigate");
    expect(incompleteNav?.input.holder_agent_id).toBeUndefined();
    expect(incomplete.agent_id).toBeUndefined();
  });

  test("verifyLinkedInStagedComment matches scraped comments", async () => {
    const log: string[] = [];
    const dispatcher = {
      dispatch: async (key: string, input: Record<string, unknown>) => {
        log.push(key);
        if (key === "navigate") {
          return {
            tab_id: 3,
            current_url:
              "https://www.linkedin.com/feed/update/urn:li:activity:7312345678901234567",
          };
        }
        if (key === "wait_for_selector") return { found: true };
        if (key === "evaluate") {
          const expr = String(input.expression);
          if (expr.includes("load more comments")) return { value: true };
          return {
            value: {
              ok: true,
              comments: [
                { author: "Other", text: "unrelated" },
                {
                  author: "Burak",
                  text: "Great insight — thanks for sharing.",
                },
              ],
              count: 2,
            },
          };
        }
        if (key === "focus_tab") return {};
        throw new Error(`unexpected ${key}`);
      },
    };
    const result = await verifyLinkedInStagedComment(dispatcher, {
      postUrl: "7312345678901234567",
      body: "Great insight — thanks for sharing.",
      author_hint: "Burak",
    });
    expect(result.verified).toBe(true);
    expect(result.comments_scanned).toBe(2);
    expect(result.match?.author).toBe("Burak");
    expect(result.match?.match_kind).toBe("exact");
    expect(log).not.toContain("click_ref");
    expect(log).not.toContain("type_ref");
  });

  test("verifyLinkedInStagedComment reports no match cleanly", async () => {
    const dispatcher = {
      dispatch: async (key: string) => {
        if (key === "navigate") {
          return {
            tab_id: 3,
            current_url:
              "https://www.linkedin.com/feed/update/urn:li:activity:7312345678901234567",
          };
        }
        if (key === "wait_for_selector") return {};
        if (key === "evaluate") {
          return {
            value: {
              comments: [{ author: "A", text: "something else" }],
              count: 1,
            },
          };
        }
        if (key === "focus_tab") return {};
        return {};
      },
    };
    const result = await verifyLinkedInStagedComment(dispatcher, {
      postUrl: "7312345678901234567",
      body: "the staged draft that was never posted",
      focus: false,
    });
    expect(result.verified).toBe(false);
    expect(result.reason).toBe("no_matching_comment");
    expect(result.comments_scanned).toBe(1);
  });

  test("prepareLinkedInComment stages via evaluate (primary) and never clicks Post", async () => {
    const log: Array<{ key: string; input: Record<string, unknown> }> = [];
    let evaluateCalls = 0;
    const dispatcher = {
      dispatch: async (key: string, input: Record<string, unknown>) => {
        log.push({ key, input });
        if (key === "navigate") {
          return {
            tab_id: 42,
            current_url:
              "https://www.linkedin.com/feed/update/urn:li:activity:7312345678901234567",
            title: "Post",
          };
        }
        if (key === "wait_for_selector") return { found: true };
        if (key === "evaluate") {
          evaluateCalls += 1;
          const expr = String(input.expression);
          if (evaluateCalls === 1) {
            expect(expr).toContain("Great insight — thanks for sharing.");
            return {
              value: {
                ok: true,
                reason: "typed",
                preview: "Great insight — thanks for sharing.",
              },
            };
          }
          // Banner inject
          expect(expr).toContain("lobu-handoff-banner");
          expect(expr).toContain("Met at conference");
          return { value: { ok: true, anchored: true } };
        }
        if (key === "focus_tab") return { focused: true, tab_id: 42 };
        if (key === "show_notification") return { shown: true };
        throw new Error(`unexpected dispatch ${key}`);
      },
    };

    const result = await prepareLinkedInComment(dispatcher, {
      postUrl: "7312345678901234567",
      body: "Great insight — thanks for sharing.",
      reason: "Met at conference",
    });

    expect(result).toMatchObject({
      prepared: true,
      tab_id: 42,
      method: "evaluate",
      body: "Great insight — thanks for sharing.",
      banner_shown: true,
      reason_preview: "Met at conference",
    });
    expect(result.post_url).toContain("activity:7312345678901234567");

    const keys = log.map((e) => e.key);
    expect(keys).toEqual([
      "navigate",
      "wait_for_selector",
      "evaluate",
      "evaluate",
      "focus_tab",
      "show_notification",
    ]);
    // Never click Post (no click_ref at all on the happy path).
    expect(keys).not.toContain("click_ref");
    expect(keys).not.toContain("type_ref");
    const note = log.find((e) => e.key === "show_notification");
    expect(note?.input.tab_id).toBe(42);
    expect(String(note?.input.message)).toContain("Met at conference");
  });

  test("prepareLinkedInComment falls back to type_ref when evaluate is unavailable", async () => {
    const log: string[] = [];
    let evaluateCalls = 0;
    const dispatcher = {
      dispatch: async (key: string, input: Record<string, unknown>) => {
        log.push(key);
        if (key === "navigate") {
          return {
            tab_id: 9,
            current_url:
              "https://www.linkedin.com/feed/update/urn:li:activity:7312345678901234567",
          };
        }
        if (key === "wait_for_selector") return {};
        if (key === "evaluate") {
          evaluateCalls += 1;
          // First call is fill; later is banner.
          if (evaluateCalls === 1) {
            throw new Error("evaluate unavailable");
          }
          return { value: { ok: true, anchored: false } };
        }
        if (key === "get_accessibility_tree") {
          return {
            document_epoch: 1,
            tree: [
              { ref_id: 1, role: "button", name: "Comment", tag: "button" },
              {
                ref_id: 2,
                role: "textbox",
                name: "Add a comment…",
                tag: "div",
              },
              { ref_id: 3, role: "button", name: "Post", tag: "button" },
            ],
          };
        }
        if (key === "type_ref") {
          expect((input.ref as { ref_id: number }).ref_id).toBe(2);
          expect(input.text).toBe("hi");
          return {};
        }
        if (key === "focus_tab" || key === "show_notification") return {};
        throw new Error(`unexpected ${key} ${JSON.stringify(input)}`);
      },
    };

    const result = await prepareLinkedInComment(dispatcher, {
      postUrl:
        "https://www.linkedin.com/feed/update/urn:li:activity:7312345678901234567",
      body: "hi",
      notify: false,
    });
    expect(result.method).toBe("type_ref");
    expect(result.prepared).toBe(true);
    expect(result.banner_shown).toBe(true);
    expect(log).toContain("evaluate");
    expect(log).toContain("type_ref");
    expect(log).not.toContain("show_notification");
    // Must not click the Post submit control.
    expect(log).not.toContain("click_ref");
  });

  test("prepareLinkedInComment fails closed on auth wall", async () => {
    const dispatcher = {
      dispatch: async (key: string) => {
        if (key === "navigate") {
          return {
            tab_id: 1,
            current_url: "https://www.linkedin.com/login",
          };
        }
        throw new Error(`unexpected ${key}`);
      },
    };
    await expect(
      prepareLinkedInComment(dispatcher, {
        postUrl: "1234567890123",
        body: "x",
      })
    ).rejects.toThrow(/Not logged into LinkedIn/);
  });

  test("execute prepare_comment returns success output via dispatcher", async () => {
    const connector = new LinkedInConnector();
    const result = await connector.execute({
      actionKey: "prepare_comment",
      input: {
        activity_id: "7312345678901234567",
        body: "Nice post",
        notify: false,
      },
      credentials: null,
      config: {},
      sessionState: {
        chrome_dispatcher: {
          dispatch: async (key: string) => {
            if (key === "navigate") {
              return {
                tab_id: 5,
                current_url:
                  "https://www.linkedin.com/feed/update/urn:li:activity:7312345678901234567",
              };
            }
            if (key === "wait_for_selector") return {};
            if (key === "evaluate") {
              return {
                value: { ok: true, reason: "typed", preview: "Nice post" },
              };
            }
            if (key === "focus_tab") return {};
            return {};
          },
        },
      },
    });
    expect(result.success).toBe(true);
    expect(result.output?.prepared).toBe(true);
    expect(result.output?.tab_id).toBe(5);
    expect(result.output?.method).toBe("evaluate");
  });

  test("execute verify_staged_comment routes through the read path", async () => {
    const connector = new LinkedInConnector();
    const result = await connector.execute({
      actionKey: "verify_staged_comment",
      input: {
        activity_id: "7312345678901234567",
        body: "Nice post",
        author_hint: "Burak",
        focus: false,
      },
      credentials: null,
      config: {},
      sessionState: {
        chrome_dispatcher: {
          dispatch: async (key: string, input: Record<string, unknown>) => {
            if (key === "navigate") {
              return {
                tab_id: 6,
                current_url:
                  "https://www.linkedin.com/feed/update/urn:li:activity:7312345678901234567",
              };
            }
            if (key === "wait_for_selector") return {};
            if (key === "evaluate") {
              const expr = String(input.expression);
              if (expr.includes("load|show|view")) return { value: false };
              return {
                value: {
                  comments: [{ author: "Burak", text: "Nice post" }],
                },
              };
            }
            throw new Error(`unexpected ${key}`);
          },
        },
      },
    });
    expect(result.success).toBe(true);
    expect(result.output?.verified).toBe(true);
    expect(result.output?.match?.author).toBe("Burak");
  });
});

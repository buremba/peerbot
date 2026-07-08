import { readFileSync } from "node:fs";
import path from "node:path";
import {
  type ConnectorDefinition,
  ConnectorRuntime,
  type EventAttributionRule,
  type EventEnvelope,
  type SyncContext,
  type SyncResult,
} from "@lobu/connector-sdk";
import {
  INSTAGRAM_IDENTITY,
  usernameFromProfileUrl,
} from "./instagram-identity.ts";
import {
  assertDirectory,
  batchSize,
  type LocalTakeoutConfig,
  listFiles,
  maxEventCursor,
  stableId,
  stripHtml,
  takeBatch,
} from "./takeout-utils.ts";

/**
 * IG-INTERNAL identity attribution for the connections feed (followers /
 * following / blocked / restricted). The takeout has no numeric id, so people
 * are keyed on `ig_username` — the only cross-referenceable handle a takeout
 * gives. It is USER-CHANGEABLE, so it is matched EQUAL-WEIGHT (NOT `primary`),
 * exactly like `linkedin_slug`: the same handle appearing in BOTH followers and
 * following folds onto ONE person instead of forking two.
 *
 * `createWhen: { metadata.username exists }` gates minting on a normalized
 * handle being present — a `blocked`/`restricted` row that is only a display
 * name with no resolvable `instagram.com/<user>` link (so `username` is absent)
 * accretes onto an existing person but never MINTS an id-less duplicate. This is
 * the same mint-gate that codex flagged for the X handle-only-follow case.
 */
const IG_CONNECTION_ATTRIBUTIONS: EventAttributionRule[] = [
  {
    role: "about",
    autoCreate: true,
    target: {
      entityType: "person",
      createWhen: { path: "metadata.username", exists: true },
      titlePath: "author_name",
      identities: [
        {
          namespace: INSTAGRAM_IDENTITY.USERNAME,
          eventPath: "metadata.username",
        },
      ],
    },
    traits: {
      ig_username: {
        eventPath: "metadata.username",
        behavior: "prefer_non_empty",
      },
      instagram_profile_url: {
        eventPath: "metadata.profile_url",
        behavior: "prefer_non_empty",
      },
    },
  },
];

interface InstagramTakeoutCheckpoint {
  last_messages_timestamp?: string;
  last_connections_timestamp?: string;
  last_saved_timestamp?: string;
  last_comments_timestamp?: string;
  last_likes_timestamp?: string;
  last_media_timestamp?: string;
  last_story_interactions_timestamp?: string;
  last_searches_timestamp?: string;
  last_link_history_timestamp?: string;
  last_ads_timestamp?: string;
}

export default class InstagramTakeoutConnector extends ConnectorRuntime<
  InstagramTakeoutCheckpoint,
  LocalTakeoutConfig
> {
  readonly definition: ConnectorDefinition = {
    key: "instagram.takeout",
    name: "Instagram Takeout",
    version: "1.0.0",
    description:
      "Ingests local Instagram export HTML for messages and activity.",
    authSchema: { methods: [{ type: "none" }] },
    feeds: {
      messages: {
        key: "messages",
        name: "Messages",
        configSchema: localTakeoutSchema(
          "Path to the Instagram export folder."
        ),
      },
      connections: {
        key: "connections",
        name: "Followers and Following",
        configSchema: localTakeoutSchema(
          "Path to the Instagram export folder."
        ),
        eventKinds: {
          follower: {
            description: "An account that follows the user",
            attributions: IG_CONNECTION_ATTRIBUTIONS,
          },
          following: {
            description: "An account the user follows",
            attributions: IG_CONNECTION_ATTRIBUTIONS,
          },
          blocked_profiles: {
            description: "An account the user has blocked",
            attributions: IG_CONNECTION_ATTRIBUTIONS,
          },
          restricted_profiles: {
            description: "An account the user has restricted",
            attributions: IG_CONNECTION_ATTRIBUTIONS,
          },
        },
      },
      saved: {
        key: "saved",
        name: "Saved Items",
        configSchema: localTakeoutSchema(
          "Path to the Instagram export folder."
        ),
      },
      comments: {
        key: "comments",
        name: "Comments",
        configSchema: localTakeoutSchema(
          "Path to the Instagram export folder."
        ),
      },
      likes: {
        key: "likes",
        name: "Likes",
        configSchema: localTakeoutSchema(
          "Path to the Instagram export folder."
        ),
      },
      media: {
        key: "media",
        name: "Posts and Stories",
        configSchema: localTakeoutSchema(
          "Path to the Instagram export folder."
        ),
      },
      story_interactions: {
        key: "story_interactions",
        name: "Story Interactions",
        configSchema: localTakeoutSchema(
          "Path to the Instagram export folder."
        ),
      },
      searches: {
        key: "searches",
        name: "Searches",
        configSchema: localTakeoutSchema(
          "Path to the Instagram export folder."
        ),
      },
      link_history: {
        key: "link_history",
        name: "Link History",
        configSchema: localTakeoutSchema(
          "Path to the Instagram export folder."
        ),
      },
      ads: {
        key: "ads",
        name: "Ad Interactions",
        configSchema: localTakeoutSchema(
          "Path to the Instagram export folder."
        ),
      },
    },
  };

  async sync(
    ctx: SyncContext<InstagramTakeoutCheckpoint, LocalTakeoutConfig>
  ): Promise<SyncResult<InstagramTakeoutCheckpoint>> {
    const takeoutDir = assertDirectory(ctx.config, "Instagram");
    const max = batchSize(ctx.config);

    if (ctx.feedKey === "messages") {
      return this.result(
        ctx,
        "last_messages_timestamp",
        this.readMessageEvents(takeoutDir),
        max
      );
    }
    if (ctx.feedKey === "connections") {
      return this.result(
        ctx,
        "last_connections_timestamp",
        this.readConnectionEvents(takeoutDir),
        max
      );
    }
    if (ctx.feedKey === "saved") {
      return this.result(
        ctx,
        "last_saved_timestamp",
        this.readGenericActivity(takeoutDir, "saved"),
        max
      );
    }
    if (ctx.feedKey === "comments") {
      return this.result(
        ctx,
        "last_comments_timestamp",
        this.readGenericActivity(takeoutDir, "comments"),
        max
      );
    }
    if (ctx.feedKey === "likes") {
      return this.result(
        ctx,
        "last_likes_timestamp",
        this.readHtmlActivity(takeoutDir, {
          root: path.join(takeoutDir, "your_instagram_activity", "likes"),
          feed: "likes",
          originType: "like",
        }),
        max
      );
    }
    if (ctx.feedKey === "media") {
      return this.result(
        ctx,
        "last_media_timestamp",
        this.readHtmlActivity(takeoutDir, {
          root: path.join(takeoutDir, "your_instagram_activity", "media"),
          feed: "media",
          originType: "media_post",
        }),
        max
      );
    }
    if (ctx.feedKey === "story_interactions") {
      return this.result(
        ctx,
        "last_story_interactions_timestamp",
        this.readHtmlActivity(takeoutDir, {
          root: path.join(
            takeoutDir,
            "your_instagram_activity",
            "story_interactions"
          ),
          feed: "story_interactions",
          originType: "story_interaction",
        }),
        max
      );
    }
    if (ctx.feedKey === "searches") {
      return this.result(
        ctx,
        "last_searches_timestamp",
        this.readHtmlActivity(takeoutDir, {
          root: path.join(takeoutDir, "logged_information", "recent_searches"),
          feed: "searches",
          originType: "search",
        }),
        max
      );
    }
    if (ctx.feedKey === "link_history") {
      return this.result(
        ctx,
        "last_link_history_timestamp",
        this.readHtmlActivity(takeoutDir, {
          root: path.join(takeoutDir, "logged_information", "link_history"),
          feed: "link_history",
          originType: "link_visit",
        }),
        max
      );
    }
    if (ctx.feedKey === "ads") {
      return this.result(
        ctx,
        "last_ads_timestamp",
        this.readHtmlActivity(takeoutDir, {
          root: path.join(takeoutDir, "ads_information", "ads_and_topics"),
          feed: "ads",
          originType: "ad_interaction",
        }),
        max
      );
    }

    throw new Error(`Unknown Instagram Takeout feed: ${ctx.feedKey}`);
  }

  private result(
    ctx: SyncContext<InstagramTakeoutCheckpoint, LocalTakeoutConfig>,
    key: keyof InstagramTakeoutCheckpoint,
    allEvents: EventEnvelope[],
    max: number
  ): SyncResult<InstagramTakeoutCheckpoint> {
    const events = takeBatch(allEvents, ctx.checkpoint?.[key], max);
    return {
      events,
      checkpoint: {
        ...ctx.checkpoint,
        [key]: maxEventCursor(events, ctx.checkpoint?.[key]),
      },
    };
  }

  private readMessageEvents(takeoutDir: string): EventEnvelope[] {
    const messagesRoot = path.join(
      takeoutDir,
      "your_instagram_activity",
      "messages"
    );
    const files = listFiles(
      messagesRoot,
      (file) =>
        file.endsWith(".html") && path.basename(file).startsWith("message_")
    );
    return files.flatMap((file) => {
      const html = readFileSync(file, "utf8");
      const conversationTitle = stripHtml(
        html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ??
          path.basename(path.dirname(file))
      );
      const cards =
        html.match(
          /<div class="pam _3-95 _2ph- _a6-g uiBoxWhite noborder">[\s\S]*?(?=<div class="pam _3-95 _2ph- _a6-g uiBoxWhite noborder">|<\/main>)/g
        ) ?? [];
      return cards.flatMap((card) => {
        const sender = stripHtml(
          card.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i)?.[1] ?? ""
        );
        const dateText = stripHtml(
          card.match(/<div class="_3-94 _a6-o">([\s\S]*?)<\/div>/i)?.[1] ?? ""
        );
        const contentMatch = card.match(
          /<div class="_3-95 _a6-p">([\s\S]*?)<div class="_3-94 _a6-o">/i
        );
        const text = stripHtml(contentMatch?.[1] ?? "");
        const occurredAt = new Date(dateText);
        if (!sender || !text || Number.isNaN(occurredAt.getTime())) return [];
        const folder = file.includes(`${path.sep}message_requests${path.sep}`)
          ? "message_requests"
          : "inbox";
        return [
          {
            origin_id: stableId("ig_message", [file, sender, dateText, text]),
            origin_type: "message",
            occurred_at: occurredAt,
            payload_text: text,
            author_name: sender,
            metadata: {
              platform: "instagram",
              conversation: conversationTitle,
              sender_name: sender,
              folder,
              source_file: path.relative(takeoutDir, file),
            },
          },
        ];
      });
    });
  }

  private readConnectionEvents(takeoutDir: string): EventEnvelope[] {
    const root = path.join(
      takeoutDir,
      "connections",
      "followers_and_following"
    );
    const files = listFiles(root, (file) => {
      const base = path.basename(file);
      return (
        /^followers_\d+\.html$/.test(base) ||
        base === "following.html" ||
        base === "blocked_profiles.html" ||
        base === "restricted_profiles.html"
      );
    });

    return files.flatMap((file) => {
      const kind = path.basename(file, ".html");
      const html = readFileSync(file, "utf8");
      const links = [
        ...html.matchAll(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g),
      ];
      return links.flatMap((match) => {
        const url = match[1] ?? "";
        const name = stripHtml(match[2] ?? "");
        if (!url || !name) return [];
        // Normalized handle keyed by the identity resolver. `undefined` (not "")
        // when the link is not a resolvable profile, so `createWhen exists`
        // gates minting a person on a real handle being present.
        const username = usernameFromProfileUrl(url) ?? undefined;
        return [
          {
            origin_id: stableId("ig_connection", [kind, url, name]),
            origin_type: kind.startsWith("follower") ? "follower" : kind,
            occurred_at: snapshotDate(),
            payload_text: `${kind}: ${name}`,
            author_name: name,
            source_url: url,
            metadata: {
              platform: "instagram",
              kind,
              profile_url: url,
              username,
            },
          },
        ];
      });
    });
  }

  private readGenericActivity(
    takeoutDir: string,
    folder: "saved" | "comments"
  ): EventEnvelope[] {
    const root = path.join(takeoutDir, "your_instagram_activity", folder);
    const files = listFiles(root, (file) => file.endsWith(".html"));
    return files.flatMap((file) => {
      const html = readFileSync(file, "utf8");
      const cards =
        html.match(
          /<div class="pam _3-95 _2ph- _a6-g uiBoxWhite noborder">[\s\S]*?(?=<div class="pam _3-95 _2ph- _a6-g uiBoxWhite noborder">|<\/main>)/g
        ) ?? [];
      return cards.flatMap((card) => {
        const text = stripHtml(card);
        if (!text) return [];
        const dateMatch = text.match(
          /[A-Z][a-z]{2,8} \d{1,2}, \d{4}(?:,? \d{1,2}:\d{2}\s*(?:AM|PM))?/
        );
        const occurredAt = dateMatch ? new Date(dateMatch[0]) : snapshotDate();
        return [
          {
            origin_id: stableId(`ig_${folder}`, [file, text]),
            origin_type: folder === "saved" ? "saved_item" : "comment",
            occurred_at: Number.isNaN(occurredAt.getTime())
              ? snapshotDate()
              : occurredAt,
            payload_text: text,
            metadata: {
              platform: "instagram",
              folder,
              source_file: path.relative(takeoutDir, file),
            },
          },
        ];
      });
    });
  }

  private readHtmlActivity(
    takeoutDir: string,
    options: { root: string; feed: string; originType: string }
  ): EventEnvelope[] {
    const files = listFiles(options.root, (file) => file.endsWith(".html"));
    return files.flatMap((file) => {
      const html = readFileSync(file, "utf8");
      const cards = htmlCards(html);
      return cards.flatMap((card) => {
        const text = stripHtml(card);
        if (!text) return [];
        const occurredAt = parseInstagramDate(text) ?? snapshotDate();
        const links = extractLinks(card);
        const title =
          extractHeading(card) ?? text.split("\n")[0]?.slice(0, 120);
        return [
          {
            origin_id: stableId(`ig_${options.feed}`, [
              file,
              text,
              links[0]?.href,
            ]),
            origin_type: options.originType,
            occurred_at: occurredAt,
            payload_text: text,
            title,
            source_url: links.find((link) => link.href.startsWith("http"))
              ?.href,
            metadata: {
              platform: "instagram",
              feed: options.feed,
              source_file: path.relative(takeoutDir, file),
              links,
            },
          },
        ];
      });
    });
  }
}

function snapshotDate(): Date {
  return new Date("1970-01-02T00:00:00.000Z");
}

function htmlCards(html: string): string[] {
  return (
    html.match(
      /<div class="pam _3-95 _2ph- _a6-g uiBoxWhite noborder">[\s\S]*?(?=<div class="pam _3-95 _2ph- _a6-g uiBoxWhite noborder">|<\/main>)/g
    ) ?? []
  );
}

function extractHeading(html: string): string | undefined {
  const heading = html.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i)?.[1];
  const text = heading ? stripHtml(heading) : "";
  return text || undefined;
}

function extractLinks(html: string): Array<{ href: string; text: string }> {
  return [...html.matchAll(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g)]
    .map((match) => ({
      href: match[1] ?? "",
      text: stripHtml(match[2] ?? ""),
    }))
    .filter((link) => link.href || link.text);
}

function parseInstagramDate(text: string): Date | undefined {
  const match = text.match(
    /(?:Time)?([A-Z][a-z]{2,8} \d{1,2}, \d{4}(?:,?\s*\d{1,2}:\d{2}\s*(?:AM|PM))?)/i
  );
  if (!match) return undefined;
  const date = new Date(match[1] ?? match[0]);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function localTakeoutSchema(description: string): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      takeout_dir: { type: "string", description },
      batch_size: {
        type: "integer",
        minimum: 1,
        maximum: 5000,
        default: 1000,
        description: "Maximum events to emit per sync run.",
      },
    },
  };
}

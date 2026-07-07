import path from "node:path";
import {
  type ConnectorDefinition,
  ConnectorRuntime,
  type EventEnvelope,
  type SyncContext,
  type SyncResult,
} from "@lobu/connector-sdk";
import {
  assertDirectory,
  batchSize,
  type LocalTakeoutConfig,
  maxEventCursor,
  readJsArray,
  stableId,
  takeBatch,
  twitterSnowflakeDate,
} from "./takeout-utils.ts";

interface TwitterTakeoutCheckpoint {
  last_tweets_timestamp?: string;
  last_messages_timestamp?: string;
  last_likes_timestamp?: string;
  last_followers_timestamp?: string;
  last_following_timestamp?: string;
}

interface TweetRecord {
  tweet?: {
    id?: string;
    id_str?: string;
    full_text?: string;
    text?: string;
    created_at?: string;
    source?: string;
    retweet_count?: string;
    favorite_count?: string;
    lang?: string;
    entities?: Record<string, unknown>;
    in_reply_to_status_id_str?: string;
    in_reply_to_user_id_str?: string;
    in_reply_to_screen_name?: string;
  };
}

interface LikeRecord {
  like?: {
    tweetId?: string;
    fullText?: string;
    expandedUrl?: string;
  };
}

interface DmRecord {
  dmConversation?: {
    conversationId?: string;
    messages?: Array<{
      messageCreate?: {
        id?: string;
        createdAt?: string;
        text?: string;
        senderId?: string;
        recipientId?: string;
        urls?: unknown[];
        mediaUrls?: string[];
        reactions?: unknown[];
      };
    }>;
  };
}

interface FollowRecord {
  follower?: { accountId?: string; userLink?: string };
  following?: { accountId?: string; userLink?: string };
}

export default class TwitterTakeoutConnector extends ConnectorRuntime<
  TwitterTakeoutCheckpoint,
  LocalTakeoutConfig
> {
  readonly definition: ConnectorDefinition = {
    key: "twitter.takeout",
    name: "X/Twitter Takeout",
    version: "1.0.0",
    description: "Ingests local X/Twitter archive exports.",
    authSchema: { methods: [{ type: "none" }] },
    feeds: {
      tweets: {
        key: "tweets",
        name: "Tweets and Replies",
        configSchema: localTakeoutSchema(
          "Path to the X/Twitter archive folder containing data/tweets.js."
        ),
      },
      messages: {
        key: "messages",
        name: "Direct Messages",
        configSchema: localTakeoutSchema(
          "Path to the X/Twitter archive folder containing DM files."
        ),
      },
      likes: {
        key: "likes",
        name: "Likes",
        configSchema: localTakeoutSchema(
          "Path to the X/Twitter archive folder containing data/like.js."
        ),
      },
      followers: {
        key: "followers",
        name: "Followers",
        configSchema: localTakeoutSchema(
          "Path to the X/Twitter archive folder containing data/follower.js."
        ),
      },
      following: {
        key: "following",
        name: "Following",
        configSchema: localTakeoutSchema(
          "Path to the X/Twitter archive folder containing data/following.js."
        ),
      },
    },
  };

  async sync(
    ctx: SyncContext<TwitterTakeoutCheckpoint, LocalTakeoutConfig>
  ): Promise<SyncResult<TwitterTakeoutCheckpoint>> {
    const takeoutDir = assertDirectory(ctx.config, "X/Twitter");
    const dataDir = path.join(takeoutDir, "data");
    const max = batchSize(ctx.config);

    if (ctx.feedKey === "tweets") {
      return this.result(
        ctx,
        "last_tweets_timestamp",
        this.readTweetEvents(dataDir),
        max
      );
    }
    if (ctx.feedKey === "messages") {
      return this.result(
        ctx,
        "last_messages_timestamp",
        this.readMessageEvents(dataDir),
        max
      );
    }
    if (ctx.feedKey === "likes") {
      return this.result(
        ctx,
        "last_likes_timestamp",
        this.readLikeEvents(dataDir),
        max
      );
    }
    if (ctx.feedKey === "followers") {
      return this.result(
        ctx,
        "last_followers_timestamp",
        this.readFollowEvents(dataDir, "follower"),
        max
      );
    }
    if (ctx.feedKey === "following") {
      return this.result(
        ctx,
        "last_following_timestamp",
        this.readFollowEvents(dataDir, "following"),
        max
      );
    }

    throw new Error(`Unknown X/Twitter Takeout feed: ${ctx.feedKey}`);
  }

  private result(
    ctx: SyncContext<TwitterTakeoutCheckpoint, LocalTakeoutConfig>,
    key: keyof TwitterTakeoutCheckpoint,
    allEvents: EventEnvelope[],
    max: number
  ): SyncResult<TwitterTakeoutCheckpoint> {
    const events = takeBatch(allEvents, ctx.checkpoint?.[key], max);
    return {
      events,
      checkpoint: {
        ...ctx.checkpoint,
        [key]: maxEventCursor(events, ctx.checkpoint?.[key]),
      },
    };
  }

  private readTweetEvents(dataDir: string): EventEnvelope[] {
    return readJsArray<TweetRecord>(path.join(dataDir, "tweets.js")).flatMap(
      (record) => {
        const tweet = record.tweet;
        const occurredAt = tweet?.created_at
          ? new Date(tweet.created_at)
          : undefined;
        const tweetId = tweet?.id_str ?? tweet?.id;
        if (
          !tweet ||
          !tweetId ||
          !occurredAt ||
          Number.isNaN(occurredAt.getTime())
        )
          return [];
        const isReply = Boolean(
          tweet.in_reply_to_status_id_str || tweet.in_reply_to_screen_name
        );
        const text = tweet.full_text ?? tweet.text ?? "";
        return [
          {
            origin_id: `x_tweet_${tweetId}`,
            origin_type: isReply ? "reply" : "tweet",
            occurred_at: occurredAt,
            payload_text: text,
            source_url: `https://twitter.com/i/web/status/${tweetId}`,
            title: text.slice(0, 120),
            metadata: {
              platform: "x",
              tweet_id: tweetId,
              retweet_count: tweet.retweet_count
                ? Number(tweet.retweet_count)
                : undefined,
              favorite_count: tweet.favorite_count
                ? Number(tweet.favorite_count)
                : undefined,
              language: tweet.lang,
              source: tweet.source,
              entities: tweet.entities,
              in_reply_to_status_id: tweet.in_reply_to_status_id_str,
              in_reply_to_user_id: tweet.in_reply_to_user_id_str,
              in_reply_to_screen_name: tweet.in_reply_to_screen_name,
            },
          },
        ];
      }
    );
  }

  private readMessageEvents(dataDir: string): EventEnvelope[] {
    const oneToOne = readJsArray<DmRecord>(
      path.join(dataDir, "direct-messages.js")
    );
    const group = readJsArray<DmRecord>(
      path.join(dataDir, "direct-messages-group.js")
    );
    return [...oneToOne, ...group].flatMap((conversation) => {
      const conversationId = conversation.dmConversation?.conversationId;
      return (
        conversation.dmConversation?.messages?.flatMap((message) => {
          const created = message.messageCreate;
          const occurredAt = created?.createdAt
            ? new Date(created.createdAt)
            : undefined;
          if (!created?.id || !occurredAt || Number.isNaN(occurredAt.getTime()))
            return [];
          return [
            {
              origin_id: `x_dm_${created.id}`,
              origin_type: "dm_message",
              occurred_at: occurredAt,
              payload_text: created.text ?? "",
              metadata: {
                platform: "x",
                conversation_id: conversationId,
                sender_id: created.senderId,
                recipient_id: created.recipientId,
                urls: created.urls ?? [],
                media_urls: created.mediaUrls ?? [],
                reactions: created.reactions ?? [],
              },
            },
          ];
        }) ?? []
      );
    });
  }

  private readLikeEvents(dataDir: string): EventEnvelope[] {
    return readJsArray<LikeRecord>(path.join(dataDir, "like.js")).flatMap(
      (record) => {
        const like = record.like;
        const occurredAt = like?.tweetId
          ? twitterSnowflakeDate(like.tweetId)
          : undefined;
        if (!like?.tweetId || !occurredAt) return [];
        return [
          {
            origin_id: `x_like_${like.tweetId}`,
            origin_type: "liked_tweet",
            occurred_at: occurredAt,
            payload_text: like.fullText ?? "",
            source_url: like.expandedUrl,
            title: (like.fullText ?? "").slice(0, 120),
            metadata: {
              platform: "x",
              tweet_id: like.tweetId,
              expanded_url: like.expandedUrl,
              occurred_at_source: "tweet_snowflake_created_at",
            },
          },
        ];
      }
    );
  }

  private readFollowEvents(
    dataDir: string,
    kind: "follower" | "following"
  ): EventEnvelope[] {
    const file = kind === "follower" ? "follower.js" : "following.js";
    return readJsArray<FollowRecord>(path.join(dataDir, file)).flatMap(
      (record) => {
        const item = kind === "follower" ? record.follower : record.following;
        if (!item?.accountId && !item?.userLink) return [];
        const occurredAt = new Date("1970-01-02T00:00:00.000Z");
        const handle = item.userLink?.match(/twitter\.com\/([^/?#]+)/)?.[1];
        return [
          {
            origin_id: stableId(`x_${kind}`, [item.accountId, item.userLink]),
            origin_type: kind,
            occurred_at: occurredAt,
            payload_text:
              kind === "follower"
                ? `Follower: ${handle ?? item.accountId}`
                : `Following: ${handle ?? item.accountId}`,
            source_url: item.userLink,
            metadata: {
              platform: "x",
              account_id: item.accountId,
              user_link: item.userLink,
              handle,
            },
          },
        ];
      }
    );
  }
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

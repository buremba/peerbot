/**
 * LinkedIn Connector
 *
 * Example-only — not bundled with Lobu. A single connector that spans BOTH:
 *
 *   • LIVE feeds (home_feed, company_updates, jobs) — scraped via the paired
 *     Owletto Chrome extension's network-intercept / content-script primitives.
 *     The extension runs inside the user's real Chrome session — no Playwright,
 *     no cookie cache, no `--remote-debugging-port` plumbing. We attach the CDP
 *     Network domain in the user's signed-in tab, drive scroll pagination, and
 *     parse the Voyager API responses the page emits. Auth is implicit: the user
 *     is already signed into linkedin.com in the paired Chrome. If no online
 *     Owletto extension is reachable in the connection's org, these syncs fail
 *     fast with a clear "no paired Owletto extension" error.
 *
 *   • TAKEOUT feeds (connections, messages, invitations, applied_jobs, profile,
 *     companies, learning, events, endorsements, media) — read from the user's
 *     local LinkedIn Data Export CSV files.
 *
 * Folding both into ONE connector (key "linkedin") means a single connection
 * dedups all people on the shared `linkedin_slug`/`email` identity: a person met
 * live and a person in the CSV export collapse to the same entity.
 */

import {
  type ChromeActionDispatcher,
  type ConnectorDefinition,
  ConnectorRuntime,
  type EventAttributionRule,
  type EventEnvelope,
  type SyncContext,
  type SyncResult,
  calculateEngagementScore,
  extensionDomScrape,
  extensionNetworkSync,
} from "@lobu/connector-sdk";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  LINKEDIN_EMAIL_NAMESPACE,
  LINKEDIN_IDENTITY,
  normalizeLinkedInSlug,
} from "./linkedin-identity.ts";
import {
  type LocalTakeoutConfig,
  assertDirectory,
  batchSize,
  maxEventCursor,
  parseCsv,
  stableId,
  stripHtml,
  takeBatch,
} from "./takeout-utils.ts";

// ── Types ──────────────────────────────────────────────────────

/**
 * Merged checkpoint. Carries the live cursor fields (last_post_id / last_job_id
 * / last_timestamp) AND every takeout feed's `last_*_timestamp` cursor. The
 * takeout `jobs` feed was renamed to `applied_jobs`, so its cursor is
 * `last_applied_jobs_timestamp` (no ambiguity with the live `jobs` feed, which
 * checkpoints on last_job_id/last_timestamp). No production checkpoint exists,
 * so the rename is safe.
 */
interface LinkedInCheckpoint {
  // Live feed cursors.
  last_post_id?: string;
  last_job_id?: string;
  last_timestamp?: string;
  // Takeout feed cursors.
  last_messages_timestamp?: string;
  last_connections_timestamp?: string;
  last_invitations_timestamp?: string;
  last_applied_jobs_timestamp?: string;
  last_profile_timestamp?: string;
  last_companies_timestamp?: string;
  last_learning_timestamp?: string;
  last_events_timestamp?: string;
  last_endorsements_timestamp?: string;
  last_media_timestamp?: string;
}

/**
 * Merged config. Permissive superset of the live config (company_url,
 * max_scrolls) and the takeout config (takeout_dir, batch_size). A given feed
 * only reads the keys relevant to its source.
 */
interface LinkedInConfig extends LocalTakeoutConfig {
  company_url?: string;
  max_scrolls?: number;
}

interface LinkedInPost {
  id: string;
  text: string;
  author: string;
  authorHeadline?: string;
  likes: number;
  comments: number;
  shares: number;
  publishedAt: Date;
}

interface LinkedInJob {
  id: string;
  title: string;
  location: string;
  postedAt: Date;
  url: string;
  description?: string;
}

function normalizeCheckpointPostId(postId?: string): string | undefined {
  if (!postId) return undefined;
  return postId.startsWith("li_post_")
    ? postId.slice("li_post_".length)
    : postId;
}

// ── Identity attributions ──────────────────────────────────────

/**
 * Link a `connection` event to the connected person via their canonical
 * `linkedin_slug` (extracted from the profile URL) plus their `email`. Neither
 * is `primary` — they match equal-weight cross-channel until a stable primary
 * id arrives from the live connector. The full URL is kept as a display trait,
 * not an identity (case/URL noise would fork the entity). Connections ARE the
 * user's network, so we mint (`autoCreate`) a person per row.
 */
const LINKEDIN_CONNECTION_ATTRIBUTIONS: EventAttributionRule[] = [
  {
    role: "about",
    autoCreate: true,
    target: {
      entityType: "person",
      titlePath: "author_name",
      identities: [
        {
          namespace: LINKEDIN_IDENTITY.SLUG,
          eventPath: "metadata.linkedin_slug",
        },
        { namespace: LINKEDIN_EMAIL_NAMESPACE, eventPath: "metadata.email" },
      ],
    },
    traits: {
      linkedin_url: {
        eventPath: "metadata.linkedin_url",
        behavior: "prefer_non_empty",
      },
      company: { eventPath: "metadata.company", behavior: "prefer_non_empty" },
      position: {
        eventPath: "metadata.position",
        behavior: "prefer_non_empty",
      },
    },
  },
];

/**
 * Link a `message` event to its sender (the counterparty) via the
 * `linkedin_slug` extracted from their profile URL, plus display name. Real
 * counterparties, so mint on no match.
 */
const LINKEDIN_MESSAGE_ATTRIBUTIONS: EventAttributionRule[] = [
  {
    role: "authored_by",
    autoCreate: true,
    target: {
      entityType: "person",
      titlePath: "metadata.from",
      identities: [
        {
          namespace: LINKEDIN_IDENTITY.SLUG,
          eventPath: "metadata.sender_linkedin_slug",
        },
      ],
    },
    traits: {
      linkedin_url: {
        eventPath: "metadata.sender_profile_url",
        behavior: "prefer_non_empty",
      },
      last_linkedin_message_at: {
        eventPath: "occurred_at",
        behavior: "overwrite",
      },
    },
  },
];

// ── Home-feed content-script scrape contract ────────────────────
//
// The personalized home feed (linkedin.com/feed/) is the ONE feed that can't
// be read via network capture: attaching the CDP debugger stops the feed from
// rendering, so the Voyager responses never arrive. Instead we drive the
// extension's `cs_scrape` op (a content script, no debugger) with a declarative
// selector config defined here. The extension runs a site-agnostic scrape
// engine — the LinkedIn selectors live in this connector, not the extension.

/** A row produced by the extension's cs_scrape from HOME_FEED_SCRAPE_CONFIG. */
interface HomeFeedRow {
  /** The componentkey token (base64url-ish, NOT a numeric activity id). */
  id?: string;
  body?: string;
  author?: string;
}

/** LinkedIn origins the cs_scrape window is allowed to touch. */
const LINKEDIN_ALLOWED_ORIGINS = ["linkedin.com", "*.linkedin.com"];

/**
 * Selectors for the virtualized linkedin.com/feed/ DOM. Home-feed posts are
 * componentkey divs with no activity urn, so the row id is the componentkey
 * token (NOT numeric). These selectors live here, not in the extension.
 */
const HOME_FEED_SCRAPE_CONFIG = {
  scroll: { max: 8, stall: 3, waitMs: 1500 },
  loggedOutWhen: {
    pathRegex: "/(login|authwall|uas/login|checkpoint|signup)\\b",
  },
  rowSelector: 'div[componentkey*="FeedType_MAIN_FEED_RELEVANCE"]',
  id: {
    source: "attr",
    name: "componentkey",
    regex: "^(?:expanded)?(.+?)FeedType_",
    group: 1,
  },
  requireFields: ["body"],
  fields: {
    body: { take: "text" },
    author: {
      // LinkedIn obfuscates the actor classes, so the old
      // .update-components-actor__* selectors no longer match. Best-effort:
      // grab the visible name span inside the actor's profile/company link
      // when present. When this misses, buildHomeFeedEvents falls back to
      // parsing the author out of the row body text.
      selector:
        'a[href*="/in/"] span[aria-hidden="true"], a[href*="/company/"] span[aria-hidden="true"]',
      take: "text",
      firstLine: true,
    },
  },
} as const;

/**
 * Best-effort author extraction from a home-feed row's body text. The home
 * feed DOM obfuscates the actor classes, so the selector often misses and the
 * only reliable place the author name appears is the row's body text. This is
 * inherently heuristic — the feed can't use network capture, so there is no
 * structured author field to read.
 */
export function parseHomeFeedAuthor(body: string): string {
  if (!body) return "";
  let text = body.replace(/^feed post\s+/i, "").trim();

  // A repost surfaces the resharer first, then "reposted this", then the
  // original poster whose content this actually is — take the original poster.
  const repostIdx = text.toLowerCase().indexOf("reposted this");
  if (repostIdx !== -1) {
    text = text.slice(repostIdx + "reposted this".length).trim();
  }

  // The author is the leading name before the " • " connection-degree marker.
  const sepIdx = text.indexOf(" • ");
  if (sepIdx === -1) return "";
  let name = text.slice(0, sepIdx).trim();
  // A repost segment puts a relative-time token (e.g. "17h") right after the
  // original poster's name and before the marker — strip it so we keep just
  // the name.
  name = name.replace(/\s+\d+\s*[smhdwy]o?$/i, "").trim();
  return name.slice(0, 60);
}

/**
 * The home feed mixes in ads, suggestions, and non-post noise. These never
 * become useful events, so drop them before emitting. Heuristic by necessity —
 * the home feed has no structured "is this an ad" field over the content-script
 * scrape.
 */
export function isHomeFeedNoise(body: string): boolean {
  if (!body || body.trim().length < 30) return true;
  if (/\bPromoted\b/i.test(body.slice(0, 130))) return true;
  if (/\bSuggested\b/i.test(body.slice(0, 30))) return true;
  return false;
}

/**
 * Map cs_scrape home-feed rows to event envelopes. The componentkey token is
 * not a numeric activity id, so there is no /feed/update permalink — source_url
 * stays at /feed/. Home-feed posts expose no reliable timestamp, so the caller
 * stamps occurred_at with the sync time.
 */
export function buildHomeFeedEvents(
  rows: HomeFeedRow[],
  occurredAt: Date
): EventEnvelope[] {
  const seen = new Set<string>();
  const events: EventEnvelope[] = [];
  for (const row of rows) {
    if (!row?.id || !row.body || seen.has(row.id)) continue;
    if (isHomeFeedNoise(row.body)) continue;
    seen.add(row.id);
    // The DOM actor span often includes the connection-degree marker
    // ("Julien Hurault • 1st"); strip it the same way body-parse does. Fall
    // back to parsing the name out of the post body when the selector misses.
    const author =
      (row.author ?? "").trim().split(" • ")[0].trim() ||
      parseHomeFeedAuthor(row.body ?? "");
    events.push({
      origin_id: `li_home_${row.id}`,
      payload_text: row.body,
      author_name: author,
      // Feed posts expose no reliable timestamp; use the sync time.
      occurred_at: occurredAt,
      origin_type: "post",
      // Token id is NOT a numeric activity id, so we cannot build a
      // urn:li:activity permalink — link to the feed itself.
      source_url: "https://www.linkedin.com/feed/",
      metadata: { author },
    });
  }
  return events;
}

/**
 * Pull the chrome action dispatcher from sessionState. The connector-worker
 * subprocess (child-runner.ts) splices a live `chrome_dispatcher` object
 * onto every sync's sessionState; the dispatcher's `dispatch()` rides an
 * IPC channel up to the daemon and out to the gateway's
 * /api/workers/dispatch-chrome-action bridge. When no paired Owletto
 * extension is online in the connection's org, the bridge returns the
 * `failed` status and the dispatcher throws — we surface that as the sync
 * failure verbatim.
 */
function requireExtensionDispatcher(ctx: {
  sessionState?: Record<string, unknown> | null;
}): ChromeActionDispatcher {
  const handle = (
    ctx.sessionState as Record<string, unknown> | null | undefined
  )?.chrome_dispatcher as ChromeActionDispatcher | undefined;
  if (!handle || typeof handle.dispatch !== "function") {
    throw new Error(
      "LinkedIn connector requires a paired Owletto Chrome extension. No chrome_dispatcher was injected into sessionState — re-run on a connector-worker that has the dispatcher bridge."
    );
  }
  return handle;
}

export function filterPostsSinceCheckpoint(
  posts: LinkedInPost[],
  checkpoint: LinkedInCheckpoint
): LinkedInPost[] {
  const seenIds = new Set<string>();
  const checkpointPostId = normalizeCheckpointPostId(checkpoint.last_post_id);
  const checkpointTimestamp = checkpoint.last_timestamp
    ? new Date(checkpoint.last_timestamp).getTime()
    : null;

  const filtered: LinkedInPost[] = [];
  for (const post of posts) {
    if (!post.id || !post.text || seenIds.has(post.id)) continue;
    seenIds.add(post.id);

    if (checkpointPostId && post.id === checkpointPostId) break;
    if (
      checkpointTimestamp !== null &&
      post.publishedAt.getTime() <= checkpointTimestamp
    ) {
      continue;
    }

    filtered.push(post);
  }

  return filtered;
}

// ── Voyager API Response Parsers ──────────────────────────────

function parseCompanyUpdates(_url: string, json: unknown): LinkedInPost[] {
  const posts: LinkedInPost[] = [];
  const data = json as any;

  // Build URN lookup from `included` array (LinkedIn GraphQL uses references)
  const included: any[] = data?.included ?? [];
  const byUrn: Record<string, any> = {};
  for (const item of included) {
    const urn = item.entityUrn || item.$id;
    if (urn) byUrn[urn] = item;
  }

  // Find feed elements - LinkedIn nests under data.data with a long key
  const feedRoot = data?.data?.data ?? data?.data ?? data;
  let elements: any[] = [];
  for (const key of Object.keys(feedRoot)) {
    const val = feedRoot[key];
    if (val?.["*elements"] && Array.isArray(val["*elements"])) {
      elements = val["*elements"];
      break;
    }
    if (val?.elements && Array.isArray(val.elements)) {
      elements = val.elements;
      break;
    }
  }

  const resolve = (ref: any) =>
    (typeof ref === "string" ? byUrn[ref] : ref) ?? {};

  for (const ref of elements) {
    const el = resolve(ref);

    // Get commentary text (may be a reference)
    const commentaryObj = resolve(el["*commentary"] ?? el.commentary);
    const textObj = commentaryObj?.text ?? commentaryObj;
    const text = textObj?.text ?? textObj?.attributedText?.text ?? "";
    if (!text) continue;

    // Get actor
    const actorObj = resolve(el["*actor"] ?? el.actor);
    const authorName = actorObj?.name?.text ?? actorObj?.name ?? "Unknown";
    const authorDesc =
      actorObj?.description?.text ?? actorObj?.description ?? undefined;

    // Get social counts
    const socialRef = el["*socialDetail"] ?? el.socialDetail;
    const social = resolve(socialRef);
    const counts =
      social?.totalSocialActivityCounts ??
      social?.socialActivityCountsInsight?.totalSocialActivityCounts ??
      {};

    // Get URN for ID
    const urn = el.entityUrn ?? el["*backendUrn"] ?? "";
    const urnParts = urn.split(":");
    const id =
      urnParts[urnParts.length - 1] ||
      `li_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // Get timestamp
    const metadata = resolve(el["*metadata"] ?? el.metadata);
    const publishedAt = metadata?.publishedAt ?? el.createdAt ?? Date.now();

    posts.push({
      id,
      text,
      author: authorName,
      authorHeadline: typeof authorDesc === "string" ? authorDesc : undefined,
      likes: counts.numLikes ?? 0,
      comments: counts.numComments ?? 0,
      shares: counts.numShares ?? 0,
      publishedAt: new Date(publishedAt),
    });
  }

  return posts;
}

function parseJobListings(_url: string, json: unknown): LinkedInJob[] {
  const jobs: LinkedInJob[] = [];
  const data = json as any;

  const elements = data?.elements ?? data?.data?.elements ?? [];

  for (const element of elements) {
    const jobPosting = element?.jobPosting ?? element;
    const title = jobPosting?.title ?? element?.title ?? "";
    if (!title) continue;

    const urnParts = (
      jobPosting?.entityUrn ??
      element?.dashEntityUrn ??
      ""
    ).split(":");
    const id =
      urnParts[urnParts.length - 1] ||
      `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    jobs.push({
      id,
      title,
      location: jobPosting?.formattedLocation ?? jobPosting?.location ?? "",
      postedAt: new Date(
        jobPosting?.listedAt ?? element?.createdAt ?? Date.now()
      ),
      url: `https://www.linkedin.com/jobs/view/${id}`,
      description: jobPosting?.description?.text ?? undefined,
    });
  }

  return jobs;
}

// ── Config Schemas ────────────────────────────────────────────

const companyUpdatesConfigSchema = {
  type: "object",
  required: ["company_url"],
  properties: {
    company_url: {
      type: "string",
      description:
        'LinkedIn company page URL (e.g., "https://www.linkedin.com/company/openai")',
    },
    max_scrolls: {
      type: "integer",
      minimum: 1,
      maximum: 20,
      default: 5,
      description: "Maximum scroll iterations for pagination (default: 5)",
    },
  },
};

const homeFeedConfigSchema = {
  type: "object",
  properties: {
    max_scrolls: {
      type: "integer",
      minimum: 1,
      maximum: 30,
      default: 8,
      description: "Maximum scroll iterations for the home feed (default: 8)",
    },
  },
};

const jobsConfigSchema = {
  type: "object",
  required: ["company_url"],
  properties: {
    company_url: {
      type: "string",
      description:
        'LinkedIn company page URL (e.g., "https://www.linkedin.com/company/openai")',
    },
    max_scrolls: {
      type: "integer",
      minimum: 1,
      maximum: 10,
      default: 3,
      description: "Maximum scroll iterations for job listings (default: 3)",
    },
  },
};

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

// ── Connector ─────────────────────────────────────────────────

export default class LinkedInConnector extends ConnectorRuntime<
  LinkedInCheckpoint,
  LinkedInConfig
> {
  readonly definition: ConnectorDefinition = {
    key: "linkedin",
    name: "LinkedIn",
    description:
      "Scrapes LinkedIn (home feed, company pages, hiring signals) via the paired Owletto Chrome extension, and ingests local LinkedIn Data Export CSV files.",
    version: "3.0.0",
    faviconDomain: "linkedin.com",
    authSchema: {
      methods: [
        {
          type: "none",
        },
        {
          type: "oauth",
          provider: "linkedin",
          requiredScopes: ["openid", "profile", "email"],
          loginScopes: ["openid", "profile", "email"],
          authorizationUrl: "https://www.linkedin.com/oauth/v2/authorization",
          tokenUrl: "https://www.linkedin.com/oauth/v2/accessToken",
          userinfoUrl: "https://api.linkedin.com/v2/userinfo",
          tokenEndpointAuthMethod: "client_secret_post",
          clientIdKey: "LINKEDIN_CLIENT_ID",
          clientSecretKey: "LINKEDIN_CLIENT_SECRET",
          description:
            "Optional LinkedIn OAuth app config for sign-in. Current company page and jobs feeds run via the Chrome extension; OAuth is here for downstream sign-in flows.",
          setupInstructions:
            "Create a LinkedIn OAuth app, add {{redirect_uri}} as the callback URL, then paste the client ID and client secret below.",
        },
      ],
    },
    feeds: {
      // ── Live (Chrome-extension) feeds ──────────────────────────
      home_feed: {
        key: "home_feed",
        name: "Home Feed",
        description: "Your personalized LinkedIn home feed.",
        configSchema: homeFeedConfigSchema,
        eventKinds: {
          post: {
            description: "A post from your personalized LinkedIn home feed",
            metadataSchema: {
              type: "object",
              properties: {
                author: { type: "string" },
              },
            },
          },
        },
      },
      company_updates: {
        key: "company_updates",
        name: "Company Updates",
        description: "Posts and updates from the company LinkedIn page.",
        configSchema: companyUpdatesConfigSchema,
        eventKinds: {
          post: {
            description: "A company LinkedIn post",
            metadataSchema: {
              type: "object",
              properties: {
                author_headline: { type: "string" },
                likes: { type: "number" },
                comments: { type: "number" },
                shares: { type: "number" },
              },
            },
          },
        },
      },
      jobs: {
        key: "jobs",
        name: "Job Listings",
        description: "Open job positions (hiring velocity signal).",
        configSchema: jobsConfigSchema,
        eventKinds: {
          job_posting: {
            description: "An open job listing",
            metadataSchema: {
              type: "object",
              properties: {
                location: { type: "string" },
              },
            },
          },
        },
      },
      // ── Takeout (local CSV) feeds ──────────────────────────────
      messages: {
        key: "messages",
        name: "Messages",
        configSchema: localTakeoutSchema(
          "Path to the LinkedIn Data Export folder."
        ),
        eventKinds: {
          message: {
            description: "A LinkedIn direct message",
            attributions: LINKEDIN_MESSAGE_ATTRIBUTIONS,
          },
        },
      },
      connections: {
        key: "connections",
        name: "Connections",
        configSchema: localTakeoutSchema(
          "Path to the LinkedIn Data Export folder."
        ),
        eventKinds: {
          connection: {
            description: "A first-degree LinkedIn connection",
            attributions: LINKEDIN_CONNECTION_ATTRIBUTIONS,
          },
        },
      },
      invitations: {
        key: "invitations",
        name: "Invitations",
        configSchema: localTakeoutSchema(
          "Path to the LinkedIn Data Export folder."
        ),
      },
      applied_jobs: {
        key: "applied_jobs",
        name: "Applied Jobs",
        description:
          "Your own applied/saved job postings from the LinkedIn Data Export.",
        configSchema: localTakeoutSchema(
          "Path to the LinkedIn Data Export folder."
        ),
      },
      profile: {
        key: "profile",
        name: "Profile",
        configSchema: localTakeoutSchema(
          "Path to the LinkedIn Data Export folder."
        ),
      },
      companies: {
        key: "companies",
        name: "Company Follows",
        configSchema: localTakeoutSchema(
          "Path to the LinkedIn Data Export folder."
        ),
      },
      learning: {
        key: "learning",
        name: "Learning",
        configSchema: localTakeoutSchema(
          "Path to the LinkedIn Data Export folder."
        ),
      },
      events: {
        key: "events",
        name: "Events",
        configSchema: localTakeoutSchema(
          "Path to the LinkedIn Data Export folder."
        ),
      },
      endorsements: {
        key: "endorsements",
        name: "Endorsements and Recommendations",
        configSchema: localTakeoutSchema(
          "Path to the LinkedIn Data Export folder."
        ),
      },
      media: {
        key: "media",
        name: "Rich Media",
        configSchema: localTakeoutSchema(
          "Path to the LinkedIn Data Export folder."
        ),
      },
    },
  };

  async sync(
    ctx: SyncContext<LinkedInCheckpoint, LinkedInConfig>
  ): Promise<SyncResult<LinkedInCheckpoint>> {
    const feedKey = ctx.feedKey;

    // ── Live (Chrome-extension) feeds ────────────────────────────
    if (
      feedKey === "home_feed" ||
      feedKey === "company_updates" ||
      feedKey === "jobs"
    ) {
      return this.syncLive(ctx);
    }

    // ── Takeout (local CSV) feeds ────────────────────────────────
    const takeoutDir = assertDirectory(ctx.config, "LinkedIn");
    const max = batchSize(ctx.config);

    if (feedKey === "messages") {
      return this.result(
        ctx,
        "last_messages_timestamp",
        this.readMessages(takeoutDir),
        max
      );
    }
    if (feedKey === "connections") {
      return this.result(
        ctx,
        "last_connections_timestamp",
        this.readConnections(takeoutDir),
        max
      );
    }
    if (feedKey === "invitations") {
      return this.result(
        ctx,
        "last_invitations_timestamp",
        this.readInvitations(takeoutDir),
        max
      );
    }
    if (feedKey === "applied_jobs") {
      return this.result(
        ctx,
        "last_applied_jobs_timestamp",
        this.readJobs(takeoutDir),
        max
      );
    }
    if (feedKey === "profile") {
      return this.result(
        ctx,
        "last_profile_timestamp",
        this.readProfile(takeoutDir),
        max
      );
    }
    if (feedKey === "companies") {
      return this.result(
        ctx,
        "last_companies_timestamp",
        this.readCompanyFollows(takeoutDir),
        max
      );
    }
    if (feedKey === "learning") {
      return this.result(
        ctx,
        "last_learning_timestamp",
        this.readLearning(takeoutDir),
        max
      );
    }
    if (feedKey === "events") {
      return this.result(
        ctx,
        "last_events_timestamp",
        this.readEvents(takeoutDir),
        max
      );
    }
    if (feedKey === "endorsements") {
      return this.result(
        ctx,
        "last_endorsements_timestamp",
        this.readEndorsements(takeoutDir),
        max
      );
    }
    if (feedKey === "media") {
      return this.result(
        ctx,
        "last_media_timestamp",
        this.readRichMedia(takeoutDir),
        max
      );
    }

    throw new Error(`Unknown LinkedIn feed: ${feedKey}`);
  }

  // ── Live scrape dispatch ─────────────────────────────────────

  private async syncLive(
    ctx: SyncContext<LinkedInCheckpoint, LinkedInConfig>
  ): Promise<SyncResult<LinkedInCheckpoint>> {
    const config = ctx.config;
    const checkpoint = (ctx.checkpoint ?? {}) as LinkedInCheckpoint;
    const feedKey = ctx.feedKey;

    // home_feed is the one feed that needs a content-script scrape (the CDP
    // debugger stops the personalized feed from rendering) and takes no
    // company_url — it always reads linkedin.com/feed/.
    if (feedKey === "home_feed") {
      const homeScrolls = config.max_scrolls ?? 8;
      return this.syncHomeFeed(
        homeScrolls,
        checkpoint,
        requireExtensionDispatcher(ctx)
      );
    }

    const companyUrl = config.company_url;
    if (!companyUrl) {
      throw new Error("company_url is required");
    }

    // Normalize URL - remove trailing slash
    const baseUrl = companyUrl.replace(/\/$/, "");
    const maxScrolls = config.max_scrolls ?? (feedKey === "jobs" ? 3 : 5);

    const dispatcher = requireExtensionDispatcher(ctx);
    if (feedKey === "jobs") {
      return this.syncJobs(baseUrl, maxScrolls, checkpoint, dispatcher);
    }
    return this.syncUpdates(baseUrl, maxScrolls, checkpoint, dispatcher);
  }

  /**
   * Personalized home feed via the extension's content-script scrape. Network
   * capture can't read it (the CDP debugger stops the feed rendering), so we
   * dispatch a `cs_scrape` against linkedin.com/feed/ with the home-feed
   * selectors. The persistent window is reused/focused so an auth wall can be
   * cleared in place for the next run.
   */
  private async syncHomeFeed(
    maxScrolls: number,
    checkpoint: LinkedInCheckpoint,
    dispatcher: ChromeActionDispatcher
  ): Promise<SyncResult<LinkedInCheckpoint>> {
    const { items: rows, loggedIn } = await extensionDomScrape<HomeFeedRow>({
      dispatcher,
      url: "https://www.linkedin.com/feed/",
      config: {
        ...HOME_FEED_SCRAPE_CONFIG,
        scroll: { ...HOME_FEED_SCRAPE_CONFIG.scroll, max: maxScrolls },
      },
      parseRows: (raw) => raw as HomeFeedRow[],
      allowedOrigins: LINKEDIN_ALLOWED_ORIGINS,
    });

    if (!loggedIn) {
      throw new Error(
        "Not logged into LinkedIn. The home feed could not be read — sign in to LinkedIn in the focused Owletto window, then re-run the sync."
      );
    }

    const events = buildHomeFeedEvents(rows, new Date());

    return {
      events,
      // The home feed exposes no stable per-post cursor (opaque token ids, no
      // timestamps), so there is nothing new to checkpoint — pass it through.
      checkpoint,
      metadata: {
        items_found: events.length,
        items_scraped: rows.length,
        backend: "extension-cs-scrape",
      },
    };
  }

  private async syncUpdates(
    baseUrl: string,
    maxScrolls: number,
    checkpoint: LinkedInCheckpoint,
    dispatcher: ChromeActionDispatcher
  ): Promise<SyncResult<LinkedInCheckpoint>> {
    const postsUrl = `${baseUrl}/posts/`;
    const result = await extensionNetworkSync<LinkedInPost>({
      dispatcher,
      url: postsUrl,
      config: {
        interceptPatterns: [
          {
            regex: "voyager/api/graphql\\?variables=.*ORGANIZATION_MEMBER_FEED",
          },
          { regex: "voyager/api/graphql\\?variables=.*organizationalPageUrn" },
        ],
        allowedOrigins: ["linkedin.com", "*.linkedin.com"],
        maxScrolls,
        scrollDelayMs: 3000,
        responseTimeoutMs: 8000,
      },
      parseResponse: parseCompanyUpdates,
      checkAuth: (currentUrl) =>
        !currentUrl.includes("/login") && !currentUrl.includes("/authwall"),
    });

    const posts = filterPostsSinceCheckpoint(result.items, checkpoint);
    const events: EventEnvelope[] = posts.map((post) => ({
      origin_id: `li_post_${post.id}`,
      payload_text: post.text,
      author_name: post.author,
      occurred_at: post.publishedAt,
      origin_type: "post",
      source_url: `https://www.linkedin.com/feed/update/urn:li:activity:${post.id}`,
      score: calculateEngagementScore("linkedin", {
        upvotes: post.likes,
        reply_count: post.comments,
      }),
      metadata: {
        author_headline: post.authorHeadline,
        likes: post.likes,
        comments: post.comments,
        shares: post.shares,
      },
    }));
    events.sort(
      (a, b) =>
        new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime()
    );

    return {
      events,
      checkpoint: {
        ...checkpoint,
        last_post_id: posts[0]?.id ?? checkpoint.last_post_id,
        last_timestamp:
          events[0]?.occurred_at?.toISOString?.() ?? checkpoint.last_timestamp,
      },
      // No cookie persistence — auth lives in the user's signed-in Chrome,
      // not in our cookie cache.
      metadata: {
        items_found: events.length,
        items_skipped: result.items.length - posts.length,
        api_calls: result.apiCallCount,
        backend: "extension",
      },
    };
  }

  private async syncJobs(
    baseUrl: string,
    maxScrolls: number,
    checkpoint: LinkedInCheckpoint,
    dispatcher: ChromeActionDispatcher
  ): Promise<SyncResult<LinkedInCheckpoint>> {
    const jobsUrl = `${baseUrl}/jobs/`;
    const result = await extensionNetworkSync<LinkedInJob>({
      dispatcher,
      url: jobsUrl,
      config: {
        interceptPatterns: [
          { regex: "voyager/api/graphql.*jobPosting", flags: "i" },
          { regex: "voyager/api/search/dash/.*jobs", flags: "i" },
          { regex: "voyager/api/organization/.*jobs", flags: "i" },
        ],
        allowedOrigins: ["linkedin.com", "*.linkedin.com"],
        maxScrolls,
        scrollDelayMs: 3000,
        responseTimeoutMs: 8000,
      },
      parseResponse: parseJobListings,
      checkAuth: (currentUrl) =>
        !currentUrl.includes("/login") && !currentUrl.includes("/authwall"),
    });

    const seenIds = new Set<string>();
    const jobs = result.items.filter((j) => {
      if (!j.id || seenIds.has(j.id)) return false;
      seenIds.add(j.id);
      return true;
    });
    jobs.sort((a, b) => b.postedAt.getTime() - a.postedAt.getTime());

    const events: EventEnvelope[] = jobs.map((job) => ({
      origin_id: `li_job_${job.id}`,
      payload_text: job.description ?? job.title,
      title: job.title,
      occurred_at: job.postedAt,
      origin_type: "job_posting",
      source_url: job.url,
      metadata: { location: job.location },
    }));

    return {
      events,
      checkpoint: {
        ...checkpoint,
        last_job_id: jobs[0]?.id ?? checkpoint.last_job_id,
        last_timestamp:
          jobs[0]?.postedAt?.toISOString?.() ?? checkpoint.last_timestamp,
      },
      metadata: {
        items_found: events.length,
        api_calls: result.apiCallCount,
        backend: "extension",
      },
    };
  }

  // ── Takeout (local CSV) readers ──────────────────────────────

  private result(
    ctx: SyncContext<LinkedInCheckpoint, LinkedInConfig>,
    key: keyof LinkedInCheckpoint,
    allEvents: EventEnvelope[],
    max: number
  ): SyncResult<LinkedInCheckpoint> {
    const events = takeBatch(allEvents, ctx.checkpoint?.[key], max);
    return {
      events,
      checkpoint: {
        ...ctx.checkpoint,
        [key]: maxEventCursor(events, ctx.checkpoint?.[key]),
      },
    };
  }

  private readMessages(takeoutDir: string): EventEnvelope[] {
    return readCsv(takeoutDir, "messages.csv").flatMap((row) => {
      const occurredAt = parseLinkedInDate(row.DATE);
      const content = row.CONTENT?.trim();
      if (!occurredAt || !content) return [];
      return [
        {
          origin_id: stableId("li_message", [
            row["CONVERSATION ID"],
            row.DATE,
            row.FROM,
            row.TO,
            content,
          ]),
          origin_type: "message",
          occurred_at: occurredAt,
          payload_text: content,
          author_name: row.FROM,
          source_url: row["SENDER PROFILE URL"],
          title: row["CONVERSATION TITLE"] || row.SUBJECT,
          metadata: {
            platform: "linkedin",
            conversation_id: row["CONVERSATION ID"],
            conversation_title: row["CONVERSATION TITLE"],
            from: row.FROM,
            sender_profile_url: row["SENDER PROFILE URL"],
            sender_linkedin_slug:
              normalizeLinkedInSlug(row["SENDER PROFILE URL"]) ?? undefined,
            to: row.TO,
            recipient_profile_urls: row["RECIPIENT PROFILE URLS"],
            subject: row.SUBJECT,
            folder: row.FOLDER,
            attachments: row.ATTACHMENTS,
          },
        },
      ];
    });
  }

  private readConnections(takeoutDir: string): EventEnvelope[] {
    return readCsv(takeoutDir, "Connections.csv").flatMap((row) => {
      const fullName = [row["First Name"], row["Last Name"]]
        .filter(Boolean)
        .join(" ")
        .trim();
      const occurredAt = parseLinkedInDate(row["Connected On"]);
      if (!fullName || !occurredAt) return [];
      return [
        {
          origin_id: stableId("li_connection", [
            row.URL,
            fullName,
            row["Connected On"],
          ]),
          origin_type: "connection",
          occurred_at: occurredAt,
          payload_text: `Connected with ${fullName}${row.Company ? ` at ${row.Company}` : ""}`,
          author_name: fullName,
          source_url: row.URL,
          metadata: {
            platform: "linkedin",
            first_name: row["First Name"],
            last_name: row["Last Name"],
            email: row["Email Address"],
            company: row.Company,
            position: row.Position,
            linkedin_url: row.URL,
            // Pre-canonicalized identity key. The server never loads example
            // connectors' normalizer modules, so we emit the already-lowercased
            // /in/<slug> here; the engine stores it verbatim (trim fallback) and
            // case-variant URLs from any source collapse to one entity.
            linkedin_slug: normalizeLinkedInSlug(row.URL) ?? undefined,
          },
        },
      ];
    });
  }

  private readInvitations(takeoutDir: string): EventEnvelope[] {
    return readCsv(takeoutDir, "Invitations.csv").flatMap((row) => {
      const occurredAt = parseLinkedInDate(
        row["Sent At"] || row["Received At"] || row.Date
      );
      const name =
        row.To ||
        row.From ||
        row.Name ||
        row["Invitee Name"] ||
        row["Inviter Name"];
      if (!occurredAt || !name) return [];
      return [
        {
          origin_id: stableId("li_invitation", [
            name,
            row["Sent At"],
            row["Received At"],
            row.Message,
          ]),
          origin_type: "invitation",
          occurred_at: occurredAt,
          payload_text: row.Message || `LinkedIn invitation: ${name}`,
          author_name: row.From,
          metadata: {
            platform: "linkedin",
            from: row.From,
            to: row.To,
            name,
            sent_at: row["Sent At"],
            received_at: row["Received At"],
            message: row.Message,
            invitation_type: row["Invitation Type"],
          },
        },
      ];
    });
  }

  private readJobs(takeoutDir: string): EventEnvelope[] {
    return readCsv(
      takeoutDir,
      path.join("Jobs", "Online Job Postings.csv")
    ).flatMap((row) => {
      const occurredAt =
        parseLinkedInDate(
          row["Create Date"] || row["List Date"] || row["Close Date"]
        ) ?? snapshotDate();
      const title = row.Title || row["Job Title"] || row.Position;
      const company = row["Company Name"] || row.Company;
      const sourceUrl = row["Company Apply Url"] || row.URL;
      if (!title) return [];
      return [
        {
          origin_id: stableId("li_job", [
            title,
            company,
            row["Create Date"],
            sourceUrl,
          ]),
          origin_type: "job_posting",
          occurred_at: occurredAt,
          payload_text: [
            title,
            company,
            row["Location Description"],
            stripHtml(row["Job Description"] ?? ""),
          ]
            .filter(Boolean)
            .join("\n"),
          title,
          source_url: sourceUrl,
          metadata: {
            platform: "linkedin",
            title,
            company,
            employment_status: row["Employment Status"],
            location: row["Location Description"],
            job_functions: row["Job Functions"],
            industries: row["Company Industries"],
            seniority: row["Seniority Level"],
            required_skills: row["Required Skills"],
            education_levels: row["Education Levels"],
            onsite_apply: row["Onsite Apply"],
            contact_email: row["Contact Email"],
            base_salary: row["Base Salary"],
            additional_compensation: row["Additional Compensation"],
            job_state: row["Job State"],
            create_date: row["Create Date"],
            list_date: row["List Date"],
            close_date: row["Close Date"],
            expiration_date: row["Expiration Date"],
            url: sourceUrl,
          },
        },
      ];
    });
  }

  private readProfile(takeoutDir: string): EventEnvelope[] {
    const profile = readCsv(takeoutDir, "Profile.csv")[0];
    const profileEvents: EventEnvelope[] = profile
      ? [
          {
            origin_id: stableId("li_profile", [
              profile["First Name"],
              profile["Last Name"],
              profile.Headline,
              profile["Geo Location"],
            ]),
            origin_type: "profile",
            occurred_at: snapshotDate(),
            payload_text: [
              [profile["First Name"], profile["Last Name"]]
                .filter(Boolean)
                .join(" "),
              profile.Headline,
              profile.Summary,
              profile.Industry,
              profile["Geo Location"],
            ]
              .filter(Boolean)
              .join("\n"),
            title: profile.Headline,
            metadata: {
              platform: "linkedin",
              first_name: profile["First Name"],
              last_name: profile["Last Name"],
              headline: profile.Headline,
              summary: profile.Summary,
              industry: profile.Industry,
              location: profile["Geo Location"],
              websites: profile.Websites,
              twitter_handles: profile["Twitter Handles"],
            },
          },
        ]
      : [];

    const positions = readCsv(takeoutDir, "Positions.csv").flatMap((row) => {
      const title = row.Title;
      const company = row["Company Name"];
      if (!title && !company) return [];
      return [
        {
          origin_id: stableId("li_position", [
            company,
            title,
            row["Started On"],
            row["Finished On"],
          ]),
          origin_type: "position",
          occurred_at: parseLinkedInDate(row["Started On"]) ?? snapshotDate(),
          payload_text: [title, company, row.Location, row.Description]
            .filter(Boolean)
            .join("\n"),
          title: [title, company].filter(Boolean).join(" at "),
          metadata: {
            platform: "linkedin",
            company,
            title,
            description: row.Description,
            location: row.Location,
            started_on: row["Started On"],
            finished_on: row["Finished On"],
          },
        },
      ];
    });

    const education = readCsv(takeoutDir, "Education.csv").flatMap((row) => {
      const school = row["School Name"];
      if (!school) return [];
      return [
        {
          origin_id: stableId("li_education", [
            school,
            row["Degree Name"],
            row["Start Date"],
            row["End Date"],
          ]),
          origin_type: "education",
          occurred_at: parseLinkedInDate(row["Start Date"]) ?? snapshotDate(),
          payload_text: [school, row["Degree Name"], row.Activities, row.Notes]
            .filter(Boolean)
            .join("\n"),
          title: [row["Degree Name"], school].filter(Boolean).join(" - "),
          metadata: {
            platform: "linkedin",
            school,
            degree: row["Degree Name"],
            start_date: row["Start Date"],
            end_date: row["End Date"],
            activities: row.Activities,
            notes: row.Notes,
          },
        },
      ];
    });

    const skills = readCsv(takeoutDir, "Skills.csv").flatMap((row) => {
      if (!row.Name) return [];
      return [
        {
          origin_id: stableId("li_skill", [row.Name]),
          origin_type: "skill",
          occurred_at: snapshotDate(),
          payload_text: row.Name,
          title: row.Name,
          metadata: { platform: "linkedin", skill: row.Name },
        },
      ];
    });

    return [...profileEvents, ...positions, ...education, ...skills];
  }

  private readCompanyFollows(takeoutDir: string): EventEnvelope[] {
    return readCsv(takeoutDir, "Company Follows.csv").flatMap((row) => {
      const organization = row.Organization;
      const occurredAt = parseLinkedInDate(row["Followed On"]);
      if (!organization || !occurredAt) return [];
      return [
        {
          origin_id: stableId("li_company_follow", [
            organization,
            row["Followed On"],
          ]),
          origin_type: "company_follow",
          occurred_at: occurredAt,
          payload_text: `Followed ${organization}`,
          title: organization,
          metadata: {
            platform: "linkedin",
            organization,
            followed_on: row["Followed On"],
          },
        },
      ];
    });
  }

  private readLearning(takeoutDir: string): EventEnvelope[] {
    return readCsv(takeoutDir, "Learning.csv").flatMap((row) => {
      const title = row["Content Title"];
      if (!title) return [];
      const occurredAt =
        parseLinkedInDate(row["Content Completed At (if completed)"]) ??
        parseLinkedInDate(row["Content Last Watched Date (if viewed)"]) ??
        snapshotDate();
      return [
        {
          origin_id: stableId("li_learning", [
            title,
            row["Content Last Watched Date (if viewed)"],
            row["Content Completed At (if completed)"],
          ]),
          origin_type: "learning",
          occurred_at: occurredAt,
          payload_text: [
            title,
            row["Content Description"],
            row["Notes taken on videos (if taken)"],
          ]
            .filter(Boolean)
            .join("\n"),
          title,
          metadata: {
            platform: "linkedin",
            content_type: row["Content Type"],
            last_watched_at: row["Content Last Watched Date (if viewed)"],
            completed_at: row["Content Completed At (if completed)"],
            saved: row["Content Saved"],
          },
        },
      ];
    });
  }

  private readEvents(takeoutDir: string): EventEnvelope[] {
    return readCsv(takeoutDir, "Events.csv").flatMap((row) => {
      const name = row["Event Name"];
      if (!name) return [];
      return [
        {
          origin_id: stableId("li_event", [name, row["Event Time"]]),
          origin_type: "event",
          occurred_at:
            parseLinkedInDateStart(row["Event Time"]) ?? snapshotDate(),
          payload_text: [name, row.Status, row["External Url"]]
            .filter(Boolean)
            .join("\n"),
          title: name,
          source_url: row["External Url"],
          metadata: {
            platform: "linkedin",
            event_time: row["Event Time"],
            status: row.Status,
            external_url: row["External Url"],
          },
        },
      ];
    });
  }

  private readEndorsements(takeoutDir: string): EventEnvelope[] {
    const given = readCsv(takeoutDir, "Endorsement_Given_Info.csv").flatMap(
      (row) =>
        this.endorsementEvent({
          row,
          direction: "given",
          person: [row["Endorsee First Name"], row["Endorsee Last Name"]]
            .filter(Boolean)
            .join(" "),
          url: row["Endorsee Public Url"],
        })
    );
    const received = readCsv(
      takeoutDir,
      "Endorsement_Received_Info.csv"
    ).flatMap((row) =>
      this.endorsementEvent({
        row,
        direction: "received",
        person: [row["Endorser First Name"], row["Endorser Last Name"]]
          .filter(Boolean)
          .join(" "),
        url: row["Endorser Public Url"],
      })
    );
    const recommendations = readCsv(
      takeoutDir,
      "Recommendations_Given.csv"
    ).flatMap((row) => {
      const person = [row["First Name"], row["Last Name"]]
        .filter(Boolean)
        .join(" ");
      const occurredAt = parseLinkedInDate(row["Creation Date"]);
      if (!person || !occurredAt) return [];
      return [
        {
          origin_id: stableId("li_recommendation_given", [
            person,
            row.Company,
            row["Creation Date"],
            row.Text,
          ]),
          origin_type: "recommendation_given",
          occurred_at: occurredAt,
          payload_text: row.Text,
          author_name: person,
          title: `Recommendation for ${person}`,
          metadata: {
            platform: "linkedin",
            person,
            company: row.Company,
            job_title: row["Job Title"],
            status: row.Status,
            creation_date: row["Creation Date"],
          },
        },
      ];
    });
    return [...given, ...received, ...recommendations];
  }

  private endorsementEvent(params: {
    row: Record<string, string>;
    direction: "given" | "received";
    person: string;
    url?: string;
  }): EventEnvelope[] {
    const occurredAt = parseLinkedInDate(params.row["Endorsement Date"]);
    if (!params.person || !occurredAt) return [];
    return [
      {
        origin_id: stableId(`li_endorsement_${params.direction}`, [
          params.person,
          params.row["Skill Name"],
          params.row["Endorsement Date"],
        ]),
        origin_type: `endorsement_${params.direction}`,
        occurred_at: occurredAt,
        payload_text: `${params.direction} endorsement: ${params.row["Skill Name"]} - ${params.person}`,
        author_name: params.person,
        source_url: params.url?.startsWith("http")
          ? params.url
          : params.url
            ? `https://${params.url}`
            : undefined,
        metadata: {
          platform: "linkedin",
          direction: params.direction,
          person: params.person,
          skill: params.row["Skill Name"],
          status: params.row["Endorsement Status"],
          endorsement_date: params.row["Endorsement Date"],
        },
      },
    ];
  }

  private readRichMedia(takeoutDir: string): EventEnvelope[] {
    return readCsv(takeoutDir, "Rich_Media.csv").flatMap((row) => {
      const occurredAt = parseLinkedInMediaDate(row["Date/Time"]);
      if (!row["Media Link"]) return [];
      return [
        {
          origin_id: stableId("li_rich_media", [
            row["Date/Time"],
            row["Media Link"],
          ]),
          origin_type: "media",
          occurred_at: occurredAt ?? snapshotDate(),
          payload_text: [row["Date/Time"], row["Media Description"]]
            .filter(Boolean)
            .join("\n"),
          title: row["Media Description"],
          source_url: row["Media Link"],
          metadata: {
            platform: "linkedin",
            date_time: row["Date/Time"],
            media_description: row["Media Description"],
            media_link: row["Media Link"],
          },
        },
      ];
    });
  }
}

// ── Takeout CSV helpers ────────────────────────────────────────

function readCsv(
  takeoutDir: string,
  relativePath: string
): Record<string, string>[] {
  const filePath = path.join(takeoutDir, relativePath);
  if (!existsSync(filePath)) return [];
  return parseCsv(readFileSync(filePath, "utf8"));
}

function parseLinkedInDate(input?: string): Date | undefined {
  if (!input || input === "N/A") return undefined;
  const normalized = input.endsWith(" UTC")
    ? input.replace(" UTC", "Z")
    : input;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function parseLinkedInDateStart(input?: string): Date | undefined {
  return parseLinkedInDate(input?.split(" - ")[0]);
}

function parseLinkedInMediaDate(input?: string): Date | undefined {
  if (!input) return undefined;
  const match = input.match(
    /on ([A-Z][a-z]+ \d{1,2}, \d{4}) at (\d{1,2}:\d{2} [AP]M)/
  );
  return parseLinkedInDate(match ? `${match[1]} ${match[2]}` : input);
}

function snapshotDate(): Date {
  return new Date("1970-01-02T00:00:00.000Z");
}

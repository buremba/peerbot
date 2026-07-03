/**
 * Per-platform connection config Zod schemas (with OpenAPI annotations and
 * the `platform` literal discriminator for the API layer).
 *
 * Field definitions mirror @lobu/core platform schemas; the gateway adds
 * `.openapi()` metadata. Single registry for every route module that needs
 * to validate or document a platform connection config.
 */

import { z } from "@hono/zod-openapi";

// Telegram bot tokens have the shape `<numeric-id>:<35-char-base62-ish>`.
// Reject anything else early so a typo'd token doesn't get persisted and
// then crash the adapter at runtime with a confusing 401 from Telegram.
const TELEGRAM_BOT_TOKEN_RE = /^\d{6,12}:[A-Za-z0-9_-]{30,}$/;

const TelegramConfigSchema = z.object({
  platform: z.literal("telegram"),
  botToken: z
    .string()
    .refine((value) => value === "" || TELEGRAM_BOT_TOKEN_RE.test(value), {
      message:
        "Telegram bot token must look like '<digits>:<35+ char alphanumeric>' (the format BotFather returns)",
    })
    .optional()
    .openapi({
      description:
        "Telegram bot token from BotFather. Falls back to TELEGRAM_BOT_TOKEN env var.",
    }),
  mode: z.enum(["auto", "webhook", "polling"]).optional().openapi({
    description: "Runtime mode: auto (default), webhook, or polling.",
  }),
  secretToken: z.string().optional().openapi({
    description:
      "Webhook secret token for x-telegram-bot-api-secret-token verification.",
  }),
  userName: z
    .string()
    .optional()
    .openapi({ description: "Override bot username." }),
  apiBaseUrl: z
    .string()
    .optional()
    .openapi({ description: "Custom Telegram API base URL." }),
});

const SlackConfigSchema = z.object({
  platform: z.literal("slack"),
  botToken: z.string().optional().openapi({
    description: "Bot token (xoxb-...). Required for single-workspace mode.",
  }),
  botUserId: z.string().optional().openapi({
    description: "Bot user ID (fetched automatically if omitted).",
  }),
  signingSecret: z
    .string()
    .optional()
    .openapi({ description: "Signing secret for webhook verification." }),
  clientId: z.string().optional().openapi({
    description: "Slack app client ID (required for OAuth / multi-workspace).",
  }),
  clientSecret: z.string().optional().openapi({
    description:
      "Slack app client secret (required for OAuth / multi-workspace).",
  }),
  encryptionKey: z.string().optional().openapi({
    description:
      "Base64-encoded 32-byte AES-256-GCM key for encrypting stored bot tokens.",
  }),
  installationKeyPrefix: z.string().optional().openapi({
    description:
      "State key prefix for workspace installations (default: slack:installation).",
  }),
  userName: z
    .string()
    .optional()
    .openapi({ description: "Override bot username." }),
});

const DiscordConfigSchema = z.object({
  platform: z.literal("discord"),
  botToken: z
    .string()
    .optional()
    .openapi({ description: "Discord bot token." }),
  applicationId: z
    .string()
    .optional()
    .openapi({ description: "Discord application ID." }),
  publicKey: z.string().optional().openapi({
    description: "Application public key for webhook signature verification.",
  }),
  mentionRoleIds: z.array(z.string()).optional().openapi({
    description:
      "Role IDs that trigger mention handlers (in addition to direct mentions).",
  }),
  userName: z
    .string()
    .optional()
    .openapi({ description: "Override bot username." }),
});

const WhatsAppConfigSchema = z.object({
  platform: z.literal("whatsapp"),
  accessToken: z.string().optional().openapi({
    description: "System User access token for WhatsApp Cloud API.",
  }),
  phoneNumberId: z
    .string()
    .optional()
    .openapi({ description: "WhatsApp Business phone number ID." }),
  appSecret: z.string().optional().openapi({
    description:
      "Meta App Secret for webhook HMAC-SHA256 signature verification.",
  }),
  verifyToken: z
    .string()
    .optional()
    .openapi({ description: "Verify token for webhook challenge-response." }),
  apiVersion: z
    .string()
    .optional()
    .openapi({ description: "Meta Graph API version (default: v21.0)." }),
  userName: z.string().optional().openapi({ description: "Bot display name." }),
});

const TeamsConfigSchema = z.object({
  platform: z.literal("teams"),
  appId: z.string().optional().openapi({ description: "Microsoft App ID." }),
  appPassword: z
    .string()
    .optional()
    .openapi({ description: "Microsoft App Password." }),
  appTenantId: z
    .string()
    .optional()
    .openapi({ description: "Microsoft App Tenant ID." }),
  appType: z
    .enum(["MultiTenant", "SingleTenant"])
    .optional()
    .openapi({ description: "Microsoft App Type." }),
  userName: z
    .string()
    .optional()
    .openapi({ description: "Override bot username." }),
});

const GoogleChatConfigSchema = z.object({
  platform: z.literal("gchat"),
  credentials: z.string().optional().openapi({
    description:
      "Service account credentials JSON string. Defaults to GOOGLE_CHAT_CREDENTIALS env var.",
  }),
  useApplicationDefaultCredentials: z.boolean().optional().openapi({
    description:
      "Use Application Default Credentials (ADC) instead of service account JSON.",
  }),
  endpointUrl: z.string().optional().openapi({
    description:
      "HTTP endpoint URL for button click actions. Required for HTTP endpoint apps.",
  }),
  googleChatProjectNumber: z.string().optional().openapi({
    description:
      "Google Cloud project number for verifying webhook JWTs. Defaults to GOOGLE_CHAT_PROJECT_NUMBER env var.",
  }),
  impersonateUser: z.string().optional().openapi({
    description:
      "User email for domain-wide delegation. Defaults to GOOGLE_CHAT_IMPERSONATE_USER env var.",
  }),
  pubsubAudience: z.string().optional().openapi({
    description:
      "Expected audience for Pub/Sub push JWT verification. Defaults to GOOGLE_CHAT_PUBSUB_AUDIENCE env var.",
  }),
  userName: z
    .string()
    .optional()
    .openapi({ description: "Override bot username." }),
});

export const WebhookConfigSchema = z.object({
  platform: z.literal("webhook"),
  token: z.string().optional().openapi({
    description:
      "Bearer token authenticating inbound deliveries. Auto-generated when omitted; stored as a secret:// ref.",
  }),
  // Declarative configs (`lobu apply`) carry string values only, so the
  // boolean also accepts its string spelling.
  allowQueryAuth: z
    .union([z.boolean(), z.enum(["true", "false"])])
    .optional()
    .openapi({
      description:
        "Allow `?token=` auth for senders that cannot set headers (e.g. Sentry's legacy WebHooks plugin). Default false.",
    }),
  dedupeHeader: z.string().optional().openapi({
    description:
      "Request header whose value is the idempotency key (e.g. x-github-delivery). Defaults to sha256 of the raw body.",
  }),
  semanticType: z.string().optional().openapi({
    description: "semantic_type stamped on ingested events. Default: content.",
  }),
  titlePath: z.string().optional().openapi({
    description:
      'JSON pointer into the payload extracted as the event title (e.g. "/event/title").',
  }),
  searchable: z
    .union([z.boolean(), z.enum(["true", "false"])])
    .optional()
    .openapi({
      description:
        "Index ingested payloads into semantic memory (search_memory). Default false: store-only, reachable by watcher SQL.",
    }),
});

/** The HTTP Agent API surface (lobu-ai/lobu#1179). Adapterless: the row is
 * persisted so the scaffolded `{ type: "rest", config: {} }` declaration
 * reconciles under `lobu apply`, but no chat instance is ever created and no
 * credentials exist. */
export const RestConfigSchema = z.object({
  platform: z.literal("rest"),
});

export const PlatformAdapterConfigSchema = z.discriminatedUnion("platform", [
  TelegramConfigSchema,
  SlackConfigSchema,
  DiscordConfigSchema,
  WhatsAppConfigSchema,
  TeamsConfigSchema,
  GoogleChatConfigSchema,
  WebhookConfigSchema,
  RestConfigSchema,
]);

/** Derived from the discriminated union — no separate list to maintain. */
const SUPPORTED_PLATFORMS = PlatformAdapterConfigSchema.options.map(
  (s) => s.shape.platform.value
) as [string, ...string[]];

export const SupportedPlatformSchema = z.enum(SUPPORTED_PLATFORMS);

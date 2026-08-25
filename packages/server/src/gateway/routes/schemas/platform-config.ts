/**
 * Per-platform connection config schemas (TypeBox) with the `platform` literal
 * discriminator for the API layer.
 *
 * Field definitions mirror @lobu/core platform schemas; this adds OpenAPI
 * `description` metadata. Single registry for every route module that needs to
 * validate or document a platform connection config.
 */

import { Type } from "@sinclair/typebox";

// Telegram bot tokens have the shape `<numeric-id>:<35-char-base62-ish>`.
// Reject anything else early so a typo'd token doesn't get persisted and
// then crash the adapter at runtime with a confusing 401 from Telegram.
// Empty string is allowed (falls back to the TELEGRAM_BOT_TOKEN env var), so the
// pattern is `^$ | <token>` — the TypeBox equivalent of the previous Zod
// `.refine(v => v === "" || RE.test(v))`.
const TELEGRAM_BOT_TOKEN_PATTERN = "^$|^\\d{6,12}:[A-Za-z0-9_-]{30,}$";

const TelegramConfigSchema = Type.Object({
	platform: Type.Literal("telegram"),
	botToken: Type.Optional(
		Type.String({
			pattern: TELEGRAM_BOT_TOKEN_PATTERN,
			description:
				"Telegram bot token from BotFather (format '<digits>:<35+ char alphanumeric>'). Falls back to TELEGRAM_BOT_TOKEN env var.",
		}),
	),
	mode: Type.Optional(
		Type.Union(
			[Type.Literal("auto"), Type.Literal("webhook"), Type.Literal("polling")],
			{ description: "Runtime mode: auto (default), webhook, or polling." },
		),
	),
	secretToken: Type.Optional(
		Type.String({
			description:
				"Webhook secret token for x-telegram-bot-api-secret-token verification.",
		}),
	),
	userName: Type.Optional(
		Type.String({ description: "Override bot username." }),
	),
	apiBaseUrl: Type.Optional(
		Type.String({ description: "Custom Telegram API base URL." }),
	),
});

const SlackConfigSchema = Type.Object({
	platform: Type.Literal("slack"),
	botToken: Type.Optional(
		Type.String({
			description: "Bot token (xoxb-...). Required for single-workspace mode.",
		}),
	),
	botUserId: Type.Optional(
		Type.String({
			description: "Bot user ID (fetched automatically if omitted).",
		}),
	),
	signingSecret: Type.Optional(
		Type.String({ description: "Signing secret for webhook verification." }),
	),
	clientId: Type.Optional(
		Type.String({
			description: "Slack app client ID (required for OAuth / multi-workspace).",
		}),
	),
	clientSecret: Type.Optional(
		Type.String({
			description:
				"Slack app client secret (required for OAuth / multi-workspace).",
		}),
	),
	encryptionKey: Type.Optional(
		Type.String({
			description:
				"Base64-encoded 32-byte AES-256-GCM key for encrypting stored bot tokens.",
		}),
	),
	installationKeyPrefix: Type.Optional(
		Type.String({
			description:
				"State key prefix for workspace installations (default: slack:installation).",
		}),
	),
	userName: Type.Optional(
		Type.String({ description: "Override bot username." }),
	),
});

const DiscordConfigSchema = Type.Object({
	platform: Type.Literal("discord"),
	botToken: Type.Optional(Type.String({ description: "Discord bot token." })),
	applicationId: Type.Optional(
		Type.String({ description: "Discord application ID." }),
	),
	publicKey: Type.Optional(
		Type.String({
			description:
				"Application public key for webhook signature verification.",
		}),
	),
	mentionRoleIds: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"Role IDs that trigger mention handlers (in addition to direct mentions).",
		}),
	),
	userName: Type.Optional(
		Type.String({ description: "Override bot username." }),
	),
});

const WhatsAppConfigSchema = Type.Object({
	platform: Type.Literal("whatsapp"),
	accessToken: Type.Optional(
		Type.String({
			description: "System User access token for WhatsApp Cloud API.",
		}),
	),
	phoneNumberId: Type.Optional(
		Type.String({ description: "WhatsApp Business phone number ID." }),
	),
	appSecret: Type.Optional(
		Type.String({
			description:
				"Meta App Secret for webhook HMAC-SHA256 signature verification.",
		}),
	),
	verifyToken: Type.Optional(
		Type.String({
			description: "Verify token for webhook challenge-response.",
		}),
	),
	apiVersion: Type.Optional(
		Type.String({ description: "Meta Graph API version (default: v21.0)." }),
	),
	userName: Type.Optional(Type.String({ description: "Bot display name." })),
});

const TeamsConfigSchema = Type.Object({
	platform: Type.Literal("teams"),
	appId: Type.Optional(Type.String({ description: "Microsoft App ID." })),
	appPassword: Type.Optional(
		Type.String({ description: "Microsoft App Password." }),
	),
	appTenantId: Type.Optional(
		Type.String({ description: "Microsoft App Tenant ID." }),
	),
	appType: Type.Optional(
		Type.Union([Type.Literal("MultiTenant"), Type.Literal("SingleTenant")], {
			description: "Microsoft App Type.",
		}),
	),
	userName: Type.Optional(
		Type.String({ description: "Override bot username." }),
	),
});

const GoogleChatConfigSchema = Type.Object({
	platform: Type.Literal("gchat"),
	credentials: Type.Optional(
		Type.String({
			description:
				"Service account credentials JSON string. Defaults to GOOGLE_CHAT_CREDENTIALS env var.",
		}),
	),
	useApplicationDefaultCredentials: Type.Optional(
		Type.Boolean({
			description:
				"Use Application Default Credentials (ADC) instead of service account JSON.",
		}),
	),
	endpointUrl: Type.Optional(
		Type.String({
			description:
				"HTTP endpoint URL for button click actions. Required for HTTP endpoint apps.",
		}),
	),
	googleChatProjectNumber: Type.Optional(
		Type.String({
			description:
				"Google Cloud project number for verifying webhook JWTs. Defaults to GOOGLE_CHAT_PROJECT_NUMBER env var.",
		}),
	),
	impersonateUser: Type.Optional(
		Type.String({
			description:
				"User email for domain-wide delegation. Defaults to GOOGLE_CHAT_IMPERSONATE_USER env var.",
		}),
	),
	pubsubAudience: Type.Optional(
		Type.String({
			description:
				"Expected audience for Pub/Sub push JWT verification. Defaults to GOOGLE_CHAT_PUBSUB_AUDIENCE env var.",
		}),
	),
	helpCommandId: Type.Optional(
		Type.String({
			pattern: "^(?:[1-9][0-9]{0,2}|1000)$",
			description:
				"Google Chat command ID (1-1000) mapped to this project's registered /lobu command (or legacy /help command).",
		}),
	),
	userName: Type.Optional(
		Type.String({ description: "Override bot username." }),
	),
});

// Declarative configs (`lobu apply`) carry string values only, so booleans also
// accept their string spelling — the TypeBox equivalent of `z.union([boolean,
// enum(["true","false"])])`.
const boolOrString = (description: string) =>
	Type.Union([Type.Boolean(), Type.Literal("true"), Type.Literal("false")], {
		description,
	});

export const WebhookConfigSchema = Type.Object({
	platform: Type.Literal("webhook"),
	token: Type.Optional(
		Type.String({
			description:
				"Bearer token authenticating inbound deliveries. Auto-generated when omitted; stored as a secret:// ref.",
		}),
	),
	allowQueryAuth: Type.Optional(
		boolOrString(
			"Allow `?token=` auth for senders that cannot set headers (e.g. Sentry's legacy WebHooks plugin). Default false.",
		),
	),
	dedupeHeader: Type.Optional(
		Type.String({
			description:
				"Request header whose value is the idempotency key (e.g. x-github-delivery). Defaults to sha256 of the raw body.",
		}),
	),
	semanticType: Type.Optional(
		Type.String({
			description:
				"semantic_type stamped on ingested events. Default: content.",
		}),
	),
	titlePath: Type.Optional(
		Type.String({
			description:
				'JSON pointer into the payload extracted as the event title (e.g. "/event/title").',
		}),
	),
	searchable: Type.Optional(
		boolOrString(
			"Index ingested payloads into semantic memory (search_memory). Default false: store-only, reachable by Automation SQL.",
		),
	),
});

/**
 * The HTTP Agent API surface (lobu-ai/lobu#1179). Adapterless: the row is
 * persisted so the scaffolded `{ type: "rest", config: {} }` declaration
 * reconciles under `lobu apply`, but no chat instance is ever created and no
 * credentials exist.
 */
export const RestConfigSchema = Type.Object({
	platform: Type.Literal("rest"),
});

export const PlatformAdapterConfigSchema = Type.Union([
	TelegramConfigSchema,
	SlackConfigSchema,
	DiscordConfigSchema,
	WhatsAppConfigSchema,
	TeamsConfigSchema,
	GoogleChatConfigSchema,
	WebhookConfigSchema,
	RestConfigSchema,
]);

/** Derived from the union members — no separate list to maintain. */
const SUPPORTED_PLATFORMS = PlatformAdapterConfigSchema.anyOf.map(
	(s) => s.properties.platform.const as string,
) as [string, ...string[]];

export const SupportedPlatformSchema = Type.Union(
	SUPPORTED_PLATFORMS.map((p) => Type.Literal(p)),
);

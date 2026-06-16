/**
 * Single source of truth for the chat platforms `lobu init` can scaffold.
 * Adding a platform means adding one entry here — the init prompts, the
 * `--yes` placeholder config, and the `lobu chat --user` routing all derive
 * from this registry.
 */

interface PlatformField {
  /** Key emitted into the platform config block (e.g. "botToken"). */
  key: string;
  /** Env var the value is stored under; the config references `$ENV_VAR`. */
  envVar: string;
  /** Prompt message shown by `lobu init`. */
  label: string;
  /** Prompt with a masked password input instead of a plain input. */
  secret: boolean;
  /** Include `$ENV_VAR` in the `--yes` placeholder config (default true). */
  placeholder?: boolean;
}

interface PlatformDefinition {
  id: string;
  /** Display name used in the `lobu init` platform picker. */
  displayName: string;
  /** Setup instructions printed (one console.log per line) before prompting. */
  intro?: string[];
  fields: PlatformField[];
  /** Extra literal keys appended to the `--yes` placeholder config. */
  placeholderExtras?: Record<string, string>;
  /**
   * Post-prompt hook for conditional config keys. `values` holds the raw
   * prompt answers per field key (including empty ones); `config` is the
   * platform config built so far and may be extended in place.
   */
  finalize?: (
    config: Record<string, string>,
    values: Record<string, string>
  ) => void;
  /**
   * How `lobu chat --user <platform>:<id>` addresses a recipient: the request
   * body gets `{ [platform]: { [key]: id } }` (plus `thread` if enabled).
   * Omitted for platforms without direct-send support.
   */
  chatTarget?: { key: string; includeThread?: boolean };
}

export const PLATFORM_REGISTRY: readonly PlatformDefinition[] = [
  {
    id: "telegram",
    displayName: "Telegram",
    fields: [
      {
        key: "botToken",
        envVar: "TELEGRAM_BOT_TOKEN",
        label: "Telegram bot token (from @BotFather):",
        secret: true,
      },
    ],
    chatTarget: { key: "chatId" },
  },
  {
    id: "slack",
    displayName: "Slack",
    intro: [
      "\nCreate a Slack app for this agent, then paste its bot token + signing secret below.",
      "  1. Visit https://api.slack.com/apps → 'Create New App' → 'From an app manifest'",
      "  2. Pick your workspace, then paste the self-install manifest template:",
      "     https://github.com/lobu-ai/lobu/blob/main/config/slack-app-manifest.self-install.json",
      "     (or run: SLACK_MANIFEST_PATH=config/slack-app-manifest.self-install.json \\",
      "              PUBLIC_GATEWAY_URL=<your gateway URL> \\",
      "              SLACK_CONNECTION_ID=<agent>-slack \\",
      "              bun run scripts/slack-manifest.ts print)",
      "  3. In the manifest, replace the request URLs with https://<gateway>/api/v1/webhooks/<agent>-slack",
      "  4. Install the app to your workspace to mint the bot token.\n",
    ],
    fields: [
      {
        key: "botToken",
        envVar: "SLACK_BOT_TOKEN",
        label: "Slack bot token (xoxb-...):",
        secret: true,
      },
      {
        key: "signingSecret",
        envVar: "SLACK_SIGNING_SECRET",
        label: "Slack signing secret:",
        secret: true,
      },
    ],
    chatTarget: { key: "channel", includeThread: true },
  },
  {
    id: "discord",
    displayName: "Discord",
    fields: [
      {
        key: "botToken",
        envVar: "DISCORD_BOT_TOKEN",
        label: "Discord bot token:",
        secret: true,
      },
      {
        key: "applicationId",
        envVar: "DISCORD_APPLICATION_ID",
        label: "Discord application ID:",
        secret: false,
      },
      {
        key: "publicKey",
        envVar: "DISCORD_PUBLIC_KEY",
        label: "Discord application public key:",
        secret: true,
      },
    ],
    chatTarget: { key: "channelId" },
  },
  {
    id: "whatsapp",
    displayName: "WhatsApp",
    fields: [
      {
        key: "accessToken",
        envVar: "WHATSAPP_ACCESS_TOKEN",
        label: "WhatsApp Business access token:",
        secret: true,
      },
      {
        key: "phoneNumberId",
        envVar: "WHATSAPP_PHONE_NUMBER_ID",
        label: "WhatsApp phone number ID:",
        secret: false,
      },
      {
        key: "verifyToken",
        envVar: "WHATSAPP_WEBHOOK_VERIFY_TOKEN",
        label: "WhatsApp webhook verify token:",
        secret: true,
      },
      {
        key: "appSecret",
        envVar: "WHATSAPP_APP_SECRET",
        label: "WhatsApp app secret:",
        secret: true,
      },
    ],
  },
  {
    id: "teams",
    displayName: "Microsoft Teams",
    fields: [
      {
        key: "appId",
        envVar: "TEAMS_APP_ID",
        label: "Teams App ID (from Azure Bot):",
        secret: false,
      },
      {
        key: "appPassword",
        envVar: "TEAMS_APP_PASSWORD",
        label: "Teams App Password (client secret):",
        secret: true,
      },
      {
        key: "appTenantId",
        envVar: "TEAMS_APP_TENANT_ID",
        label: "Teams App Tenant ID (leave empty for multi-tenant apps):",
        secret: false,
        placeholder: false,
      },
    ],
    placeholderExtras: { appType: "MultiTenant" },
    finalize: (config, values) => {
      if (values.appTenantId) {
        config.appType = "SingleTenant";
      } else if (values.appId || values.appPassword) {
        config.appType = "MultiTenant";
      }
    },
  },
  {
    id: "gchat",
    displayName: "Google Chat",
    fields: [
      {
        key: "credentials",
        envVar: "GOOGLE_CHAT_CREDENTIALS",
        label: "Google Chat service account JSON:",
        secret: true,
      },
    ],
  },
];

export function getPlatformDefinition(
  id: string
): PlatformDefinition | undefined {
  return PLATFORM_REGISTRY.find((p) => p.id === id);
}

/** Placeholder env-var refs for `--yes` mode; the user fills the values into .env. */
export function getPlatformPlaceholders(id: string): Record<string, string> {
  const def = getPlatformDefinition(id);
  if (!def) return {};
  const placeholders: Record<string, string> = {};
  for (const field of def.fields) {
    if (field.placeholder !== false) {
      placeholders[field.key] = `$${field.envVar}`;
    }
  }
  return { ...placeholders, ...def.placeholderExtras };
}

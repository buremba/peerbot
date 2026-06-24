/**
 * Slack (catalog connector — declaration only)
 *
 * Slack is a CHAT platform, not a data feed: inbound traffic is Chat SDK events
 * delivered to the shared app-webhook endpoint, and per-message routing is via
 * `/lobu link` channel bindings — NOT a connector `sync()`. This file exists so
 * the Slack app's credentials + install/webhook scheme flow through the SAME
 * declaration-driven resolver as GitHub/Jira/Linear: the gateway reads the
 * declared env-var NAMES here (`SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`,
 * `SLACK_SIGNING_SECRET`) instead of hardcoding `process.env.SLACK_*` literals.
 *
 * Deliberately INERT as a catalog entry (see the bundled-connector side-effect
 * audit):
 *  - NO `feeds` → no auto-provisioned data feeds, nothing for device-reconcile
 *    to wire, and the install callback writes only the `app_installations` row.
 *  - NO `runtime` / `requiredCapability` → `getBundledDeviceConnectors()` filters
 *    it out, so it is never auto-installed onto a device fleet.
 *  - `sync()` throws → it must never be scheduled as a poll (it has no feeds, so
 *    it never will be; the throw is a hard backstop).
 *
 * The webhook `delivery: 'app_installation'` + `routingKeyPath: 'team_id'` tells
 * the app-webhook router this connector's deliveries route by Slack `team_id`
 * through `/api/v1/app-webhooks/slack` (the Slack provider plugin owns the
 * `v0:{ts}:{rawBody}` verify, which the HMAC-only webhook schema can't express).
 */

import {
  type ConnectorDefinition,
  ConnectorRuntime,
  type SyncContext,
  type SyncResult,
} from '@lobu/connector-sdk';

/**
 * Bot scopes the hosted Lobu Slack app requests (mentions, threads, slash
 * commands, DM assistant chat). Kept in sync with
 * `config/slack-app-manifest.self-install.json`'s `oauth_config.scopes.bot`.
 */
const SLACK_BOT_SCOPES = [
  'app_mentions:read',
  'assistant:write',
  'channels:history',
  'channels:read',
  'chat:write',
  'chat:write.public',
  'commands',
  'files:read',
  'files:write',
  'groups:history',
  'groups:read',
  'im:history',
  'im:read',
  'im:write',
  'mpim:history',
  'mpim:read',
  'reactions:read',
  'reactions:write',
  'users:read',
];

/** Bot events the hosted app subscribes to (manifest `bot_events`). */
const SLACK_BOT_EVENTS = [
  'app_home_opened',
  'app_mention',
  'member_joined_channel',
  'message.channels',
  'message.groups',
  'message.im',
  'message.mpim',
  'team_join',
];

export default class SlackConnector extends ConnectorRuntime {
  readonly definition: ConnectorDefinition = {
    key: 'slack',
    name: 'Slack',
    description:
      'Connect a Slack workspace to Lobu. Mention the bot, DM it, or run /lobu in any channel to drive a sandboxed agent.',
    version: '1.0.0',
    faviconDomain: 'slack.com',
    webhook: {
      // App-level delivery: one webhook is configured ONCE on the Slack app, and
      // inbound deliveries route via the shared `/api/v1/app-webhooks/slack`
      // endpoint keyed on `team_id`. Slack's signature scheme is custom
      // (`v0:{ts}:{rawBody}`), so the Slack app-webhook provider plugin owns
      // verify — there is no raw-body HMAC `signatureHeader` to derive one from.
      delivery: 'app_installation',
      routingKeyPath: 'team_id',
    },
    authSchema: {
      methods: [
        {
          type: 'app_installation',
          provider: 'slack',
          providerInstance: 'cloud',
          // The hosted Lobu Slack app's OAuth client (used for the "Add to Slack"
          // install handshake) + the signing secret used to verify inbound
          // events. Declared as env-var NAMES; the gateway resolves the values.
          clientIdKey: 'SLACK_CLIENT_ID',
          clientSecretKey: 'SLACK_CLIENT_SECRET',
          webhookSecretKey: 'SLACK_SIGNING_SECRET',
          installUrlTemplate: 'https://slack.com/oauth/v2/authorize',
          permissions: SLACK_BOT_SCOPES,
          events: SLACK_BOT_EVENTS,
          required: false,
          description:
            'Install the Lobu app on your Slack workspace to grant the bot token. Routing to agents is per-channel via /lobu link.',
        },
      ],
    },
  };

  // Slack is a chat platform — it has no data feeds and is never polled. A
  // scheduled sync would be a wiring bug; throw rather than silently no-op.
  async sync(_ctx: SyncContext): Promise<SyncResult> {
    throw new Error(
      'The Slack connector is a chat platform and has no syncable feeds; inbound traffic flows through /api/v1/app-webhooks/slack.',
    );
  }
}

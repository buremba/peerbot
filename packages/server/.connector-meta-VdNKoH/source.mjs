import { createRequire as __createRequire } from 'module'; const require = __createRequire(import.meta.url);

// ../connectors/src/slack.ts
import { IntegrationConnector } from "@lobu/connector-sdk";
var SLACK_BOT_SCOPES = [
  "app_mentions:read",
  "assistant:write",
  "channels:history",
  "channels:read",
  "chat:write",
  "chat:write.public",
  "commands",
  "files:read",
  "files:write",
  "groups:history",
  "groups:read",
  "im:history",
  "im:read",
  "im:write",
  "mpim:history",
  "mpim:read",
  "reactions:read",
  "reactions:write",
  "users:read"
];
var SLACK_BOT_EVENTS = [
  "app_home_opened",
  "app_mention",
  "member_joined_channel",
  "message.channels",
  "message.groups",
  "message.im",
  "message.mpim",
  "team_join"
];
var SlackConnector = class extends IntegrationConnector {
  definition = {
    key: "slack",
    kind: "integration",
    name: "Slack",
    description: "Connect a Slack workspace to Lobu. Mention the bot, DM it, or run /lobu in any channel to drive a sandboxed agent.",
    version: "1.0.0",
    faviconDomain: "slack.com",
    webhook: {
      // App-level delivery: one webhook is configured ONCE on the Slack app, and
      // inbound deliveries route via the shared `/api/v1/app-webhooks/slack`
      // endpoint. Slack's signature scheme is FULLY declarative: HMAC-SHA256 over
      // `v0:{timestamp}:{body}` compared against `x-slack-signature` (prefix
      // `v0=`), plus a 300s timestamp-freshness replay guard — the generic engine
      // verifies it with no Slack-specific code.
      delivery: "app_installation",
      // Verified deliveries forward to the chat adapter (the routing chain in
      // SlackConnectionCoordinator), not the data-ingest path. The generic engine
      // dispatches on this, never on the `slack` name.
      deliveryKind: "chat",
      signatureHeader: "x-slack-signature",
      algorithm: "sha256",
      signaturePrefix: "v0=",
      signingBaseTemplate: "v0:{timestamp}:{body}",
      timestampHeader: "x-slack-request-timestamp",
      freshnessSeconds: 300,
      // The team id sits in different places across Slack event shapes; first
      // match wins.
      routingKeyPaths: ["team_id", "team.id", "event.team_id"]
    },
    authSchema: {
      methods: [
        {
          type: "app_installation",
          provider: "slack",
          providerInstance: "cloud",
          // "Add to Slack" is a standard OAuth code exchange: the gateway's
          // generic install engine mounts /slack/install + /slack/oauth_callback,
          // redirects to `authorizeUrl` with the client id + scopes, and on
          // callback exchanges the code at `tokenUrl`. The engine dispatches on
          // this shape, never on the `slack` name.
          installShape: "oauth-code-exchange",
          authorizeUrl: "https://slack.com/oauth/v2/authorize",
          tokenUrl: "https://slack.com/api/oauth.v2.access",
          // The hosted Lobu Slack app's OAuth client (used for the "Add to Slack"
          // install handshake) + the signing secret used to verify inbound
          // events. Declared as env-var NAMES; the gateway resolves the values.
          clientIdKey: "SLACK_CLIENT_ID",
          clientSecretKey: "SLACK_CLIENT_SECRET",
          webhookSecretKey: "SLACK_SIGNING_SECRET",
          permissions: SLACK_BOT_SCOPES,
          events: SLACK_BOT_EVENTS,
          required: false,
          description: "Install the Lobu app on your Slack workspace to grant the bot token. Routing to agents is per-channel via /lobu link."
        },
        {
          // "Sign in with Slack" (OpenID Connect). Fully self-describing: the
          // declaration carries Slack's OIDC endpoints + login scopes, so the
          // gateway wires it through Better Auth's provider-agnostic
          // `genericOAuth` plugin (NOT the built-in `socialProviders` allowlist —
          // Slack is not a Better Auth built-in social provider). Core stays
          // provider-name-free; everything provider-specific lives here. Reuses
          // the SAME hosted Lobu Slack app client as the install method above
          // (env-var NAMES; the gateway resolves the values). Signing in
          // auto-provisions the user's personal org + default agent via Better
          // Auth's `user.create` hook (OIDC `sub` → Slack user id); no data feed.
          type: "oauth",
          provider: "slack",
          loginScopes: ["openid", "email", "profile"],
          authorizationUrl: "https://slack.com/openid/connect/authorize",
          tokenUrl: "https://slack.com/api/openid.connect.token",
          userinfoUrl: "https://slack.com/api/openid.connect.userInfo",
          clientIdKey: "SLACK_CLIENT_ID",
          clientSecretKey: "SLACK_CLIENT_SECRET",
          required: false,
          description: "Sign in with Slack to create or access your Lobu account using your Slack identity."
        }
      ]
    }
  };
};
export {
  SlackConnector as default
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsiLi4vLi4vLi4vLi4vLi4vLi4vVXNlcnMvYnVyYWtlbXJlL0NvZGUvbG9idS8uY2xhdWRlL3dvcmt0cmVlcy9jb25uZWN0aW9ucy11bmlmeS1zMmIvcGFja2FnZXMvY29ubmVjdG9ycy9zcmMvc2xhY2sudHMiXSwKICAibWFwcGluZ3MiOiAiOzs7QUE0QkEsU0FBbUMsNEJBQTRCO0FBTy9ELElBQU0sbUJBQW1CO0FBQUEsRUFDdkI7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFDRjtBQUdBLElBQU0sbUJBQW1CO0FBQUEsRUFDdkI7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQUEsRUFDQTtBQUFBLEVBQ0E7QUFBQSxFQUNBO0FBQ0Y7QUFFQSxJQUFxQixpQkFBckIsY0FBNEMscUJBQXFCO0FBQUEsRUFDdEQsYUFBa0M7QUFBQSxJQUN6QyxLQUFLO0FBQUEsSUFDTCxNQUFNO0FBQUEsSUFDTixNQUFNO0FBQUEsSUFDTixhQUNFO0FBQUEsSUFDRixTQUFTO0FBQUEsSUFDVCxlQUFlO0FBQUEsSUFDZixTQUFTO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUEsTUFPUCxVQUFVO0FBQUE7QUFBQTtBQUFBO0FBQUEsTUFJVixjQUFjO0FBQUEsTUFDZCxpQkFBaUI7QUFBQSxNQUNqQixXQUFXO0FBQUEsTUFDWCxpQkFBaUI7QUFBQSxNQUNqQixxQkFBcUI7QUFBQSxNQUNyQixpQkFBaUI7QUFBQSxNQUNqQixrQkFBa0I7QUFBQTtBQUFBO0FBQUEsTUFHbEIsaUJBQWlCLENBQUMsV0FBVyxXQUFXLGVBQWU7QUFBQSxJQUN6RDtBQUFBLElBQ0EsWUFBWTtBQUFBLE1BQ1YsU0FBUztBQUFBLFFBQ1A7QUFBQSxVQUNFLE1BQU07QUFBQSxVQUNOLFVBQVU7QUFBQSxVQUNWLGtCQUFrQjtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQSxVQU1sQixjQUFjO0FBQUEsVUFDZCxjQUFjO0FBQUEsVUFDZCxVQUFVO0FBQUE7QUFBQTtBQUFBO0FBQUEsVUFJVixhQUFhO0FBQUEsVUFDYixpQkFBaUI7QUFBQSxVQUNqQixrQkFBa0I7QUFBQSxVQUNsQixhQUFhO0FBQUEsVUFDYixRQUFRO0FBQUEsVUFDUixVQUFVO0FBQUEsVUFDVixhQUNFO0FBQUEsUUFDSjtBQUFBLFFBQ0E7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBO0FBQUE7QUFBQTtBQUFBLFVBV0UsTUFBTTtBQUFBLFVBQ04sVUFBVTtBQUFBLFVBQ1YsYUFBYSxDQUFDLFVBQVUsU0FBUyxTQUFTO0FBQUEsVUFDMUMsa0JBQWtCO0FBQUEsVUFDbEIsVUFBVTtBQUFBLFVBQ1YsYUFBYTtBQUFBLFVBQ2IsYUFBYTtBQUFBLFVBQ2IsaUJBQWlCO0FBQUEsVUFDakIsVUFBVTtBQUFBLFVBQ1YsYUFDRTtBQUFBLFFBQ0o7QUFBQSxNQUNGO0FBQUEsSUFDRjtBQUFBLEVBQ0Y7QUFDRjsiLAogICJuYW1lcyI6IFtdCn0K

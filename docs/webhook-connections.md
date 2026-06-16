# Inbound webhook connections

`platform: "webhook"` turns a connection into a push-source: any external
system that emits webhooks (Sentry, GitHub, Stripe, healthchecks, CI) POSTs
JSON to Lobu and the payload lands as an `events` row. Watchers pick those
rows up through their normal checkpointed SQL sources — no new machinery, no
Chat SDK instance, no per-pod state. Reaction latency is bounded by the
watcher cadence (cron), not by the delivery.

## Create one

```bash
curl -X POST "$LOBU/api/<org>/agents/<agentId>/platforms" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "content-type: application/json" \
  -d '{
    "platform": "webhook",
    "config": {
      "allowQueryAuth": true,
      "semanticType": "alert",
      "titlePath": "/event/title"
    }
  }'
```

A strong bearer `token` is auto-generated when you don't supply one and
persisted as a `secret://` ref. The create response is the only time you see
it in plaintext — copy it then.

## Config

| Field | Default | Meaning |
| --- | --- | --- |
| `token` | auto-generated | Bearer token for inbound deliveries; stored as a secret ref. |
| `allowQueryAuth` | `false` | Accept `?token=` for senders that can't set headers (e.g. Sentry's legacy WebHooks plugin). |
| `dedupeHeader` | — | Header carrying the provider's delivery id (e.g. `x-github-delivery`). Without it, the idempotency key is `sha256(raw body)`. |
| `semanticType` | `content` | `events.semantic_type` stamped on ingested rows. |
| `titlePath` | — | JSON pointer extracted into `events.title` (e.g. `/event/title`). |
| `searchable` | `false` | Index payloads into semantic memory (`search_memory`). Off = store-only, reachable by watcher SQL; leave off for high-volume/low-value sources to keep recall clean. |

Bodies must be JSON. A non-JSON body (form-encoded, XML, plain text) is
rejected with `400`; content-type-aware ingest is not implemented.

## Deliver

```
POST /lobu/api/v1/webhooks/<connectionId>
  Authorization: Bearer <token>        # or x-lobu-webhook-token: <token>
  # or ?token=<token> when allowQueryAuth is enabled
```

(The gateway mounts under `/lobu`, so the full path is
`<gateway>/lobu/api/v1/webhooks/<connectionId>`.)

Responses: `202 {"ok":true,"id":<eventId>}` on persist (the insert commits
before the ack; redeliveries return the existing id), `401` bad/missing
token, `404` unknown connection, `413` body over 256 KB, `400` non-JSON
body, `429` over 120 authenticated deliveries/min per connection (counted
after token verification, so bad-token floods can't starve real senders;
unauthenticated attempts are bounded separately per source IP).

The raw parsed payload is preserved verbatim in `payload_data` (wrapped as
`{"payload": ...}` when the JSON root is an array or primitive). When
`searchable` is enabled it is also rendered to a flat `dotted.path: value`
text projection in `payload_text` (capped at 8 KB) so the row is embedded by
the backfill and surfaced by semantic recall / `search_memory`; with
`searchable` off (the default) `payload_text` stays null and the row is
reachable only by watcher SQL / `query_sql`. Rows carry
`connector_key = 'webhook:<connectionId>'`; redelivery dedupe is enforced by
a partial unique index on `(organization_id, connector_key, origin_id)`.

Without `dedupeHeader`, the idempotency key is `sha256(raw body)` — so two
*distinct* deliveries with byte-identical bodies (e.g. a fixed `{"status":"ok"}`
heartbeat) collapse to one stored event. Set `dedupeHeader` to the provider's
delivery-id header for periodic or repeating senders.

## React with a watcher

```sql
-- watcher source; the window bounds are injected automatically
SELECT id, title, payload_data, occurred_at
FROM events
WHERE connector_key = 'webhook:<connectionId>'
```

## Example: Sentry → Slack triage

Sentry's free plan blocks the native Slack integration, but the legacy
per-project WebHooks plugin POSTs new-issue payloads to any URL on every
plan:

1. Create a webhook connection with `allowQueryAuth: true`,
   `semanticType: "alert"`, `titlePath: "/event/title"`.
2. In Sentry: project → Settings → Integrations → WebHooks → add
   `https://<gateway>/lobu/api/v1/webhooks/<connectionId>?token=<token>`.
3. Add a watcher on the agent (1-min cron) with the source above and a
   prompt that triages each issue and posts a summary to a Slack channel via
   the agent's existing Slack connection.

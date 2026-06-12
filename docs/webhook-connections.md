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
      "allowQueryToken": true,
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
| `allowQueryToken` | `false` | Accept `?token=` for senders that can't set headers (e.g. Sentry's legacy WebHooks plugin). |
| `dedupeHeader` | — | Header carrying the provider's delivery id (e.g. `x-github-delivery`). Without it, the idempotency key is `sha256(raw body)`. |
| `semanticType` | `content` | `events.semantic_type` stamped on ingested rows. |
| `titlePath` | — | JSON pointer extracted into `events.title` (e.g. `/event/title`). |

## Deliver

```
POST /api/v1/webhooks/<connectionId>
  Authorization: Bearer <token>        # or x-lobu-webhook-token: <token>
  # or ?token=<token> when allowQueryToken is enabled
```

Responses: `202 {"ok":true,"id":<eventId>}` on persist (the insert commits
before the ack; redeliveries return the existing id), `401` bad/missing
token, `404` unknown connection, `413` body over 256 KB, `429` over 120
deliveries/min per connection, `400` non-JSON body.

The raw parsed payload is preserved verbatim in `payload_data` (wrapped as
`{"payload": ...}` when the JSON root is an array or primitive). Rows carry
`connector_key = 'webhook:<connectionId>'`; redelivery dedupe is enforced by
a partial unique index on `(organization_id, connector_key, origin_id)`.

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

1. Create a webhook connection with `allowQueryToken: true`,
   `semanticType: "alert"`, `titlePath: "/event/title"`.
2. In Sentry: project → Settings → Integrations → WebHooks → add
   `https://<gateway>/api/v1/webhooks/<connectionId>?token=<token>`.
3. Add a watcher on the agent (1-min cron) with the source above and a
   prompt that triages each issue and posts a summary to a Slack channel via
   the agent's existing Slack connection.

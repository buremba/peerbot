# Browser-driven verification (authenticated)

For any UI verification that needs a signed-in session (past the auth wall), use the `agent-browser` CLI with a session cookie minted from the DB. The user's regular Chrome doesn't expose a remote-debug port, so `--auto-connect` will land on the wrong tab — mint a cookie instead.

## Scope

The forged session cookie authenticates the **web admin REST mounted at `/`** (`/api/auth/*`, `/api/<orgSlug>/...`, the SPA — anything `lobu apply` and the web app talk to). It does **NOT** authenticate the **public Agent API at `/lobu`** (`/lobu/api/v1/agents/*`, `/lobu/api/v1/agents/<id>/sessions`) — that path expects a JWT bearer from the OAuth device flow (`lobu login`) or a PAT. If `/lobu/api/v1/agents` returns `401` despite a valid cookie, switch to `lobu chat` / `lobu token`.

## Pick a target

Local dev backend (with prod DB attached over Tailscale): `https://<your-tailscale-host>.ts.net:8443`. Prod: `https://app.lobu.ai`.

## Grab the secret + session token

```bash
# Local dev backend uses .env's BETTER_AUTH_SECRET
SECRET=$(grep '^BETTER_AUTH_SECRET=' .env | cut -d= -f2-)

# Prod uses the secret on the K8s pod
SECRET=$(kubectl exec -n summaries-prod \
  $(kubectl get pod -n summaries-prod -l app.kubernetes.io/name=lobu-app -o name | head -1 | sed 's|pod/||') \
  -- printenv BETTER_AUTH_SECRET)

# Session token from the DB (prod DB serves both targets)
DB="$(grep '^DATABASE_URL=' .env | cut -d= -f2-)"
TOKEN=$(psql "$DB" -tAc "SELECT token FROM session WHERE \"userId\" = '<user_id>' AND \"expiresAt\" > NOW() ORDER BY \"updatedAt\" DESC LIMIT 1")
```

## Sign the cookie

better-auth uses HMAC-SHA256, base64, then URL-encode — base64**url** does *not* validate.

```bash
SIGNED=$(SECRET="$SECRET" TOKEN="$TOKEN" node -e '
  const {createHmac}=require("node:crypto");
  const sig=createHmac("sha256",process.env.SECRET).update(process.env.TOKEN).digest("base64");
  console.log(encodeURIComponent(`${process.env.TOKEN}.${sig}`));
')
```

Cookie name is `__Secure-better-auth.session_token` whenever the baseURL is `https://` (prod and Tailscale dev qualify; only plain-http localhost uses the unprefixed `better-auth.session_token`).

## Drive the browser

```bash
agent-browser --session lobu-verify open "https://app.lobu.ai/"
agent-browser --session lobu-verify eval "document.cookie='__Secure-better-auth.session_token=$SIGNED; path=/; secure; samesite=lax'"
agent-browser --session lobu-verify open "https://app.lobu.ai/<path>"
agent-browser --session lobu-verify wait --text "<expected text>" --timeout 25000
agent-browser --session lobu-verify snapshot -i      # find @refs
agent-browser --session lobu-verify click @e13        # interact
agent-browser --session lobu-verify screenshot --full /tmp/out.png
agent-browser --session lobu-verify close
```

## Driving the paired Owletto extension (connector debugging)

The cookie-forging above and `claude-in-chrome` both drive a *separate* browser that lacks the user's real logged-in sessions — Revolut, for instance, redirects them to `sso.revolut.com/signin`. To run JS or browser actions in the **paired Owletto extension** (the Chrome that holds the user's live sessions, which is what extension-scrape connectors like Revolut/LinkedIn use), go through the connector-operations bridge instead. No deploy required.

`lobu connector run` is the wrong tool here — it only does local Playwright/CDP against a `browser_session` auth profile, so it errors `Missing --auth-profile` for device-worker connectors (Revolut has no auth profile). Use the SDK `operations` namespace via `lobu memory exec` / `run_sdk`:

```js
// chrome connection id: client.connections.list() → connector_key 'chrome'
const ops = await client.operations.listAvailable({ connection_id: CHROME_CONN_ID });
// navigate opens a fresh background tab in the paired Chrome and returns tab_id
const nav = await client.operations.execute({
  connection_id: CHROME_CONN_ID, operation_key: 'navigate',
  input: { url: 'https://app.revolut.com/transactions', open_in_new_tab: true, wait_for_load: true },
});
// evaluate runs arbitrary JS on that tab and returns the JSON-serialised result
await client.operations.execute({
  connection_id: CHROME_CONN_ID, operation_key: 'evaluate',
  input: { tab_id: nav.output.tab_id, expression: '(async()=>{ /* read DOM */ return out })()', await_promise: true },
});
```

`operations.execute` → `dispatchChromeActionToExtension` (`worker-api/dispatch-chrome-action.ts`) → device-worker queue → the paired extension — the same bridge the office-bot Deliveroo connector uses. Chrome ops: `navigate`, `evaluate`, `get_accessibility_tree`, `wait_for_selector`, `click_ref`, `type_ref`, `screenshot`, `show_notification`, `network_intercept_*`, `close_tab`.

Gotchas:
- `search_sdk` does **not** surface the `operations` namespace (nor several others). Discover the real surface with `Object.keys(client)` inside a `run_sdk` script.
- Sessions that re-auth often (Revolut, ~hourly) must be freshly logged in *in the paired Chrome* right before you navigate+evaluate, or the fresh tab redirects to the sign-in wall.
- Per-call dispatch latency is 5–60s and virtualized lists recycle content out — for paginated scrapes, iterate inside the connector's own run, not via one-shot `evaluate`s.
- **Connector-side changes ship via re-apply, not the app release.** Per-org connectors (`examples/personal-agent`) live in `connector_definitions`/`connector_versions` and only update on `lobu apply` (or `connections.installConnector` for a single bundle). An app deploy that adds a *capability* (e.g. `show_notification`) does nothing until the connector that *calls* it is re-applied. **And a new chrome action also needs the matching handler in the extension build** — dispatching `show_notification` to an older installed extension fails with `Owletto for Chrome: unknown dispatch ... action_key='show_notification'`. So three things gate such a notification: an up-to-date extension build (the handler), a re-applied connector (the call), and macOS notification permission on the extension.

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

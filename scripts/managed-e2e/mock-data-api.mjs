/**
 * Managed-connector e2e — mock external DATA API.
 *
 * The LOCAL connector's `sync()` fetches `/items` from here with the OAuth
 * access token it received from `ctx.credentials.accessToken`. That access
 * token is the one the LOCAL instance fetched from the CLOUD's
 * /oauth/connection-token endpoint (which the local resolver hit over real
 * HTTP). The endpoint REQUIRES the bearer:
 *
 *   - missing / wrong bearer            → 401 (sync would fail)
 *   - correct EXPECTED_TOKEN bearer     → 200 + one item
 *
 * So a green sync that wrote an event is hard proof the managed token was not
 * just fetched but actually USED upstream. The expected token is the one the
 * cloud was seeded to hand out (`MANAGED_ACCESS_TOKEN`).
 */
import { createServer } from "node:http";

const PORT = Number(process.env.MOCK_DATA_PORT || 8911);
const EXPECTED = process.env.EXPECTED_TOKEN || "managed-access-token-xyz";

const server = createServer((req, res) => {
  const url = req.url || "";
  if (!url.includes("/items")) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
    return;
  }
  const auth = req.headers.authorization || "";
  const m = /^bearer\s+(.*)$/i.exec(auth);
  const token = m ? m[1].trim() : "";
  // Log every hit so the e2e can assert the bearer that arrived.
  console.log(
    `[mock-data] GET /items auth=${token ? `bearer:${token}` : "(none)"}`
  );
  if (token !== EXPECTED) {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "unauthorized", got: token || null }));
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      items: [
        {
          id: `managed-item-${Date.now()}`,
          text: "MANAGED_E2E_ITEM",
        },
      ],
    })
  );
});

server.listen(PORT, "127.0.0.1", () =>
  console.log(`[mock-data] listening on 127.0.0.1:${PORT} (expects token)`)
);

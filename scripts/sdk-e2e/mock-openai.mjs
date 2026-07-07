import { createServer } from "node:http";
const PORT = Number(process.env.MOCK_PORT || 11434);
const REPLY = process.env.MOCK_REPLY || "PONG";
// MOCK_MODE=quota-429 makes /chat/completions answer with z.ai's exact
// production 429 body so the error-taxonomy e2e can drive a real provider
// quota failure through the whole worker→gateway→renderer chain. `/models`
// still 200s so model resolution succeeds and the failure lands where a real
// quota exhaustion does: on the chat call, mid-turn. Default ("") is the
// happy-path reply the SDK lifecycle gate relies on — unchanged.
const MODE = process.env.MOCK_MODE || "";
const QUOTA_BODY =
  "429 Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-07-10 04:32:47";
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const url = req.url || "";
    if (url.includes("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          object: "list",
          data: [{ id: "mock-model", object: "model" }],
        })
      );
      return;
    }
    if (url.includes("/chat/completions")) {
      if (MODE === "quota-429") {
        // z.ai's real 429 carries the reset time in the BODY text (not a
        // Retry-After header). The error e2e parses that out of the raw string
        // and asserts it reaches the user via the catalog.
        res.writeHead(429, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: { message: QUOTA_BODY, type: "rate_limit_exceeded" },
          })
        );
        return;
      }
      let stream = false;
      try {
        stream = JSON.parse(body || "{}").stream === true;
      } catch {
        // non-JSON body → default to non-streaming
      }
      if (stream) {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        });
        const id = "chatcmpl-mock";
        const chunk = (delta, finish) =>
          `data: ${JSON.stringify({ id, object: "chat.completion.chunk", model: "mock-model", choices: [{ index: 0, delta, finish_reason: finish ?? null }] })}\n\n`;
        res.write(chunk({ role: "assistant" }));
        res.write(chunk({ content: REPLY }));
        res.write(chunk({}, "stop"));
        res.write("data: [DONE]\n\n");
        res.end();
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "chatcmpl-mock",
            object: "chat.completion",
            model: "mock-model",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: REPLY },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          })
        );
      }
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });
});
server.listen(PORT, "127.0.0.1", () =>
  console.log(`[mock-openai] listening on 127.0.0.1:${PORT}`)
);

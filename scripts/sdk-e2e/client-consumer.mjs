// Standalone @lobu/client consumer used by scripts/sdk-e2e.sh.
//
// Proves the CONSUMPTION SDK round-trip against a live `lobu run`: create a
// session, send a message, and stream the agent's reply back over SSE — the
// path an external JS app takes, distinct from the `lobu chat` CLI the rest of
// the gate exercises. Runs from a throwaway project that installed the PACKED
// @lobu/client tarball, so it also proves the published artifact is
// self-contained (zero deps).
//
// Env: LOBU_BASE_URL (origin + /lobu), LOBU_TOKEN (Agent-API token), LOBU_AGENT_ID.
// Prints the streamed answer to stdout; exits non-zero on an empty answer so
// the caller can grep for the expected reply and fail the gate on a miss.

import { Lobu } from "@lobu/client";

const baseUrl = process.env.LOBU_BASE_URL;
const token = process.env.LOBU_TOKEN;
const agentId = process.env.LOBU_AGENT_ID;
const question = process.env.LOBU_QUESTION || "say the safe word";

if (!baseUrl || !token || !agentId) {
  console.error("missing env: LOBU_BASE_URL / LOBU_TOKEN / LOBU_AGENT_ID");
  process.exit(2);
}

const lobu = new Lobu({ baseUrl, token });

const session = await lobu.sessions.create({
  agentId,
  userId: "sdk-e2e-consumer",
});
console.log(`[client] session=${session.agentId} sse=${session.sseUrl}`);

const sent = await session.send(question);
console.log(`[client] sent messageId=${sent.messageId} queued=${sent.queued}`);

const ac = new AbortController();
const timeout = setTimeout(() => ac.abort(), 90_000);

let answer = "";
let complete = false;
try {
  for await (const ev of session.events({
    signal: ac.signal,
    maxRetryAttempts: 2,
  })) {
    let data = ev.data;
    if (typeof data === "string") {
      try {
        data = JSON.parse(data);
      } catch {
        // non-JSON payload — treat the raw string as content below
      }
    }
    // Correlate to our message when the server tags events with a messageId.
    if (
      data?.messageId &&
      sent.messageId &&
      data.messageId !== sent.messageId
    ) {
      continue;
    }
    // Assistant text arrives as `event: output` with `data.content`. Accept a
    // couple of fallback shapes so a benign server-side rename can't silently
    // turn a real answer into an empty one.
    const chunk =
      ev.event === "output" || ev.event === "text" || ev.event === "message"
        ? typeof data === "string"
          ? data
          : typeof data?.content === "string"
            ? data.content
            : typeof data?.text === "string"
              ? data.text
              : ""
        : "";
    if (chunk) {
      answer += chunk;
      process.stdout.write(chunk);
    } else if (ev.event === "complete") {
      complete = true;
      break;
    } else if (ev.event === "error") {
      console.error(`\n[client] stream error: ${JSON.stringify(data)}`);
      break;
    }
  }
} finally {
  clearTimeout(timeout);
  ac.abort();
}

console.log(`\n[client] complete=${complete} answer_len=${answer.length}`);
console.log(`[client] ANSWER: ${answer.trim()}`);
if (!answer.trim()) {
  console.error("[client] FAIL: empty answer via @lobu/client");
  process.exit(1);
}

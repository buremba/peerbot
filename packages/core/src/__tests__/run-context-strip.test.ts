/**
 * The worker prepends a `## This conversation` context block to every API user
 * turn (buildRunContextBlock). It is prompt scaffolding, not something the
 * person typed — but it lands in the stored transcript. Live turns render from
 * the SSE echo so it stays hidden; a RELOAD replays the transcript, and without
 * stripping it rendered verbatim above every user message.
 *
 * Reproduced live before the fix: a hand-typed "hello this is a hand typed
 * message" showed clean while streaming, then came back on reload as
 * "## This conversation / - Platform: api / - Channel: … / hello …".
 */
import { describe, expect, it } from "vitest";
import {
  entryToMessage,
  type SessionEntry,
  stripRunContextBlock,
  titleFromSessionJsonl,
} from "../index";

/** A real block, verbatim from the transcript that exposed this. */
const BLOCK =
  "## This conversation\n- Platform: api\n- Channel: api_user_install_FZOHS7M3SxU\n\n";

function userEntry(text: string): SessionEntry {
  return {
    type: "message",
    id: "m1",
    timestamp: "2026-07-27T01:42:26.594Z",
    message: { role: "user", content: [{ type: "text", text }] },
  } as SessionEntry;
}

describe("run-context block stripping", () => {
  it("strips the block and leaves the user's own words", () => {
    expect(stripRunContextBlock(`${BLOCK}Connect my GitHub account`)).toBe(
      "Connect my GitHub account"
    );
  });

  it("leaves a message with no block untouched", () => {
    expect(stripRunContextBlock("just a normal message")).toBe(
      "just a normal message"
    );
  });

  it("keeps the user's OWN markdown heading", () => {
    // Only the exact run-context heading is stripped — a user writing their
    // own '## ...' heading must survive verbatim.
    const own = "## My notes\n- one\n- two\n\nwhat do you think?";
    expect(stripRunContextBlock(own)).toBe(own);
  });

  it("does not strip the block from the MIDDLE of a message", () => {
    // Only a block at the very start is scaffolding. The same text quoted
    // later is the user's content (e.g. asking about this very bug).
    const quoted = `why does it show\n\n${BLOCK}above my message?`;
    expect(stripRunContextBlock(quoted)).toBe(quoted);
  });

  it("strips through entryToMessage — the replay path every history route uses", () => {
    const msg = entryToMessage(userEntry(`${BLOCK}Connect my GitHub account`));
    expect(msg?.content).toEqual([
      { type: "text", text: "Connect my GitHub account" },
    ]);
  });

  it("never touches an assistant turn", () => {
    // Only the user turn carries the scaffolding; an assistant reply that
    // happens to quote it must round-trip byte-for-byte.
    const echoed = `${BLOCK}I see the context block.`;
    const entry = {
      type: "message",
      id: "m2",
      timestamp: "2026-07-27T01:42:36.976Z",
      message: { role: "assistant", content: [{ type: "text", text: echoed }] },
    } as SessionEntry;
    expect(entryToMessage(entry)?.content).toEqual([
      { type: "text", text: echoed },
    ]);
  });

  it("derives a title from the user's words, not the scaffolding", () => {
    const jsonl = JSON.stringify(
      userEntry(`${BLOCK}Connect my GitHub account`)
    );
    expect(titleFromSessionJsonl(jsonl, "fallback")).toBe(
      "Connect my GitHub account"
    );
  });
});

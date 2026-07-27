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

  // The worker builds the turn as
  //   configNotice + sessionSummary + ephemeralContext + prependContexts +
  //   runContext + userPrompt
  // so the block is frequently NOT at position 0. A first cut anchored to `^`
  // and silently failed on every turn that carried any prefix — the reviewer
  // reproduced it with a direct probe.
  it.each([
    {
      label: "a session summary",
      prefix: "Previously: we discussed the Q3 roadmap.",
    },
    {
      label: "recalled memory",
      prefix: "<lobu-memory>\nUser prefers concise answers.\n</lobu-memory>",
    },
    {
      label: "a config notice",
      prefix: "NOTE: your model was changed to gemini-2.5-pro.",
    },
  ])("strips the block when $label precedes it", ({ prefix }) => {
    expect(stripRunContextBlock(`${prefix}\n\n${BLOCK}what is next?`)).toBe(
      `${prefix}\n\nwhat is next?`
    );
  });

  it("strips the worker's block, not a LATER user section reusing the heading", () => {
    // The worker's block is a PREFIX of the turn, so a user's own
    // `## This conversation` section always lands AFTER it. Selecting the final
    // matching heading would wrongly strip the user's section (with prose
    // bullets) and leave the real scaffolding. The block is identified by its
    // fixed field shape, so the user's prose-bullet section is not a candidate.
    const userSection =
      "## This conversation\n- my own note\n- another thought";
    const asStored = `${BLOCK}Here is what I mean:\n\n${userSection}\n\nwhat next?`;
    expect(stripRunContextBlock(asStored)).toBe(
      `Here is what I mean:\n\n${userSection}\n\nwhat next?`
    );
  });

  it("strips the worker's block, not an earlier one the user quoted", () => {
    // A user asking about this very behaviour pastes the block into a session
    // summary / earlier context. The worker's own block is appended LAST, right
    // before the user's words — that is the only one that may be removed.
    const earlier = `Earlier you asked about:\n\n${BLOCK}(quoted above)`;
    const asStored = `${earlier}\n\n${BLOCK}so why does it show?`;
    expect(stripRunContextBlock(asStored)).toBe(
      `${earlier}\n\nso why does it show?`
    );
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

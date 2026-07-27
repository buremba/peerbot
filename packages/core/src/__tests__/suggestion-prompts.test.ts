import { describe, expect, test } from "bun:test";
import { sanitizeSuggestionPrompts, SUGGESTION_LIMITS } from "../types";

describe("sanitizeSuggestionPrompts", () => {
  test("drops malformed entries, trims, and deduplicates valid prompts", () => {
    expect(
      sanitizeSuggestionPrompts([
        null,
        "plain text",
        { title: " ", message: "empty title" },
        { title: "Missing message" },
        { title: "  Ship  ", message: "  Ship it  " },
        { title: "Ship", message: "Ship it" },
      ])
    ).toEqual([{ title: "Ship", message: "Ship it" }]);
    expect(sanitizeSuggestionPrompts({ prompts: [] })).toEqual([]);
  });

  test("caps the number and length of prompts without splitting surrogate pairs", () => {
    const emojiTitle = "😀".repeat(SUGGESTION_LIMITS.maxTitleChars + 1);
    const prompts = Array.from(
      { length: SUGGESTION_LIMITS.maxPrompts + 1 },
      (_, index) => ({
        title: index === 0 ? emojiTitle : `Title ${index}`,
        message: "x".repeat(SUGGESTION_LIMITS.maxMessageChars + 1),
      })
    );

    const result = sanitizeSuggestionPrompts(prompts);
    expect(result).toHaveLength(SUGGESTION_LIMITS.maxPrompts);
    // UTF-16 units, not code points — that is what Slack's cap measures. A
    // code-point cap would let these 72 emoji through as 144 units.
    expect(result[0]!.title.length).toBeLessThanOrEqual(
      SUGGESTION_LIMITS.maxTitleChars
    );
    // …and it must still fill the budget rather than over-trim.
    expect(result[0]!.title.length).toBeGreaterThan(
      SUGGESTION_LIMITS.maxTitleChars - 2
    );
    expect(result[0]!.title.endsWith("😀")).toBe(true);
    expect(result[0]!.message).toHaveLength(SUGGESTION_LIMITS.maxMessageChars);
  });
});

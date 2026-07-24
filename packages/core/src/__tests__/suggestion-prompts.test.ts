import { describe, expect, test } from "bun:test";
import { SUGGESTION_LIMITS, sanitizeSuggestionPrompts } from "../types";

describe("sanitizeSuggestionPrompts", () => {
  test("drops malformed entries and trims valid prompts", () => {
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
    const first = result[0];
    expect(first).toBeDefined();
    if (!first) throw new Error("expected a sanitized prompt");
    expect(Array.from(first.title)).toHaveLength(
      SUGGESTION_LIMITS.maxTitleChars
    );
    expect(first.title.endsWith("😀")).toBe(true);
    expect(first.message).toHaveLength(SUGGESTION_LIMITS.maxMessageChars);
  });
});

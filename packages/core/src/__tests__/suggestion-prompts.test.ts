import { describe, expect, test } from "bun:test";
import { sanitizeSuggestionPrompts, SUGGESTION_LIMITS } from "../types";

describe("sanitizeSuggestionPrompts", () => {
  test("drops malformed entries and trims valid prompts", () => {
    expect(
      sanitizeSuggestionPrompts([
        null,
        "plain text",
        { title: " ", message: "empty title" },
        { title: "Missing message" },
        { title: "  Ship  ", message: "  Ship it  " },
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
    expect(Array.from(result[0]!.title)).toHaveLength(
      SUGGESTION_LIMITS.maxTitleChars
    );
    expect(result[0]!.title.endsWith("😀")).toBe(true);
    expect(result[0]!.message).toHaveLength(SUGGESTION_LIMITS.maxMessageChars);
  });
});

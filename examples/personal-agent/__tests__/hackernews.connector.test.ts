import { describe, expect, test } from "bun:test";
import {
  normalizeHnItemId,
  prepareHnComment,
} from "../hackernews.connector";

function makeDispatcher() {
  const calls: Array<{ action: string; input: Record<string, unknown> }> = [];
  const dispatcher = {
    dispatch: async (action: string, input: Record<string, unknown>) => {
      calls.push({ action, input });
      if (action === "navigate") {
        return {
          tab_id: 7,
          current_url:
            input.url === "https://news.ycombinator.com/reply?id=42954035"
              ? input.url
              : "https://news.ycombinator.com/item?id=42954035",
        };
      }
      if (action === "wait_for_selector") {
        return { ok: true };
      }
      if (action === "evaluate") {
        return {
          value: {
            ok: true,
            value: "Durable state makes the difference.",
          },
        };
      }
      return { ok: true };
    },
  };
  return { dispatcher, calls };
}

describe("normalizeHnItemId", () => {
  test("accepts a bare numeric id", () => {
    expect(normalizeHnItemId("42954035")).toBe("42954035");
  });

  test("accepts an item URL", () => {
    expect(normalizeHnItemId("https://news.ycombinator.com/item?id=42954035")).toBe(
      "42954035"
    );
  });

  test("accepts a reply URL", () => {
    expect(normalizeHnItemId("https://news.ycombinator.com/reply?id=42954035")).toBe(
      "42954035"
    );
  });

  test("rejects a non-HN host", () => {
    expect(normalizeHnItemId("https://example.com/item?id=1")).toBeNull();
  });

  test("rejects a non-numeric id", () => {
    expect(normalizeHnItemId("https://news.ycombinator.com/item?id=abc")).toBeNull();
  });
});

describe("prepareHnComment", () => {
  test("stages a draft into the HN reply textarea and never submits", async () => {
    const { dispatcher, calls } = makeDispatcher();
    const result = await prepareHnComment(dispatcher, {
      itemUrl: "https://news.ycombinator.com/item?id=42954035",
      body: "Durable state makes the difference.",
    });

    expect(result.prepared).toBe(true);
    expect(result.submitted).toBe(false);
    expect(result.tab_id).toBe(7);
    expect(result.item_url).toBe("https://news.ycombinator.com/item?id=42954035");

    // Navigated to item page first (activation target), then the reply form.
    const navigations = calls.filter((c) => c.action === "navigate");
    expect(navigations[0]?.input.url).toBe(
      "https://news.ycombinator.com/item?id=42954035"
    );
    expect(navigations[0]?.input.require_page_activation).toBe(true);
    expect(navigations[1]?.input.url).toBe(
      "https://news.ycombinator.com/reply?id=42954035"
    );

    // Filled via evaluate targeting textarea[name=text].
    const evaluate = calls.find((c) => c.action === "evaluate");
    expect(String(evaluate?.input.expression)).toContain(
      'textarea[name="text"]'
    );

    // No submit click was ever attempted.
    expect(calls.some((c) => c.action === "click_ref")).toBe(false);
  });

  test("throws when not logged into HN", async () => {
    const dispatcher = {
      dispatch: async (action: string) => {
        if (action === "navigate") {
          return {
            tab_id: 7,
            current_url: "https://news.ycombinator.com/login",
          };
        }
        return { ok: true };
      },
    };
    await expect(
      prepareHnComment(dispatcher as never, {
        itemUrl: "42954035",
        body: "hello",
      })
    ).rejects.toThrow(/Not logged into Hacker News/);
  });
});

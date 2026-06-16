/**
 * Unit tests for the Deliveroo connector's pure parsers.
 *
 * Run from the worktree root so `@lobu/connector-sdk` resolves to the workspace
 * build: `bunx vitest run examples/office-bot/__tests__/deliveroo.connector.test.ts`.
 *
 * The scrape *selectors* (which DOM element a field reads) can only be verified
 * against the live site / the real extension — these tests cover the parsing
 * and filtering that runs over already-scraped rows.
 */

import { describe, expect, it } from "vitest";
import { parseMenuRows, parseRestaurantRows } from "../deliveroo.connector.ts";

describe("parseRestaurantRows", () => {
  const rows = [
    {
      name: "Nando's",
      url: "https://deliveroo.co.uk/menu/London/the-city/nandos-lime-street?day=today",
    },
    {
      name: "Pizza Hut",
      url: "https://deliveroo.co.uk/menu/London/strand/pizza-hut-strand-2",
    },
    {
      name: "Chipotle",
      url: "https://deliveroo.co.uk/menu/London/bank/chipotle-king-william-st",
    },
  ];

  it("filters by restaurant name (case-insensitive substring)", () => {
    const out = parseRestaurantRows(rows, "nando");
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("Nando's");
  });

  it("returns the full nearby list when nothing matches the query", () => {
    const out = parseRestaurantRows(rows, "sushi");
    expect(out).toHaveLength(3);
  });

  it("returns everything when no query is given", () => {
    expect(parseRestaurantRows(rows)).toHaveLength(3);
  });

  it("dedupes by restaurant path (same card in multiple rails)", () => {
    const dup = [
      ...rows,
      {
        name: "Nando's (again)",
        url: "https://deliveroo.co.uk/menu/London/the-city/nandos-lime-street?time=ASAP",
      },
    ];
    // both nandos rows share the same /menu path → one survives
    expect(parseRestaurantRows(dup)).toHaveLength(3);
  });

  it("drops rows with no name or no usable url, and rejects non-deliveroo hosts", () => {
    const bad = [
      { name: "", url: "https://deliveroo.co.uk/menu/x/y/z" },
      { name: "Evil", url: "https://evil.example.com/menu/x/y/z" },
      { name: "OK", url: "https://deliveroo.co.uk/menu/a/b/c" },
    ];
    const out = parseRestaurantRows(bad);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("OK");
  });
});

describe("parseMenuRows", () => {
  it("parses name, current price, kcal, and description from card text", () => {
    const out = parseMenuRows([
      {
        name: "1/2 Chicken Meal",
        text: "1/2 Chicken MealA chicken breast and a leg, on the bone. 579 kcal£18.20£20.95",
      },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      name: "1/2 Chicken Meal",
      price: "£18.20", // first £ = current price, struck-through £20.95 ignored
      priceMinor: 1820,
      kcal: 579,
    });
    expect(out[0].description).toContain("chicken breast");
    expect(out[0].description).not.toContain("£");
    expect(out[0].description).not.toContain("kcal");
  });

  it("handles items with no price or kcal", () => {
    const out = parseMenuRows([{ name: "Tap Water", text: "Tap Water" }]);
    expect(out[0].price).toBeUndefined();
    expect(out[0].priceMinor).toBeUndefined();
    expect(out[0].kcal).toBeUndefined();
  });

  it("dedupes by item name and skips empty names", () => {
    const out = parseMenuRows([
      { name: "Coke", text: "Coke£2.50" },
      { name: "Coke", text: "Coke£9.00" },
      { name: "", text: "junk£1.00" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].price).toBe("£2.50");
  });
});

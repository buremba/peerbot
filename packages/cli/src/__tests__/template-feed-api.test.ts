import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const template = readFileSync(
  resolve(import.meta.dir, "../templates/TESTING.md.tmpl"),
  "utf8"
);

test("TESTING.md.tmpl uses the current source-feed read contract", () => {
  expect(template).toContain(
    'client.feeds.readMany({ reads: [{ feed_id: Number("<feed-id>") }] })'
  );
  expect(template).not.toContain("client.feeds.readMany({ feed_ids:");
});

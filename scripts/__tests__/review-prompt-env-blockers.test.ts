/**
 * `pi-review` is a required status check and `enforce_admins` is on, so a
 * non-empty `blockers` array is unbypassable — review.sh turns `blockers>0`
 * into a red status with no override path.
 *
 * That makes one prompt sentence load-bearing for the whole repo. #2306 hit
 * it: the reviewer runs under `codex exec --sandbox read-only`, the changed
 * test called `mkdtemp`, the write failed with EPERM, and §4 told the
 * reviewer to "record that as a `blocker`" — so a property of the reviewer's
 * own sandbox, not of the diff, blocked main. A re-run with byte-identical
 * content then passed, which is what a gate that measures the environment
 * looks like from the outside.
 *
 * Three other sections (§2, §6, and the Blockers list) already say the
 * opposite: environment problems are `[env]` notes and blockers require a
 * failure the diff caused. This pins that the prompt says it in ONE
 * direction, matching the *shape* of the rule rather than its wording — an
 * exact-string assertion would fail on any honest rewrite while still letting
 * a freshly-worded contradiction through.
 *
 * The fixtures below are the point of the file. Three revisions of this guard
 * were wrong in three different ways, each one passing against a prompt that
 * contradicted itself, so the guard is tested against known-bad and known-good
 * phrasings rather than trusted to be correct by inspection.
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "bun:test";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const PROMPT = join(REPO_ROOT, "prompts/review-prompt.md");

/** Reviewer-side inability to execute — a fact about the sandbox, not the diff. */
const ENV_INABILITY =
  /(environment (itself )?is broken|reviewer's environment|sandbox|read-only|EPERM|execution is unavailable|denies the writes|cannot run|can't run|unable to run|could not run)/i;
const MENTIONS_BLOCKER = /blocker/i;
const CLAUSE_BOUNDARY = /(?<=[.;!?—,])\s*/;

/**
 * The two ways the prompt may legitimately connect an env failure to
 * blockers. Anything else inside an env rule is a contradiction.
 *
 * This is a whitelist because the three revisions before it were blacklists —
 * "does this clause contain a negation" — and each died to a negation that
 * governed a different verb: first across sentences ("Do not retry
 * indefinitely"), then across a semicolon, then across an "and" ("do not hide
 * it and record it as a blocker"). Which verb a `not` attaches to is not
 * something a regex settles, and every patch moved the counter-example one
 * conjunction further out.
 *
 * Inverting it removes the question. A phrasing this does not recognize gets
 * flagged rather than allowed, so an unanticipated rewrite fails loudly on a
 * 250-line document instead of silently reopening an unbypassable gate.
 */
const PROHIBITS_BLOCKER = [
  /\b(?:never|not)\s+a\s+`?blockers?`?/i,
  /\bnot\s+\w+\s+(?:them\s+)?(?:to|under|in|as)\s+`?blockers?`?/i,
];

/**
 * Every clause that ties a reviewer-side inability to `blockers` without
 * prohibiting it. Empty means the prompt states the rule in one direction.
 */
function contradictions(markdown: string): string[] {
  return bullets(markdown)
    .filter((bullet) => ENV_INABILITY.test(bullet))
    .flatMap((bullet) => bullet.split(CLAUSE_BOUNDARY))
    .filter((clause) => MENTIONS_BLOCKER.test(clause))
    .filter(
      (clause) => !PROHIBITS_BLOCKER.some((allowed) => allowed.test(clause))
    )
    .map((clause) => clause.trim());
}

/**
 * Markdown bullets, joined with their indented continuation lines — the rule
 * that broke #2306 spanned three lines, so a line-at-a-time scan misses it.
 */
function bullets(markdown: string): string[] {
  const out: string[] = [];
  let current: string | null = null;
  for (const line of markdown.split("\n")) {
    if (/^- /.test(line)) {
      if (current !== null) out.push(current);
      current = line;
    } else if (current !== null && /^\s+\S/.test(line)) {
      current += ` ${line.trim()}`;
    } else {
      if (current !== null) out.push(current);
      current = null;
    }
  }
  if (current !== null) out.push(current);
  return out;
}

/** Phrasings that must be flagged. Each one defeated an earlier revision. */
const CONTRADICTORY = [
  // The literal §4 rule that red-flagged #2306 twice.
  "- If the environment itself is broken (e.g. you cannot run even a narrow\n  test file), record that as a `blocker` and finish with a partial verdict.",
  // Added alongside a correct rule instead of replacing it — the realistic
  // drift, and what an exact-string guard misses entirely.
  "- When your sandbox denies the writes a narrow test needs, list that under\n  `blockers` so the gap stays visible to the merger.",
  // An unrelated negation earlier in the same sentence; defeats a
  // sentence-scoped negation search.
  "- If your sandbox is read-only, do not hide it; record it as a blocker.",
  // The same, with `and` instead of `;` — no clause boundary at all, which is
  // what defeated the clause-scoped revision.
  "- If your sandbox is read-only, do not hide it and record it as a blocker.",
  // Bare copula, no imperative verb to key on.
  "- A read-only sandbox counts as a `blocker`.",
  // Negation present but attached to something else entirely.
  "- When the reviewer's environment fails, nothing stops you recording a blocker.",
  // A verb the whitelist was never written around.
  "- If you cannot run the suite, escalate it to `blockers`.",
];

/** Phrasings that must NOT be flagged, so the guard stays usable. */
const CONSISTENT = [
  "- If the sandbox is read-only, that is never a `blocker`; put it in `notes`\n  with the `[env]` prefix.",
  "- Environment problems (a read-only sandbox) — DO NOT add them to `blockers`.",
  "- A probe that dies with `EPERM` is not a `blocker`.",
  "- A sandbox denial does not belong in `blockers`.",
];

describe("review prompt: environment failures are never blockers", () => {
  const markdown = readFileSync(PROMPT, "utf8");

  it("states the env-vs-blocker rule in only one direction", () => {
    expect(contradictions(markdown)).toEqual([]);
  });

  it.each(CONTRADICTORY)("flags: %s", (fixture) => {
    expect(contradictions(fixture)).not.toEqual([]);
  });

  it.each(CONSISTENT)("allows: %s", (fixture) => {
    expect(contradictions(fixture)).toEqual([]);
  });

  it("still routes what it cannot run into [env] notes", () => {
    // Deleting the contradictory rule must not delete the guidance with it —
    // an unrunnable suite has to surface somewhere the reader can see. Scope
    // this to the env-inability rules themselves: a bare `[env]` search over
    // the whole prompt passes on any unrelated mention, so it would stay green
    // even if §4 stopped routing what it cannot run into `notes`.
    const envRules = bullets(markdown).filter((bullet) =>
      ENV_INABILITY.test(bullet)
    );
    expect(
      envRules.some(
        (bullet) => /\bnotes\b/i.test(bullet) && /\[env\]/i.test(bullet)
      )
    ).toBe(true);
  });

  it("keeps blockers tied to a failure the diff caused", () => {
    expect(markdown).toMatch(/actually failed and the diff is\s+the cause/);
  });
});

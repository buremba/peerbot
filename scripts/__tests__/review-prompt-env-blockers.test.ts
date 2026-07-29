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
 * direction.
 *
 * It deliberately matches the *shape* of the rule rather than its wording.
 * An exact-string assertion would fail on any honest rewrite while still
 * letting a freshly-worded contradiction through — the guard has to catch
 * the class, since the class is what the reviewer resolved wrongly.
 */

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "bun:test";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const PROMPT = join(REPO_ROOT, "prompts/review-prompt.md");

/** Reviewer-side inability to execute — a fact about the sandbox, not the diff. */
const ENV_INABILITY =
  /(environment (itself )?is broken|reviewer's environment|sandbox|read-only|EPERM|execution is unavailable|denies the writes|cannot run|can't run|unable to run|could not run)/i;
/**
 * Same pattern, global — only for `replace`. It cannot be one shared regex:
 * a `/g` regex carries `lastIndex` across `.test()` calls, so sharing it
 * makes the filter below skip every other bullet. That defect shipped in a
 * draft of this file and let an added contradictory bullet through.
 */
const ENV_INABILITY_ALL = new RegExp(ENV_INABILITY.source, "gi");
const MENTIONS_BLOCKER = /blocker/i;
/**
 * A prohibition ("never a `blocker`", "DO NOT add them to `blockers`") is the
 * rule we want; an instruction ("record that as a `blocker`") is the bug.
 *
 * Two traps make the obvious check useless, and the first revision of this
 * guard fell into both — it passed against the very prompt that broke #2306:
 *   1. Scope. The offending bullet ended "Do not retry indefinitely", so a
 *      negation search over the whole bullet matched a `not` belonging to a
 *      different sentence. Scope to the sentence that says `blocker`.
 *   2. The env phrase negates itself. "you cannot run even a narrow test
 *      file" sits in the same sentence, so its `cannot` reads as the
 *      prohibition. Strip the env phrasing before looking for negation.
 *
 * Kept to bare negatives on purpose: "rather than" / "instead of" appear in
 * the rule's own causation clause, so accepting them as prohibitions would
 * let "record it as a `blocker` rather than a note" pass.
 */
const PROHIBITION = /\b(not|never|n't)\b/i;
const SENTENCES = /[^.!?]+[.!?]?/g;

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

describe("review prompt: environment failures are never blockers", () => {
  const markdown = readFileSync(PROMPT, "utf8");

  it("states the env-vs-blocker rule in only one direction", () => {
    const offenders = bullets(markdown)
      .filter((bullet) => ENV_INABILITY.test(bullet))
      .flatMap((bullet) => bullet.match(SENTENCES) ?? [])
      .filter((sentence) => MENTIONS_BLOCKER.test(sentence))
      .filter(
        (sentence) => !PROHIBITION.test(sentence.replace(ENV_INABILITY_ALL, ""))
      )
      .map((sentence) => sentence.trim());

    expect(offenders).toEqual([]);
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

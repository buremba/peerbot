#!/usr/bin/env node

// The release gate's policy lives here, not in the workflow YAML.
//
// Every rule below used to be an inline jq program duplicated across
// release-please.yml, publish-packages.yml and build-images.yml. Embedded jq
// is unreachable from the test suite, so the copies drifted and the tests only
// ever covered a parallel JS transcription of them. Workflows now pipe JSON
// into the subcommands at the bottom of this file, which makes
// scripts/__tests__/release-publish-order.test.ts a test of the code that
// actually decides whether a release ships.

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const STABLE_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const LOBU_TAG_PREFIX = "lobu-v";
const SHA1 = /^[0-9a-f]{40}$/;

export function parseStableVersion(version) {
  if (typeof version !== "string" || !STABLE_SEMVER.test(version)) {
    throw new Error(`invalid stable Lobu version: ${version}`);
  }
  return version.split(".").map(Number);
}

export function compareVersions(left, right) {
  const a = parseStableVersion(left);
  const b = parseStableVersion(right);
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

export function releaseTagForVersion(version) {
  parseStableVersion(version);
  return `${LOBU_TAG_PREFIX}${version}`;
}

export function versionForReleaseTag(tag) {
  if (typeof tag !== "string" || !tag.startsWith(LOBU_TAG_PREFIX)) {
    throw new Error(`not a Lobu release tag: ${tag}`);
  }
  const version = tag.slice(LOBU_TAG_PREFIX.length);
  parseStableVersion(version);
  return version;
}

/**
 * A release may only move versions forward. Both callers -- the GitHub release
 * list and `npm view @lobu/cli versions` -- reduce to the same question, so
 * they ask it here instead of each spelling out its own comparison.
 */
function normalizeVersionList(versions) {
  return Array.isArray(versions) ? versions : [versions];
}

export function assertNoNewerStable({ current, versions }) {
  parseStableVersion(current);
  const listed = normalizeVersionList(versions);
  // Fail closed on a shape we do not understand. `npm view --json` prints its
  // error object to stdout, so a failed probe can reach here looking like data;
  // silently filtering it out would turn "the registry is unreadable" into
  // "nothing newer is published", which is exactly backwards for a gate.
  const unexpected = listed.filter((value) => typeof value !== "string");
  if (unexpected.length > 0) {
    throw new Error(
      `version list holds ${unexpected.length} non-version entr${unexpected.length === 1 ? "y" : "ies"}`
    );
  }
  const stable = listed.filter((value) => STABLE_SEMVER.test(value));
  const newer = stable.filter((value) => compareVersions(value, current) > 0);
  if (newer.length > 0) {
    throw new Error(
      `a newer stable version than ${current} already exists: ${newer.join(", ")}`
    );
  }
  return { ok: true, current, compared: stable.length };
}

/**
 * Whether the manifest version at the attested commit still needs a GitHub
 * release. Deliberately stateless -- it asks "is this version released yet",
 * never "did THIS commit perform the bump". Keying on a parent diff gave a
 * release a window only as wide as the gap between merging the release PR and
 * the next merge to main, because the bump commit stops being main's tip the
 * moment anything lands behind it. On 2026-09-03 that window was six minutes:
 * 18.0.0 was stranded unreleased, and because release-please refuses to open a
 * new release PR while an untagged merged one is outstanding, every subsequent
 * release was blocked behind it. Asking about the release list instead makes
 * the decision idempotent, so a build that arrives late still cuts the release
 * rather than declining forever.
 */
export function releaseNeeded({ current, versions }) {
  assertNoNewerStable({ current, versions });
  const listed = normalizeVersionList(versions);
  // Exact match, so a prerelease such as 18.0.0-rc.1 is never mistaken for the
  // stable 18.0.0 it precedes -- no stable-only filter needed here. Non-string
  // entries were already rejected by assertNoNewerStable, which fails closed on
  // an unreadable version list rather than reporting "nothing released yet".
  return { needed: !listed.includes(current), version: current };
}

function flattenJobs(pages) {
  if (!Array.isArray(pages)) throw new Error("jobs response must be paginated");
  return pages.flatMap((page) => {
    if (!page || !Array.isArray(page.jobs)) {
      throw new Error("jobs page has no jobs array");
    }
    return page.jobs;
  });
}

/**
 * Pick each required job's newest attempt and insist it is completed-success.
 * A re-run that leaves two rows with the same attempt number is ambiguous
 * evidence, so it fails closed rather than picking one.
 */
export function selectLatestRequiredJobs(pages, requiredNames) {
  if (!Array.isArray(requiredNames) || requiredNames.length === 0) {
    throw new Error("no required job names given");
  }
  const jobs = flattenJobs(pages);
  return requiredNames.map((name) => {
    const matches = jobs.filter((job) => job.name === name);
    if (matches.length === 0) throw new Error(`missing required job: ${name}`);
    const latestAttempt = Math.max(
      ...matches.map((job) => job.run_attempt ?? 1)
    );
    const latest = matches.filter(
      (job) => (job.run_attempt ?? 1) === latestAttempt
    );
    if (latest.length !== 1) {
      throw new Error(`duplicate latest-attempt required job: ${name}`);
    }
    const job = latest[0];
    if (job.status !== "completed" || job.conclusion !== "success") {
      throw new Error(`required job is not completed-success: ${name}`);
    }
    return job;
  });
}

export function selectUniqueLatestRun(runs, expected) {
  if (!Array.isArray(runs)) throw new Error("runs must be an array");
  const candidates = runs.filter((run) =>
    Object.entries(expected).every(([key, value]) => run[key] === value)
  );
  if (candidates.length === 0) throw new Error("no matching successful run");
  const latestAttempt = Math.max(
    ...candidates.map((run) => run.run_attempt ?? 1)
  );
  const latest = candidates.filter(
    (run) => (run.run_attempt ?? 1) === latestAttempt
  );
  if (latest.length !== 1) throw new Error("ambiguous latest run attempt");
  return latest[0];
}

/**
 * Resolve what a release tag actually points at. An annotated tag's ref names
 * the tag object, not the commit, so a caller that compares `ref.object.sha`
 * to a commit SHA silently accepts a tag that was re-pointed. `tagObject` is
 * the peeled `git/tags/<sha>` response, required only for annotated tags.
 */
export function peelTag({ tagRef, tagObject }) {
  const type = tagRef?.object?.type;
  const sha = tagRef?.object?.sha;
  if (type !== "commit" && type !== "tag") {
    throw new Error(`unexpected tag ref object type: ${type}`);
  }
  const peeled = type === "tag" ? tagObject?.object?.sha : sha;
  if (typeof peeled !== "string" || !SHA1.test(peeled)) {
    throw new Error("could not peel release tag to a commit");
  }
  return peeled;
}

/**
 * The one binding check shared by release creation, image builds and package
 * publication: this tag, this release and this commit are the same artifact,
 * and it is a published stable release.
 */
export function verifyImmutableRelease({
  release,
  tagRef,
  tagObject,
  expectedTag,
  expectedSha,
}) {
  if (release?.tag_name !== expectedTag) {
    throw new Error("release tag/name mismatch");
  }
  if (release.draft === true) throw new Error("release is a draft");
  if (release.prerelease === true) throw new Error("release is a prerelease");
  versionForReleaseTag(expectedTag);
  const sha = peelTag({ tagRef, tagObject });
  if (expectedSha !== undefined && sha !== expectedSha) {
    throw new Error("release does not target attested commit");
  }
  // `target_commitish` is only a creation hint. GitHub stores a branch name
  // when a release is cut from a branch and ignores the field entirely when
  // the tag already exists, so it binds the release to a commit only when it
  // is itself a commit SHA. The peeled tag above is the authoritative binding.
  if (
    SHA1.test(release.target_commitish ?? "") &&
    release.target_commitish !== sha
  ) {
    throw new Error("release target does not match peeled tag");
  }
  return { sha, version: versionForReleaseTag(expectedTag) };
}

/**
 * The release body is this version's changelog entry, not the head of the
 * whole file. release-please writes one `## [<version>](...)` section per
 * release, newest first, so the entry runs to the next `## ` heading.
 */
export function releaseNotesFor({ changelog, version }) {
  parseStableVersion(version);
  const lines = String(changelog ?? "").split("\n");
  const isHeading = (line) => /^## /.test(line);
  const start = lines.findIndex(
    (line) => isHeading(line) && line.includes(`[${version}]`)
  );
  // A missing entry is not fatal: the release still has to be created, and an
  // empty body costs a reader one click to the changelog.
  if (start < 0) return { version, notes: "", found: false };
  const rest = lines.slice(start + 1);
  const end = rest.findIndex(isHeading);
  const notes = (end < 0 ? rest : rest.slice(0, end)).join("\n").trim();
  return { version, notes, found: true };
}

/** Subcommands the workflows pipe JSON into. Every one is covered by
 * scripts/__tests__/release-publish-order.test.ts, which also asserts that no
 * workflow invokes a name that is missing from this table. */
const COMMANDS = {
  "attest-jobs": (input) => {
    selectLatestRequiredJobs(input.pages, input.required);
    return { ok: true, required: input.required.length };
  },
  "select-run": (input) => ({
    id: String(selectUniqueLatestRun(input.runs, input.expected).id),
  }),
  "assert-newer": (input) => assertNoNewerStable(input),
  "release-needed": (input) => releaseNeeded(input),
  "release-tag": (input) => ({ tag: releaseTagForVersion(input.version) }),
  "verify-release": (input) => verifyImmutableRelease(input),
  "release-notes": (input) => releaseNotesFor(input),
};

export const COMMAND_NAMES = Object.keys(COMMANDS);

// Compare real paths: a URL pathname is percent-encoded and neither side is
// symlink-resolved, so the naive comparison made this file exit 0 printing
// nothing whenever the checkout path had a space or a symlinked parent -- a
// release gate that fails open.
const invokedPath = process.argv[1] ? realpathSync(process.argv[1]) : "";
if (
  invokedPath &&
  realpathSync(fileURLToPath(import.meta.url)) === invokedPath
) {
  const command = process.argv[2];
  const run = COMMANDS[command];
  if (!run) {
    process.stderr.write(
      `unknown command: ${command}\nexpected one of: ${Object.keys(COMMANDS).join(", ")}\n`
    );
    process.exit(2);
  }
  const raw = await new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
  process.stdout.write(`${JSON.stringify(run(JSON.parse(raw)))}\n`);
}

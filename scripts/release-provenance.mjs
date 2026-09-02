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

export function manifestBump({ current, parent }) {
  parseStableVersion(current);
  parseStableVersion(parent);
  if (current === parent) return { bumped: false, version: current };
  if (compareVersions(current, parent) <= 0) {
    throw new Error(`release version ${current} is not newer than ${parent}`);
  }
  return { bumped: true, version: current };
}

/**
 * A release may only move versions forward. Both callers -- the GitHub release
 * list and `npm view @lobu/cli versions` -- reduce to the same question, so
 * they ask it here instead of each spelling out its own comparison.
 */
export function assertNoNewerStable({ current, versions }) {
  parseStableVersion(current);
  const stable = (Array.isArray(versions) ? versions : [versions]).filter(
    (value) => typeof value === "string" && STABLE_SEMVER.test(value)
  );
  const newer = stable.filter((value) => compareVersions(value, current) > 0);
  if (newer.length > 0) {
    throw new Error(
      `a newer stable version than ${current} already exists: ${newer.join(", ")}`
    );
  }
  return { ok: true, current, compared: stable.length };
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
  if (release.prerelease === true || release.make_latest === false) {
    throw new Error(
      "stable release cannot be prerelease or excluded from latest"
    );
  }
  versionForReleaseTag(expectedTag);
  const sha = peelTag({ tagRef, tagObject });
  if (expectedSha !== undefined && sha !== expectedSha) {
    throw new Error("release does not target attested commit");
  }
  if (release.target_commitish !== sha) {
    throw new Error("release target does not match peeled tag");
  }
  return { sha, version: versionForReleaseTag(expectedTag) };
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
  "manifest-bump": (input) => manifestBump(input),
  "release-tag": (input) => ({ tag: releaseTagForVersion(input.version) }),
  "verify-release": (input) => verifyImmutableRelease(input),
};

export const COMMAND_NAMES = Object.keys(COMMANDS);

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
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

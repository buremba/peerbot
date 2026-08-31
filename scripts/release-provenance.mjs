#!/usr/bin/env node

const STABLE_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const LOBU_TAG_PREFIX = "lobu-v";

export function parseStableVersion(version) {
  if (!STABLE_SEMVER.test(version)) {
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

export function manifestBump({ current, parent }) {
  parseStableVersion(current);
  parseStableVersion(parent);
  if (current === parent) return { bumped: false, version: current };
  if (compareVersions(current, parent) <= 0) {
    throw new Error(`release version ${current} is not newer than ${parent}`);
  }
  return { bumped: true, version: current };
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

export function selectLatestRequiredJobs(pages, requiredNames) {
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

export function verifyImmutableRelease({
  tag,
  release,
  expectedTag,
  expectedSha,
}) {
  if (tag.name !== expectedTag || release.tag_name !== expectedTag) {
    throw new Error("release tag/name mismatch");
  }
  if (tag.sha !== expectedSha || release.target_commitish !== expectedSha) {
    throw new Error("release does not target attested commit");
  }
  if (release.prerelease || release.make_latest === false) {
    throw new Error(
      "stable release cannot be prerelease or excluded from latest"
    );
  }
  return true;
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  const input = JSON.parse(
    await new Promise((resolve, reject) => {
      let data = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => (data += chunk));
      process.stdin.on("end", () => resolve(data));
      process.stdin.on("error", reject);
    })
  );
  const output =
    input.command === "tag"
      ? { tag: releaseTagForVersion(input.version) }
      : input.command === "bump"
        ? manifestBump({ current: input.current, parent: input.parent })
        : selectLatestRequiredJobs(input.pages, input.required);
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

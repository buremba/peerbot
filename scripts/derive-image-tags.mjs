#!/usr/bin/env node
/**
 * Decide which docker tags a build-images run publishes.
 *
 * `latest` used to be pushed on every main commit, so a self-hoster pulling
 * ghcr.io/lobu-ai/lobu-app:latest got an arbitrary build and no tag identified
 * a release at all (#2184). This derives, for one workflow run:
 *
 *   tag            shared deployment tag when this run publishes images
 *   semver         version tag to publish ("" = none)
 *   is_stable      whether `latest` moves to this build
 *   should_publish whether the build jobs run at all
 *
 * Lives here rather than inline in the workflow so the decision table has a
 * narrow unit-test path.
 */

import { appendFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** release-please publishes lobu-vX.Y.Z; other repos' releases share this feed. */
const LOBU_TAG_PREFIX = "lobu-v";

const MAX_RUN_NUMBER = 999999;

/**
 * Build `<UTC date>-<UTC time>-<run number>`. Flux orders by the timestamp so
 * rerunning an older workflow after a newer run still deploys the rerun. The
 * run number distinguishes separate runs created in the same second.
 *
 * All components are fixed-width because the matching ImagePolicy concatenates
 * them and compares the result lexicographically.
 *
 * @param {{now: Date, runNumber: number|string}} input
 * @returns {string}
 * @throws when runNumber is not a positive integer or exceeds six digits.
 */
export function buildImageTag({ now, runNumber }) {
  const n = Number(runNumber);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`run number '${runNumber}' is not a positive integer.`);
  }
  if (n > MAX_RUN_NUMBER) {
    throw new Error(
      `run number ${n} exceeds the 6 digits the tag format allows.`
    );
  }
  const pad = (value, width) => String(value).padStart(width, "0");
  const date = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1, 2)}${pad(now.getUTCDate(), 2)}`;
  const time = `${pad(now.getUTCHours(), 2)}${pad(now.getUTCMinutes(), 2)}${pad(now.getUTCSeconds(), 2)}`;
  return `${date}-${time}-${pad(n, 6)}`;
}

/** Full SemVer 2.0.0 (semver.org). A loose \d+\.\d+\.\d+ accepts `01.2.3`. */
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/**
 * @param {{eventName?: string, releaseTag?: string, prerelease?: boolean|string}} input
 * @returns {{semver: string, is_stable: boolean, should_publish: boolean}}
 * @throws when a lobu-v* release carries a tag that is not valid semver.
 */
export function deriveImageTags({
  eventName = "",
  releaseTag = "",
  prerelease = false,
} = {}) {
  // Not a release: main pushes and workflow_dispatch publish the deployment tag
  // only. That is the #2184 fix — `latest` no longer follows every commit.
  if (eventName !== "release") {
    return { semver: "", is_stable: false, should_publish: true };
  }

  // A release from another component (owletto-mac-v*) shares this event feed.
  // Skip the whole build rather than publishing an unrelated `latest`.
  if (!releaseTag.startsWith(LOBU_TAG_PREFIX)) {
    return { semver: "", is_stable: false, should_publish: false };
  }

  const semver = releaseTag.slice(LOBU_TAG_PREFIX.length);
  if (!SEMVER.test(semver)) {
    throw new Error(
      `Refusing to use release tag '${releaseTag}' — '${semver}' is not valid semver.`
    );
  }

  // `latest` tracks STABLE releases only. A prerelease keeps its own version
  // tag so it stays installable, but must not become what a bare
  // `docker pull ghcr.io/lobu-ai/lobu-app` resolves to. Checked against the
  // semver string as well as GitHub's flag, which release-please sets only
  // when explicitly told to.
  const flagged = prerelease === true || prerelease === "true";
  const is_stable = !flagged && !semver.includes("-");

  return { semver, is_stable, should_publish: true };
}

/** True when this file was run directly rather than imported. */
function isMainModule() {
  try {
    return (
      realpathSync(fileURLToPath(import.meta.url)) ===
      realpathSync(process.argv[1])
    );
  } catch {
    return false;
  }
}

// Invoked from the workflow: writes GitHub Actions outputs.
//
// Compares real paths, not filenames and not raw URLs. A filename check
// no-ops if the file is renamed or copied; a raw URL compare no-ops when the
// path contains a symlink, because import.meta.url is already resolved while
// argv[1] is not (macOS /tmp -> /private/tmp is the everyday case). Either
// way the failure is silent — the workflow reads empty tag outputs rather
// than seeing an error — so resolve both sides.
if (process.argv[1] && isMainModule()) {
  let result;
  let tag;
  try {
    result = deriveImageTags({
      eventName: process.env.EVENT_NAME,
      releaseTag: process.env.RELEASE_TAG,
      prerelease: process.env.PRERELEASE,
    });
    // RUN_NUMBER is required so a missing workflow input fails at its source
    // instead of surfacing an empty tag to the build jobs.
    tag = buildImageTag({
      now: new Date(),
      runNumber: process.env.RUN_NUMBER,
    });
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exit(1);
  }
  const lines = [
    `tag=${tag}`,
    `semver=${result.semver}`,
    `is_stable=${result.is_stable}`,
    `should_publish=${result.should_publish}`,
  ];
  console.log(lines.join("\n"));
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
  }
}

#!/usr/bin/env node
/**
 * Decide which docker tags a build-images run publishes.
 *
 * `latest` used to be pushed on every main commit, so a self-hoster pulling
 * ghcr.io/lobu-ai/lobu-app:latest got an arbitrary build and no tag identified
 * a release at all (#2184). This derives, for one workflow run:
 *
 *   semver         version tag to publish ("" = none)
 *   is_stable      whether `latest` moves to this build
 *   should_publish whether the build jobs run at all
 *
 * Lives here rather than inline in the workflow so it can be unit-tested —
 * embedded YAML shell is only exercisable by cutting a real release.
 */

import { appendFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** release-please publishes lobu-vX.Y.Z; other repos' releases share this feed. */
const LOBU_TAG_PREFIX = "lobu-v";

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
  // Not a release: main pushes and workflow_dispatch publish the timestamp tag
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
  try {
    result = deriveImageTags({
      eventName: process.env.EVENT_NAME,
      releaseTag: process.env.RELEASE_TAG,
      prerelease: process.env.PRERELEASE,
    });
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exit(1);
  }
  const lines = [
    `semver=${result.semver}`,
    `is_stable=${result.is_stable}`,
    `should_publish=${result.should_publish}`,
  ];
  console.log(lines.join("\n"));
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
  }
}

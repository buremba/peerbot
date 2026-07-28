#!/usr/bin/env node
/**
 * Audit that the newest stable lobu release actually exists in ghcr.
 *
 * A release that publishes no image is invisible from inside the pipeline: on
 * 2026-07-28 the lobu-v14.4.0 build-images run was evicted from its
 * concurrency queue before it started, so no job anywhere failed — `14.4.0`
 * simply never appeared in ghcr and `latest` stayed on a pre-release build
 * for hours. No step inside build-images can catch a run that never executes,
 * so this compares intent (the newest stable GitHub release) against reality
 * (what ghcr serves) from the outside, on a schedule.
 *
 * Probes ghcr ANONYMOUSLY on purpose: that is the exact path a self-hoster's
 * `docker pull` takes, so the audit also fails if a package is accidentally
 * flipped private — a breakage no authenticated check would see.
 *
 * Lives here rather than inline in the workflow so the decision table is
 * unit-tested (scripts/__tests__/audit-release-images.test.ts); the network
 * fetches stay in the thin CLI below.
 */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const LOBU_TAG_PREFIX = "lobu-v";
const RELEASES_PER_PAGE = 100;
export const IMAGES = ["lobu-app", "lobu-worker", "lobu-embeddings"];

/**
 * Builds finish in ~10-25 minutes; the grace period only delays detection, so
 * it errs long to never flag a release whose build is legitimately still
 * running or queued.
 */
export const GRACE_MINUTES = 45;

/**
 * Pick the release whose images ghcr must serve: the newest non-draft,
 * non-prerelease lobu-v* release. Mirrors derive-image-tags.mjs: `latest`
 * moves only for releases that are stable by BOTH GitHub's flag and the
 * version string, so anything else is not audited against `latest`.
 *
 * @param {Array<{tag_name?: string, draft?: boolean, prerelease?: boolean, published_at?: string}>} releases
 *   newest-first, as the GitHub API returns them.
 * @returns {{version: string, publishedAt: string} | null}
 */
export function pickAuditedRelease(releases) {
  for (const release of releases ?? []) {
    const tag = release.tag_name ?? "";
    if (!tag.startsWith(LOBU_TAG_PREFIX)) continue;
    if (release.draft || release.prerelease) continue;
    const version = tag.slice(LOBU_TAG_PREFIX.length);
    if (version.includes("-")) continue;
    if (!release.published_at) continue;
    return { version, publishedAt: release.published_at };
  }
  return null;
}

/**
 * Fetch release pages until the newest stable Lobu release is found.
 *
 * This repository also publishes Owletto releases, so the first API page is
 * not guaranteed to contain a Lobu release.
 */
export async function fetchAuditedRelease({ repo, token, fetchImpl = fetch }) {
  for (let page = 1; ; page += 1) {
    const response = await fetchImpl(
      `https://api.github.com/repos/${repo}/releases?per_page=${RELEASES_PER_PAGE}&page=${page}`,
      {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      }
    );
    if (!response.ok) {
      throw new Error(`listing releases failed: HTTP ${response.status}`);
    }

    const releases = await response.json();
    const release = pickAuditedRelease(releases);
    if (release) return release;
    if (releases.length < RELEASES_PER_PAGE) return null;
  }
}

/**
 * The decision table, pure so it is testable: given the audited release and
 * the digests ghcr returned (null = manifest missing/unreadable), decide
 * skip/ok/fail.
 *
 * `latest` must carry the SAME digest as the version tag: both are pushed by
 * one build, so a mismatch means `latest` was left behind on an older build —
 * the exact symptom the 14.4.0 eviction produced.
 *
 * @param {{
 *   release: {version: string, publishedAt: string} | null,
 *   now: Date,
 *   digests: Record<string, {semver: string|null, latest: string|null}>,
 * }} input
 * @returns {{status: "skip"|"ok"|"fail", problems: string[], reason?: string}}
 */
export function auditRelease({ release, now, digests }) {
  if (!release) {
    return { status: "skip", problems: [], reason: "no stable lobu release" };
  }
  const ageMinutes =
    (now.getTime() - new Date(release.publishedAt).getTime()) / 60000;
  if (ageMinutes < GRACE_MINUTES) {
    return {
      status: "skip",
      problems: [],
      reason: `release is ${Math.round(ageMinutes)}min old; its build may still be running (grace ${GRACE_MINUTES}min)`,
    };
  }

  const problems = [];
  for (const image of IMAGES) {
    const { semver = null, latest = null } = digests[image] ?? {};
    if (!semver) {
      problems.push(
        `${image}: tag ${release.version} is not anonymously pullable from ghcr — the release build never published it, or the package went private`
      );
      continue;
    }
    if (!latest) {
      problems.push(
        `${image}: tag latest is not anonymously pullable from ghcr`
      );
    } else if (latest !== semver) {
      problems.push(
        `${image}: latest (${latest}) is not the ${release.version} build (${semver}) — latest was left on an older image`
      );
    }
  }
  return { status: problems.length ? "fail" : "ok", problems };
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

/** Anonymous manifest digest for one tag, or null when it is not pullable. */
export async function fetchDigest({ image, tag, fetchImpl = fetch }) {
  const scope = `repository:lobu-ai/${image}:pull`;
  const tokenRes = await fetchImpl(`https://ghcr.io/token?scope=${scope}`);
  if (!tokenRes.ok) return null;
  const { token } = await tokenRes.json();
  const res = await fetchImpl(
    `https://ghcr.io/v2/lobu-ai/${image}/manifests/${tag}`,
    {
      method: "HEAD",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: [
          "application/vnd.oci.image.index.v1+json",
          "application/vnd.docker.distribution.manifest.list.v2+json",
          "application/vnd.docker.distribution.manifest.v2+json",
        ].join(","),
      },
    }
  );
  if (!res.ok) return null;
  return res.headers.get("docker-content-digest");
}

if (process.argv[1] && isMainModule()) {
  const repo = process.env.GITHUB_REPOSITORY ?? "lobu-ai/lobu";
  let release;
  try {
    release = await fetchAuditedRelease({
      repo,
      token: process.env.GH_TOKEN,
    });
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exit(1);
  }

  const digests = {};
  if (release) {
    for (const image of IMAGES) {
      digests[image] = {
        semver: await fetchDigest({ image, tag: release.version }),
        latest: await fetchDigest({ image, tag: "latest" }),
      };
    }
  }

  const verdict = auditRelease({ release, now: new Date(), digests });
  if (verdict.status === "skip") {
    console.log(`Skipping: ${verdict.reason}`);
    process.exit(0);
  }
  if (verdict.status === "ok") {
    console.log(
      `ghcr serves ${release.version} (and latest matches) for: ${IMAGES.join(", ")}`
    );
    process.exit(0);
  }
  for (const problem of verdict.problems) {
    console.error(`::error::${problem}`);
  }
  process.exit(1);
}

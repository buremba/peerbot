import { describe, expect, it } from "bun:test";
import {
  GRACE_MINUTES,
  IMAGES,
  auditRelease,
  fetchAuditedRelease,
  pickAuditedRelease,
  // @ts-expect-error — plain .mjs script, no type declarations by design.
} from "../audit-release-images.mjs";

/**
 * The audit exists because a release build evicted from its concurrency queue
 * fails NOTHING — lobu-v14.4.0 published no image for hours with every
 * workflow green. These pin the decision table: what counts as the audited
 * release, when to hold off, and which registry states are the incident.
 */

const digest = (n: number) => `sha256:${String(n).repeat(8)}`;
const allImages = (semver: string | null, latest: string | null) =>
  Object.fromEntries(IMAGES.map((image) => [image, { semver, latest }]));

describe("pickAuditedRelease", () => {
  it("picks the newest stable lobu release, skipping the shared feed's noise", () => {
    // The release feed interleaves mac releases and prereleases; none of
    // those move `latest`, so none of them is what ghcr must serve.
    expect(
      pickAuditedRelease([
        {
          tag_name: "owletto-mac-v2.1.0",
          published_at: "2026-07-28T15:00:00Z",
        },
        {
          tag_name: "lobu-v15.0.0-beta.1",
          published_at: "2026-07-28T14:00:00Z",
        },
        {
          tag_name: "lobu-v14.5.0",
          prerelease: true,
          published_at: "2026-07-28T13:00:00Z",
        },
        {
          tag_name: "lobu-v14.4.1",
          draft: true,
          published_at: "2026-07-28T12:00:00Z",
        },
        { tag_name: "lobu-v14.4.0", published_at: "2026-07-28T11:00:00Z" },
      ])
    ).toEqual({ version: "14.4.0", publishedAt: "2026-07-28T11:00:00Z" });
  });

  it("returns null when no stable lobu release exists", () => {
    expect(pickAuditedRelease([])).toBeNull();
    expect(
      pickAuditedRelease([
        {
          tag_name: "owletto-mac-v2.1.0",
          published_at: "2026-07-28T15:00:00Z",
        },
      ])
    ).toBeNull();
  });
});

describe("fetchAuditedRelease", () => {
  it("continues past a full page of unrelated releases", async () => {
    const pages = [
      Array.from({ length: 100 }, (_, index) => ({
        tag_name: `owletto-mac-v2.${index}.0`,
        published_at: "2026-07-28T15:00:00Z",
      })),
      [
        {
          tag_name: "lobu-v14.4.0",
          published_at: "2026-07-28T11:00:00Z",
        },
      ],
    ];
    const requests: string[] = [];

    const release = await fetchAuditedRelease({
      repo: "lobu-ai/lobu",
      token: "test-token",
      fetchImpl: async (url: string | URL | Request, init?: RequestInit) => {
        requests.push(String(url));
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer test-token"
        );
        return Response.json(pages[requests.length - 1]);
      },
    });

    expect(release).toEqual({
      version: "14.4.0",
      publishedAt: "2026-07-28T11:00:00Z",
    });
    expect(requests).toEqual([
      "https://api.github.com/repos/lobu-ai/lobu/releases?per_page=100&page=1",
      "https://api.github.com/repos/lobu-ai/lobu/releases?per_page=100&page=2",
    ]);
  });

  it("returns null after exhausting the release feed", async () => {
    const release = await fetchAuditedRelease({
      repo: "lobu-ai/lobu",
      fetchImpl: async () => Response.json([]),
    });

    expect(release).toBeNull();
  });

  it("fails closed when GitHub cannot list releases", async () => {
    expect(
      fetchAuditedRelease({
        repo: "lobu-ai/lobu",
        fetchImpl: async () => new Response(null, { status: 503 }),
      })
    ).rejects.toThrow("listing releases failed: HTTP 503");
  });
});

describe("auditRelease", () => {
  const release = { version: "14.4.0", publishedAt: "2026-07-28T12:00:00Z" };
  const wellAfter = new Date("2026-07-28T14:00:00Z");

  it("skips while the release build may legitimately still be running", () => {
    // One minute inside the grace period: flagging here would page on every
    // normal release, which is how alerts get muted and then missed.
    const justUnder = new Date(
      new Date(release.publishedAt).getTime() + (GRACE_MINUTES - 1) * 60000
    );
    const verdict = auditRelease({
      release,
      now: justUnder,
      digests: allImages(null, null),
    });
    expect(verdict.status).toBe("skip");
  });

  it("passes when every image serves the version and latest matches it", () => {
    const verdict = auditRelease({
      release,
      now: wellAfter,
      digests: allImages(digest(1), digest(1)),
    });
    expect(verdict).toEqual({ status: "ok", problems: [] });
  });

  it("fails when the version tag never appeared — the 14.4.0 eviction", () => {
    const verdict = auditRelease({
      release,
      now: wellAfter,
      digests: allImages(null, digest(1)),
    });
    expect(verdict.status).toBe("fail");
    expect(verdict.problems).toHaveLength(IMAGES.length);
    expect(verdict.problems[0]).toContain("14.4.0");
  });

  it("fails when latest was left behind on an older build", () => {
    // The user-facing half of the incident: `docker pull …:latest` kept
    // resolving to a pre-release image even after the release existed.
    const verdict = auditRelease({
      release,
      now: wellAfter,
      digests: allImages(digest(1), digest(2)),
    });
    expect(verdict.status).toBe("fail");
    expect(verdict.problems[0]).toContain("left on an older image");
  });

  it("fails when a single sibling image is missing", () => {
    // The chart applies ONE tag to app, worker, and embeddings; a partial
    // publish rolls prod onto a tag whose sibling does not exist.
    const digests = allImages(digest(1), digest(1));
    digests["lobu-worker"] = { semver: null, latest: digest(1) };
    const verdict = auditRelease({ release, now: wellAfter, digests });
    expect(verdict.status).toBe("fail");
    expect(verdict.problems).toHaveLength(1);
    expect(verdict.problems[0]).toContain("lobu-worker");
  });

  it("treats missing digest data as a failure, not a pass", () => {
    // An empty digests map must read as "nothing pullable", never as "ok" —
    // otherwise a broken probe silently disables the audit.
    const verdict = auditRelease({ release, now: wellAfter, digests: {} });
    expect(verdict.status).toBe("fail");
    expect(verdict.problems).toHaveLength(IMAGES.length);
  });

  it("skips when there is no stable release to audit", () => {
    const verdict = auditRelease({
      release: null,
      now: wellAfter,
      digests: {},
    });
    expect(verdict.status).toBe("skip");
  });
});

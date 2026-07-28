import { describe, expect, it } from "bun:test";
// @ts-expect-error — plain .mjs script, no type declarations by design.
import { deriveImageTags } from "../derive-image-tags.mjs";

/**
 * `latest` used to move on every main push, so self-hosters pulling it got an
 * arbitrary commit and no tag identified a release (#2184). These pin the
 * decision table down; before this the logic was shell inside YAML, only
 * exercisable by cutting a real release.
 */
describe("deriveImageTags", () => {
  it("publishes no version tag and never moves latest on a main push", () => {
    // The #2184 regression itself: a plain push must publish the timestamp
    // tag only. should_publish stays true — main builds still deploy.
    expect(deriveImageTags({ eventName: "push" })).toEqual({
      semver: "",
      is_stable: false,
      should_publish: true,
    });
  });

  it("publishes the version tag and moves latest for a stable release", () => {
    expect(
      deriveImageTags({ eventName: "release", releaseTag: "lobu-v14.3.0" })
    ).toEqual({ semver: "14.3.0", is_stable: true, should_publish: true });
  });

  it("keeps latest off a prerelease flagged only by its semver suffix", () => {
    // release-please sets GitHub's prerelease flag only when told to, so the
    // string must be checked too or `latest` silently follows a beta.
    expect(
      deriveImageTags({
        eventName: "release",
        releaseTag: "lobu-v15.0.0-beta.1",
      })
    ).toEqual({
      semver: "15.0.0-beta.1",
      is_stable: false,
      should_publish: true,
    });
  });

  it("keeps latest off a prerelease flagged only by GitHub", () => {
    for (const prerelease of [true, "true"]) {
      expect(
        deriveImageTags({
          eventName: "release",
          releaseTag: "lobu-v15.0.0",
          prerelease,
        }).is_stable,
        `prerelease=${JSON.stringify(prerelease)} must not move latest`
      ).toBe(false);
    }
  });

  it("skips the build entirely for another component's release", () => {
    // owletto-mac-v* shares this event feed. Building would burn a full run to
    // produce no new tag, and must never move Lobu's `latest`.
    expect(
      deriveImageTags({
        eventName: "release",
        releaseTag: "owletto-mac-v2.1.0",
      })
    ).toEqual({ semver: "", is_stable: false, should_publish: false });
  });

  it("refuses a lobu release whose tag is not valid semver", () => {
    // Prefix-stripping alone would hand `01.2.3` or `next` to docker as a tag.
    for (const tag of ["lobu-v01.2.3", "lobu-vnext", "lobu-v1.2", "lobu-v"]) {
      expect(
        () => deriveImageTags({ eventName: "release", releaseTag: tag }),
        `${tag} must be rejected`
      ).toThrow(/not valid semver/);
    }
  });

  it("accepts a build-metadata release without moving latest off it", () => {
    const result = deriveImageTags({
      eventName: "release",
      releaseTag: "lobu-v1.0.0-alpha.1+build.7",
    });
    expect(result.semver).toBe("1.0.0-alpha.1+build.7");
    expect(result.is_stable).toBe(false);
  });
});

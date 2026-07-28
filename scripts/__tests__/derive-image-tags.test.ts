import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "bun:test";
// @ts-expect-error — plain .mjs script, no type declarations by design.
import { deriveImageTags } from "../derive-image-tags.mjs";

const SCRIPT = fileURLToPath(
  new URL("../derive-image-tags.mjs", import.meta.url)
);

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

/**
 * The workflow consumes this script as a subprocess, so the CLI half needs its
 * own coverage: the exported function can be perfect while the main block never
 * runs. That is not hypothetical — a `process.argv[1].endsWith(name)` guard, and
 * later a raw `import.meta.url === pathToFileURL(argv[1]).href` compare, both
 * silently produced NO output when the path contained a symlink (macOS
 * /tmp -> /private/tmp). The job still exits 0, so the workflow just reads empty
 * tags and publishes nothing.
 */
describe("derive-image-tags CLI", () => {
  // Must be literal "node", NOT process.execPath: under `bun test` execPath is
  // bun, which both runs a different runtime than CI's `node scripts/...` and
  // resolves a symlinked argv[0] before exec — silently defeating the symlink
  // case below. The workflow invokes node, so the test must too.
  const run = (env: Record<string, string>, scriptPath = SCRIPT) => {
    const dir = mkdtempSync(join(tmpdir(), "derive-tags-"));
    const outFile = join(dir, "gh-output");
    writeFileSync(outFile, "");
    try {
      const proc = spawnSync("node", [scriptPath], {
        env: { ...process.env, ...env, GITHUB_OUTPUT: outFile },
        encoding: "utf8",
      });
      return { status: proc.status, output: readFileSync(outFile, "utf8") };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("writes every output GITHUB_OUTPUT consumer reads", () => {
    const { status, output } = run({
      EVENT_NAME: "release",
      RELEASE_TAG: "lobu-v14.4.0",
      PRERELEASE: "false",
    });
    expect(status).toBe(0);
    // The workflow keys `latest` and the version tag off these exact names;
    // a missing line reads as "no release" rather than as a failure.
    expect(output).toContain("semver=14.4.0");
    expect(output).toContain("is_stable=true");
    expect(output).toContain("should_publish=true");
  });

  it("still runs when invoked through a symlink with a different name", () => {
    // The symlink must point at a DIFFERENTLY-NAMED file for this to bite.
    // A same-name copy passes under every broken guard tried here: Node
    // derives import.meta.url from the argv[1] string it was handed, so both
    // sides agree until the link name and the real name diverge.
    const dir = mkdtempSync(join(tmpdir(), "derive-tags-link-"));
    const real = join(dir, "derive-image-tags.mjs");
    const link = join(dir, "run-tags.mjs");
    try {
      writeFileSync(real, readFileSync(SCRIPT, "utf8"));
      symlinkSync(real, link);
      const { status, output } = run(
        { EVENT_NAME: "release", RELEASE_TAG: "lobu-v14.4.0" },
        link
      );
      expect(status).toBe(0);
      expect(output).toContain("semver=14.4.0");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails the job on an unparseable release tag", () => {
    // Must be non-zero: exiting 0 with empty outputs would let the build
    // proceed and quietly publish no version tag.
    const { status, output } = run({
      EVENT_NAME: "release",
      RELEASE_TAG: "lobu-vnext",
    });
    expect(status).toBe(1);
    expect(output).toBe("");
  });
});

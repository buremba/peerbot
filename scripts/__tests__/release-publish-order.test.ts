import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "bun:test";
import {
  compareVersions,
  manifestBump,
  releaseTagForVersion,
  selectLatestRequiredJobs,
  selectUniqueLatestRun,
  verifyImmutableRelease,
} from "../release-provenance.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const read = (name: string) =>
  readFileSync(`${root}/.github/workflows/${name}`, "utf8");
const job = (yaml: string, id: string) => {
  const lines = yaml.split("\n");
  const start = lines.indexOf(`  ${id}:`);
  if (start < 0) throw new Error(`missing job ${id}`);
  const end = lines.findIndex(
    (line, index) => index > start && /^ {2}[A-Za-z_][\w-]*:/.test(line)
  );
  return lines.slice(start, end < 0 ? lines.length : end).join("\n");
};
const uncommented = (text: string) =>
  text
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
const runBodies = (text: string) =>
  text
    .split("\n")
    .reduce<{ active: boolean; lines: string[] }>(
      (state, line) => {
        if (/^ {8}run: \|/.test(line))
          return { active: true, lines: state.lines };
        if (state.active && !/^ {10}/.test(line))
          return { active: false, lines: state.lines };
        if (state.active) state.lines.push(line);
        return state;
      },
      { active: false, lines: [] }
    )
    .lines.join("\n");

const requiredJobs = [
  "generate-tag",
  "connector-parity-smoke",
  "build-worker",
  "build-embeddings-service",
  "build-app",
  "app-image-smoke",
];

describe("release provenance workflow structure", () => {
  it("uses completed Build Images workflow runs and requires manual image_run_id", () => {
    const release = uncommented(read("release-please.yml"));
    expect(release).toContain("workflow_run:");
    expect(release).toContain('workflows: ["Build and Push Images"]');
    expect(release).toContain("types: [completed]");
    expect(release).toContain("workflow_dispatch:");
    expect(release).toMatch(/image_run_id:[\s\S]*required: true/);
    expect(release).not.toContain("on:\n  push:");
    expect(release).not.toContain("gh workflow run publish-packages.yml");
  });

  it("attests exact main push metadata, paginates all jobs, and selects attempts", () => {
    const release = uncommented(read("release-please.yml"));
    expect(release).toContain("filter=all");
    expect(release).toContain("--paginate --slurp");
    expect(release).toContain("map(.run_attempt // 1) | max");
    expect(release).toContain("head_repository.full_name");
    expect(release).toContain("jq -r '.event' <<<\"$build_run\")");
    expect(release).toContain('[ "$event" = push ] && [ "$branch" = main ]');
    expect(release).toContain(
      '[ "$status" = completed ] && [ "$conclusion" = success ]'
    );
    for (const name of requiredJobs) expect(release).toContain(name);
    expect(release).toContain("sleep 20");
    expect(release).toContain("main moved while waiting for exact CI");
  });

  it("keeps release creation privileged without a global evicting queue", () => {
    const release = read("release-please.yml");
    const write = job(release, "release-please-write");
    expect(write).not.toContain("concurrency:");
    expect(write).toContain("contents: write");
    expect(write).toContain("pull-requests: write");
    expect(write).toContain(
      "Recheck current main immediately before release action"
    );
    expect(write).toContain("target-branch: main");
    expect(write).toContain("release_created");
    expect(write).toContain("RELEASE_SHA");
    expect(write).toContain("skip-github-release: true");
    expect(write).toContain("Publish only a real immutable manifest bump");
  });

  it("separates manual image builds and guards before any checkout", () => {
    const images = uncommented(read("build-images.yml"));
    expect(images).toContain(
      "github.event_name == 'workflow_dispatch' && '-manual'"
    );
    const guard = job(images, "current-main-guard");
    expect(guard).toContain("git/ref/heads/main");
    expect(guard).toContain("refs/heads/main");
    expect(guard).toContain("github.sha");
    expect(images.indexOf("current-main-guard:")).toBeLessThan(
      images.indexOf("uses: actions/checkout")
    );
    expect(images).toContain("BUILD_PLATFORMS");
    expect(images).toContain("linux/arm64");
    expect(images).toContain("latest");
  });

  it("dispatches package publication from main policy with exact inputs", () => {
    const trigger = job(
      uncommented(read("build-images.yml")),
      "trigger-package-publish"
    );
    expect(trigger).toContain("--ref main");
    expect(trigger).not.toContain('--ref "$RELEASE_TAG"');
    expect(trigger).toContain('-f release_tag="$RELEASE_TAG"');
    expect(trigger).toContain("-f bump=skip");
    expect(trigger).toContain('-f image_run_id="$GITHUB_RUN_ID"');
  });

  it("requires release and producer identifiers and removes fallback and bumps", () => {
    const publish = uncommented(read("publish-packages.yml"));
    expect(publish).toMatch(/release_tag:[\s\S]*required: true/);
    expect(publish).toMatch(/image_run_id:[\s\S]*required: true/);
    expect(publish).toContain('BUMP" = skip');
    expect(publish).not.toContain("workflow_runs[0]");
    expect(publish).not.toContain('node scripts/publish-packages.mjs "$BUMP"');
    expect(publish).toContain("--skip-bump");
    expect(publish).toContain("ci_workflow_id");
  });

  it("fail-closes release attestation and allows only green individual producer jobs", () => {
    const attest = job(
      uncommented(read("publish-packages.yml")),
      "attest-publish"
    );
    expect(attest).toContain("draft");
    expect(attest).toContain("git/ref/tags");
    expect(attest).toContain("git/tags");
    expect(attest).toContain("compare/");
    expect(attest).toContain("jq -r '.event' <<<\"$build_run\")");
    expect(attest).toContain("jq -r '.event' <<<\"$build_run\")");
    expect(attest).toContain('status == "completed"');
    expect(attest).toContain('conclusion == "success"');
    expect(attest).toContain("duplicate latest-attempt required job");
    expect(attest).toContain(
      'all(.[]; .status == "completed" and .conclusion == "success")'
    );
    expect(read("publish-packages.yml")).toContain("actions: read");
    expect(attest).toContain("exact successful CI push/main run");
  });

  it("keeps credentials out of the read-only gate and checks out the attested SHA", () => {
    const publish = read("publish-packages.yml");
    const attest = job(publish, "attest-publish");
    const privileged = job(publish, "publish-packages");
    expect(attest).not.toContain("id-token: write");
    expect(attest).not.toContain("NPM_TOKEN");
    expect(privileged).toContain("id-token: write");
    expect(privileged).toContain(
      "ref: ${{ needs.attest-publish.outputs.tag_sha }}"
    );
    expect(privileged).toContain("scripts/publish-packages.mjs --skip-bump");
    expect(privileged).toContain("NODE_AUTH_TOKEN");
    expect(runBodies(publish)).not.toContain("${{ inputs.");
    expect(publish).toContain("published-artifact-smoke.yml");
  });

  it("does not accept comment-only evidence", () => {
    const source = read("publish-packages.yml");
    expect(uncommented(source)).not.toContain("newest exact-SHA");
    expect(uncommented(source)).toContain(
      "publish policy must run from current main"
    );
  });
});

describe("release provenance helpers execute the attestation policy", () => {
  const required = ["generate-tag", "build-worker"];
  const greenPages = [
    {
      jobs: [
        {
          name: "generate-tag",
          run_attempt: 1,
          status: "completed",
          conclusion: "success",
        },
        {
          name: "build-worker",
          run_attempt: 1,
          status: "completed",
          conclusion: "success",
        },
      ],
    },
    {
      jobs: [
        {
          name: "build-worker",
          run_attempt: 2,
          status: "completed",
          conclusion: "success",
        },
      ],
    },
  ];

  it("flattens multi-page jobs and selects exactly the latest attempt", () => {
    expect(
      selectLatestRequiredJobs(greenPages, required).map(
        (job) => job.run_attempt
      )
    ).toEqual([1, 2]);
    expect(() =>
      selectLatestRequiredJobs(
        [
          {
            jobs: [
              { name: "generate-tag", run_attempt: 2 },
              { name: "generate-tag", run_attempt: 2 },
            ],
          },
        ],
        ["generate-tag"]
      )
    ).toThrow("duplicate latest-attempt");
    expect(() =>
      selectLatestRequiredJobs(
        [
          {
            jobs: [
              {
                name: "generate-tag",
                status: "completed",
                conclusion: "skipped",
              },
            ],
          },
        ],
        ["generate-tag"]
      )
    ).toThrow("completed-success");
  });

  it("rejects ambiguous, skipped, failed, and missing selected CI runs", () => {
    const expected = {
      workflow_id: 7,
      event: "push",
      head_branch: "main",
      head_sha: "a",
      status: "completed",
      conclusion: "success",
    };
    expect(
      selectUniqueLatestRun([{ ...expected, id: 1, run_attempt: 1 }], expected)
        .id
    ).toBe(1);
    expect(() =>
      selectUniqueLatestRun(
        [
          { ...expected, id: 1, run_attempt: 2 },
          { ...expected, id: 2, run_attempt: 2 },
        ],
        expected
      )
    ).toThrow("ambiguous");
    expect(() => selectUniqueLatestRun([], expected)).toThrow("no matching");
  });

  it("binds stable release versions and immutable partial recovery", () => {
    expect(manifestBump({ current: "17.3.0", parent: "17.2.0" })).toEqual({
      bumped: true,
      version: "17.3.0",
    });
    expect(manifestBump({ current: "17.2.0", parent: "17.2.0" })).toEqual({
      bumped: false,
      version: "17.2.0",
    });
    expect(compareVersions("17.10.0", "17.9.0")).toBe(1);
    expect(releaseTagForVersion("17.3.0")).toBe("lobu-v17.3.0");
    expect(() => manifestBump({ current: "17.1.0", parent: "17.2.0" })).toThrow(
      "not newer"
    );
    const attested = { name: "lobu-v17.3.0", sha: "a".repeat(40) };
    expect(
      verifyImmutableRelease({
        tag: attested,
        release: {
          tag_name: attested.name,
          target_commitish: attested.sha,
          prerelease: false,
        },
        expectedTag: attested.name,
        expectedSha: attested.sha,
      })
    ).toBe(true);
    expect(() =>
      verifyImmutableRelease({
        tag: attested,
        release: {
          tag_name: attested.name,
          target_commitish: "b".repeat(40),
          prerelease: false,
        },
        expectedTag: attested.name,
        expectedSha: attested.sha,
      })
    ).toThrow("attested commit");
  });
});

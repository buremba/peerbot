import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "bun:test";
import {
  assertNoNewerStable,
  COMMAND_NAMES,
  compareVersions,
  manifestBump,
  peelTag,
  releaseTagForVersion,
  selectLatestRequiredJobs,
  selectUniqueLatestRun,
  verifyImmutableRelease,
} from "../release-provenance.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const workflowDir = `${root}/.github/workflows`;
const read = (name: string) => readFileSync(`${workflowDir}/${name}`, "utf8");
const workflowNames = readdirSync(workflowDir).filter((name) =>
  /\.ya?ml$/.test(name)
);
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

// Run the helper the way the workflows do, so a subcommand that only works
// when imported cannot pass. `attest-jobs` on a red producer must exit
// non-zero: that exit status is the entire gate.
const helper = (command: string, input: unknown) => {
  const result = Bun.spawnSync({
    cmd: ["node", "scripts/release-provenance.mjs", command],
    cwd: root,
    stdin: Buffer.from(JSON.stringify(input)),
  });
  return {
    code: result.exitCode,
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString(),
  };
};

describe("every workflow is parseable and every step is executable", () => {
  // A `run:` mis-indented one level lands inside the step's `env:` map. The
  // step then has neither `run` nor `uses`, GitHub rejects the whole file at
  // parse time, and no amount of string matching against the YAML notices.
  const stepKeys = new Set([
    "run",
    "uses",
    "with",
    "if",
    "name",
    "env",
    "id",
    "shell",
    "working-directory",
    "continue-on-error",
    "timeout-minutes",
  ]);

  it.each(workflowNames)("%s", (name) => {
    const doc = Bun.YAML.parse(read(name)) as {
      jobs?: Record<string, { steps?: Record<string, unknown>[] }>;
    };
    for (const [jobId, definition] of Object.entries(doc?.jobs ?? {})) {
      for (const [index, step] of (definition?.steps ?? []).entries()) {
        if (!step || typeof step !== "object") continue;
        const where = `${name} ${jobId} step[${index}] ${step.name ?? ""}`;
        expect(
          step.run !== undefined || step.uses !== undefined,
          `${where} has neither run nor uses`
        ).toBe(true);
        for (const key of Object.keys(
          (step.env as Record<string, unknown>) ?? {}
        )) {
          expect(
            stepKeys.has(key),
            `${where} smuggles step key "${key}" into env`
          ).toBe(false);
        }
      }
    }
  });

  it("only invokes release-provenance subcommands that exist", () => {
    const invoked = workflowNames.flatMap((name) =>
      Array.from(
        read(name).matchAll(/release-provenance\.mjs ([a-z-]+)/g),
        (match) => match[1]
      )
    );
    expect(invoked.length).toBeGreaterThan(0);
    for (const command of invoked) expect(COMMAND_NAMES).toContain(command);
  });

  it("keeps the attestation policy out of inline jq", () => {
    // The rules below used to be copy-pasted jq in two workflows apiece. jq
    // embedded in YAML is unreachable from this suite, so it must not return.
    for (const name of ["release-please.yml", "publish-packages.yml"]) {
      const source = read(name);
      expect(source).not.toContain("duplicate latest-attempt required job");
      expect(source).not.toContain("map(.run_attempt // 1) | max");
      expect(source).not.toContain("--input-type=module");
    }
  });
});

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
    // `types: [completed]` also fires for failure and cancellation.
    expect(release).toContain(
      "github.event.workflow_run.conclusion == 'success'"
    );
  });

  it("attests exact main push metadata and paginates all jobs", () => {
    const release = uncommented(read("release-please.yml"));
    expect(release).toContain("filter=all");
    expect(release).toContain("--paginate --slurp");
    expect(release).toContain("head_repository.full_name");
    expect(release).toContain("jq -r '.event' <<<\"$build_run\")");
    expect(release).toContain('[ "$event" = push ] && [ "$branch" = main ]');
    expect(release).toContain(
      '[ "$status" = completed ] && [ "$conclusion" = success ]'
    );
    expect(release).toContain("release-provenance.mjs attest-jobs");
    expect(release).toContain("release-provenance.mjs select-run");
    for (const name of requiredJobs) expect(release).toContain(name);
    expect(release).toContain("sleep 20");
    expect(release).toContain("main moved while waiting for exact CI");
  });

  it("proves the producer before checking out any repository code", () => {
    const attest = job(read("release-please.yml"), "attest");
    expect(
      attest.indexOf("Attest the producing Build Images run")
    ).toBeLessThan(attest.indexOf("uses: actions/checkout"));
    // Pinned, so the helper cannot come from a ref that moved mid-run.
    expect(attest).toContain("ref: ${{ steps.producer.outputs.sha }}");
    expect(attest).not.toContain("id-token: write");
    expect(attest).not.toContain("NPM_TOKEN");
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
    expect(write).toContain("release-provenance.mjs manifest-bump");
    expect(write).toContain("release-provenance.mjs verify-release");
    // make_latest is a string enum in the REST API; a boolean is dropped.
    expect(write).toContain('make_latest: "true"');
  });

  it("does not turn a gh 404 body or a SIGPIPE into a failed release", () => {
    const write = job(read("release-please.yml"), "release-please-write");
    // `gh api` prints the 404 body on STDOUT, so `|| true` leaves a
    // {"message":"Not Found"} document in the variable and the
    // already-exists branch runs on every first release.
    expect(write).not.toContain('releases/tags/${tag}" 2>/dev/null || true');
    expect(write).toContain(
      'if release=$(gh api "repos/${REPOSITORY}/releases/tags/${tag}"'
    );
    // CHANGELOG.md is ~475KB: `git show ... | head -c` exits 141 under
    // pipefail and kills the release step before it creates anything.
    expect(write).not.toContain("head -c");
    expect(write).toContain("notes=${notes:0:12000}");
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
    expect(images).toContain("release-provenance.mjs verify-release");
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

  it("fail-closes release attestation and allows only green producer jobs", () => {
    const attest = job(
      uncommented(read("publish-packages.yml")),
      "attest-publish"
    );
    expect(attest).toContain("git/ref/tags");
    expect(attest).toContain("git/tags");
    expect(attest).toContain("compare/");
    expect(attest).toContain("jq -r '.event' <<<\"$build_run\")");
    expect(attest).toContain("release-provenance.mjs verify-release");
    expect(attest).toContain("release-provenance.mjs attest-jobs");
    expect(attest).toContain("release-provenance.mjs select-run");
    expect(read("publish-packages.yml")).toContain("actions: read");
    // The policy guard runs before the checkout that makes the helper
    // available, so an off-main dispatch never executes repository code.
    expect(
      attest.indexOf("publish policy must run from current main")
    ).toBeLessThan(attest.indexOf("uses: actions/checkout"));
  });

  it("does not fail the publish because main moved after dispatch", () => {
    // The ref pin is the security property; requiring the dispatched SHA to
    // still be main's HEAD adds none and strands a release off npm whenever
    // anything merges between dispatch and this job starting -- the failure
    // this workflow exists to prevent. The release is bound by its tag.
    const attest = job(read("publish-packages.yml"), "attest-publish");
    const guard = attest.slice(
      attest.indexOf("Verify current-main workflow policy"),
      attest.indexOf("Check out current main")
    );
    expect(guard).toContain('"$WORKFLOW_REF" = refs/heads/main');
    expect(guard).not.toContain("git/ref/heads/main");
    expect(guard).not.toContain("DISPATCH_SHA");
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
    expect(privileged).toContain("release-provenance.mjs assert-newer");
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

describe("the helper CLI the workflows actually invoke", () => {
  const green = {
    pages: [
      {
        jobs: [
          {
            name: "generate-tag",
            run_attempt: 1,
            status: "completed",
            conclusion: "success",
          },
          {
            name: "app-image-smoke",
            run_attempt: 1,
            status: "completed",
            conclusion: "failure",
          },
          {
            name: "app-image-smoke",
            run_attempt: 2,
            status: "completed",
            conclusion: "success",
          },
        ],
      },
    ],
    required: ["generate-tag", "app-image-smoke"],
  };

  it("exits zero on a green producer and takes the newest attempt", () => {
    const ok = helper("attest-jobs", green);
    expect(ok.code).toBe(0);
    expect(JSON.parse(ok.stdout)).toEqual({ ok: true, required: 2 });
  });

  it.each([
    ["failure", "not completed-success"],
    ["skipped", "not completed-success"],
    ["cancelled", "not completed-success"],
  ])("exits non-zero when a required job is %s", (conclusion, message) => {
    const red = helper("attest-jobs", {
      pages: [
        {
          jobs: [
            {
              name: "generate-tag",
              status: "completed",
              conclusion: "success",
            },
            { name: "app-image-smoke", status: "completed", conclusion },
          ],
        },
      ],
      required: green.required,
    });
    expect(red.code).not.toBe(0);
    expect(red.stderr).toContain(message);
  });

  it("exits non-zero on an unknown subcommand rather than passing silently", () => {
    const unknown = helper("attest-everything", {});
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain("unknown command");
  });

  it("round-trips each subcommand's shape over stdin", () => {
    expect(
      JSON.parse(helper("release-tag", { version: "17.4.0" }).stdout)
    ).toEqual({ tag: "lobu-v17.4.0" });
    expect(
      JSON.parse(
        helper("manifest-bump", { current: "17.4.0", parent: "17.3.0" }).stdout
      )
    ).toEqual({ bumped: true, version: "17.4.0" });
    expect(
      JSON.parse(
        helper("select-run", {
          runs: [
            { id: 1, head_sha: "a", run_attempt: 1 },
            { id: 9, head_sha: "a", run_attempt: 3 },
          ],
          expected: { head_sha: "a" },
        }).stdout
      )
    ).toEqual({ id: "9" });
    expect(
      helper("assert-newer", { current: "17.3.0", versions: ["17.4.0"] }).code
    ).not.toBe(0);
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
    expect(() => selectLatestRequiredJobs(greenPages, [])).toThrow(
      "no required job names"
    );
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

  it("only lets versions move forward", () => {
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
    expect(() =>
      assertNoNewerStable({ current: "17.3.0", versions: ["17.4.0"] })
    ).toThrow("newer stable version");
    expect(
      assertNoNewerStable({ current: "17.3.0", versions: ["17.3.0", "16.1.0"] })
    ).toMatchObject({ ok: true, compared: 2 });
    // A prerelease string is not a stable version and must not veto a release.
    expect(
      assertNoNewerStable({
        current: "17.3.0",
        versions: ["17.9.0-beta.1", "17.2.0"],
      })
    ).toMatchObject({ ok: true, compared: 1 });
  });

  it("peels an annotated tag instead of trusting the ref's own sha", () => {
    const commit = "a".repeat(40);
    const tagObjectSha = "c".repeat(40);
    expect(
      peelTag({ tagRef: { object: { type: "commit", sha: commit } } })
    ).toBe(commit);
    expect(
      peelTag({
        tagRef: { object: { type: "tag", sha: tagObjectSha } },
        tagObject: { object: { sha: commit } },
      })
    ).toBe(commit);
    // Without the peeled object an annotated tag has no commit to bind to.
    expect(() =>
      peelTag({ tagRef: { object: { type: "tag", sha: tagObjectSha } } })
    ).toThrow("could not peel");
  });

  it("binds stable release versions and immutable partial recovery", () => {
    const sha = "a".repeat(40);
    const stable = {
      release: {
        tag_name: "lobu-v17.3.0",
        draft: false,
        prerelease: false,
        target_commitish: sha,
      },
      tagRef: { object: { type: "commit", sha } },
      expectedTag: "lobu-v17.3.0",
      expectedSha: sha,
    };
    expect(verifyImmutableRelease(stable)).toEqual({
      sha,
      version: "17.3.0",
    });
    expect(() =>
      verifyImmutableRelease({ ...stable, expectedSha: "b".repeat(40) })
    ).toThrow("attested commit");
    expect(() =>
      verifyImmutableRelease({
        ...stable,
        release: { ...stable.release, draft: true },
      })
    ).toThrow("draft");
    expect(() =>
      verifyImmutableRelease({
        ...stable,
        release: { ...stable.release, prerelease: true },
      })
    ).toThrow("prerelease");
    expect(() =>
      verifyImmutableRelease({ ...stable, expectedTag: "lobu-v17.4.0" })
    ).toThrow("tag/name mismatch");
    // An annotated tag re-pointed away from the release's own target.
    expect(() =>
      verifyImmutableRelease({
        ...stable,
        tagRef: { object: { type: "tag", sha: "c".repeat(40) } },
        tagObject: { object: { sha: "d".repeat(40) } },
      })
    ).toThrow("attested commit");
    // GitHub records a branch name when a release is cut from a branch, and
    // ignores target_commitish entirely once the tag exists. Only a SHA in
    // that field carries a binding, so only a SHA is enforced.
    expect(
      verifyImmutableRelease({
        ...stable,
        release: { ...stable.release, target_commitish: "main" },
      })
    ).toMatchObject({ sha });
    expect(() =>
      verifyImmutableRelease({
        ...stable,
        release: { ...stable.release, target_commitish: "b".repeat(40) },
      })
    ).toThrow("does not match peeled tag");
  });
});

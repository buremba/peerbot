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

type Step = {
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
};
type Job = {
  needs?: string | string[];
  if?: string;
  permissions?: Record<string, string>;
  steps?: Step[];
};
type Workflow = { on?: Record<string, unknown>; jobs?: Record<string, Job> };

const root = fileURLToPath(new URL("../..", import.meta.url));
const dir = `${root}/.github/workflows`;
const names = readdirSync(dir).filter((name) => /\.ya?ml$/.test(name));
const read = (name: string) => readFileSync(`${dir}/${name}`, "utf8");
const parse = (name: string) => Bun.YAML.parse(read(name)) as Workflow;
const job = (file: string, id: string) => {
  const found = parse(file).jobs?.[id];
  if (!found) throw new Error(`${file} has no job ${id}`);
  return found;
};
const steps = (file: string, id: string) => job(file, id).steps ?? [];
const stepAt = (file: string, id: string, needle: string) => {
  const index = steps(file, id).findIndex((step) =>
    `${step.name ?? ""} ${step.uses ?? ""}`.includes(needle)
  );
  if (index < 0)
    throw new Error(`${file}/${id} has no step matching ${needle}`);
  return index;
};
/** Every shell body in a job, concatenated — what the runner will execute. */
const shell = (file: string, id: string) =>
  steps(file, id)
    .map((step) => step.run ?? "")
    .join("\n");
const envOf = (file: string, id: string) =>
  steps(file, id).flatMap((step) => Object.keys(step.env ?? {}));

const REQUIRED_IMAGE_JOBS = [
  "generate-tag",
  "connector-parity-smoke",
  "build-worker",
  "build-embeddings-service",
  "build-app",
  "app-image-smoke",
];

/** Run the helper the way the workflows do — over stdin, as a subprocess. */
const cli = (command: string, input: unknown) => {
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

describe("every workflow file is well formed", () => {
  // A `run:` indented one level too far lands inside the step's own `env:`
  // map. The step then has neither `run` nor `uses`, GitHub rejects the whole
  // file when it parses it, and no amount of string matching notices — which
  // is exactly how an unrunnable publish workflow passed 21 green checks.
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

  it.each(names)("%s parses and every step is executable", (file) => {
    for (const [id, definition] of Object.entries(parse(file).jobs ?? {})) {
      for (const [index, step] of (definition.steps ?? []).entries()) {
        const where = `${file} ${id} step[${index}] ${step.name ?? ""}`;
        expect(
          step.run !== undefined || step.uses !== undefined,
          `${where} has neither run nor uses`
        ).toBe(true);
        for (const key of Object.keys(step.env ?? {})) {
          expect(stepKeys.has(key), `${where} put "${key}" in env`).toBe(false);
        }
      }
    }
  });

  it("only invokes helper subcommands that exist", () => {
    const invoked = names.flatMap((file) =>
      Array.from(
        read(file).matchAll(/release-provenance\.mjs ([a-z-]+)/g),
        (match) => match[1]
      )
    );
    expect(invoked.length).toBeGreaterThan(0);
    for (const command of invoked) expect(COMMAND_NAMES).toContain(command);
  });

  it("keeps the attestation policy out of inline jq and inline node", () => {
    // These rules were copy-pasted jq in two workflows apiece. jq embedded in
    // YAML is unreachable from this suite, so it must not come back.
    for (const file of ["release-please.yml", "publish-packages.yml"]) {
      expect(read(file)).not.toContain("duplicate latest-attempt required job");
      expect(read(file)).not.toContain("map(.run_attempt // 1) | max");
      expect(read(file)).not.toContain("--input-type=module");
    }
  });
});

describe("release-please only acts on a green main push", () => {
  it("screens the producer's conclusion and its event", () => {
    const trigger = parse("release-please.yml").on?.workflow_run as Record<
      string,
      unknown
    >;
    expect(trigger.workflows).toEqual(["Build and Push Images"]);
    expect(trigger.branches).toEqual(["main"]);
    // `branches: [main]` admits a manual Build Images dispatch just as
    // readily as a push, and `types: [completed]` includes failures. Both
    // would start the job only to hard-fail the API checks below.
    const guard = job("release-please.yml", "attest").if ?? "";
    expect(guard).toContain("conclusion == 'success'");
    expect(guard).toContain("event == 'push'");
  });

  it("proves the producer before checking out repository code", () => {
    expect(
      stepAt("release-please.yml", "attest", "Build Images run")
    ).toBeLessThan(stepAt("release-please.yml", "attest", "actions/checkout"));
    const checkout = steps("release-please.yml", "attest").find((step) =>
      step.uses?.includes("actions/checkout")
    );
    // Pinned, so the helper cannot come from a ref that moved mid-run.
    expect(checkout?.with?.ref).toBe("${{ steps.producer.outputs.sha }}");
    expect(envOf("release-please.yml", "attest")).not.toContain("NPM_TOKEN");
    expect(job("release-please.yml", "attest").permissions).toBeUndefined();
  });

  it("delegates job and run selection to the tested helper", () => {
    const body = shell("release-please.yml", "attest");
    expect(body).toContain("release-provenance.mjs attest-jobs");
    expect(body).toContain("release-provenance.mjs select-run");
    expect(body).toContain("--paginate --slurp");
    expect(body).toContain("filter=all");
    for (const name of REQUIRED_IMAGE_JOBS) {
      expect(read("release-please.yml")).toContain(name);
    }
    // The bounded wait must re-check that main has not moved under it.
    expect(body).toContain("main moved while waiting for exact CI");
  });
});

describe("the release is created bound to the attested commit", () => {
  const id = "release-please-write";
  const body = () => shell("release-please.yml", id);

  it("holds the write permissions without a global evicting queue", () => {
    expect(job("release-please.yml", id).permissions).toEqual({
      contents: "write",
      "pull-requests": "write",
    });
    expect(read("release-please.yml")).not.toContain("concurrency:");
    expect(body()).toContain("main advanced after attestation");
  });

  it("lets release-please open the PR and creates the release itself", () => {
    const action = steps("release-please.yml", id).find((step) =>
      step.uses?.includes("release-please-action")
    );
    expect(action?.with?.["skip-github-release"]).toBe(true);
    expect(action?.with?.["target-branch"]).toBe("main");
    // skip-github-release keeps release_created permanently false, and the
    // release step re-verifies the binding by peeling the tag, so a
    // release_created guard would be dead and redundant at once.
    expect(read("release-please.yml")).not.toContain("release_created");
    expect(body()).toContain("release-provenance.mjs manifest-bump");
    expect(body()).toContain("release-provenance.mjs verify-release");
    expect(body()).toContain("release-provenance.mjs assert-newer");
    // make_latest is a string enum in the REST API; a boolean is dropped.
    expect(body()).toContain('make_latest: "true"');
  });

  it("does not let a 404 body or a large changelog fail the release", () => {
    // `gh api` prints the 404 body on STDOUT, so `|| true` left
    // {"message":"Not Found"} in the variable and the already-exists branch
    // ran on the first release of every version. Branch on exit status.
    expect(body()).not.toContain('releases/tags/${tag}" 2>/dev/null || true');
    expect(body()).toContain("if release=$(gh api");
    // CHANGELOG.md is ~475KB: `git show … | head -c` exits 141 under pipefail
    // and kills the step before it creates anything.
    expect(body()).not.toContain("head -c");
    expect(body()).toContain("notes=${notes:0:12000}");
    expect(body()).toContain('CHANGELOG.md" || echo ""');
  });
});

describe("image builds refuse an off-main manual dispatch", () => {
  it("guards before any checkout and gates every build behind it", () => {
    const guard = job("build-images.yml", "current-main-guard");
    expect(guard.steps?.some((step) => step.uses?.includes("checkout"))).toBe(
      false
    );
    expect(job("build-images.yml", "generate-tag").needs).toContain(
      "current-main-guard"
    );
    expect(shell("build-images.yml", "current-main-guard")).toContain(
      "git/ref/heads/main"
    );
    expect(read("build-images.yml")).toContain(
      "github.event_name == 'workflow_dispatch' && '-manual'"
    );
  });

  it("verifies a release binds to this commit through the helper", () => {
    expect(shell("build-images.yml", "generate-tag")).toContain(
      "release-provenance.mjs verify-release"
    );
  });

  it("dispatches publication from main policy with exact inputs", () => {
    const dispatch = shell("build-images.yml", "trigger-package-publish");
    expect(dispatch).toContain("--ref main");
    expect(dispatch).not.toContain('--ref "$RELEASE_TAG"');
    expect(dispatch).toContain('-f release_tag="$RELEASE_TAG"');
    expect(dispatch).toContain('-f image_run_id="$GITHUB_RUN_ID"');
    // `skip` was the only accepted value, so the input was dead surface.
    expect(dispatch).not.toContain("bump");
  });
});

describe("publishing requires an attested release", () => {
  it("requires both producer identifiers and forbids a hosted bump", () => {
    const inputs = (
      parse("publish-packages.yml").on?.workflow_dispatch as {
        inputs: Record<string, { required?: boolean }>;
      }
    ).inputs;
    expect(inputs.release_tag.required).toBe(true);
    expect(inputs.image_run_id.required).toBe(true);
    expect(Object.keys(inputs)).not.toContain("bump");
  });

  it("keeps publish credentials out of the read-only gate", () => {
    expect(
      job("publish-packages.yml", "attest-publish").permissions
    ).toBeUndefined();
    expect(envOf("publish-packages.yml", "attest-publish")).not.toContain(
      "NPM_TOKEN"
    );
    expect(
      job("publish-packages.yml", "publish-packages").permissions
    ).toMatchObject({ "id-token": "write" });
    const checkout = steps("publish-packages.yml", "publish-packages")[0];
    expect(checkout.with?.ref).toBe(
      "${{ needs.attest-publish.outputs.tag_sha }}"
    );
    // A dispatch input reaching a shell through `${{ }}` in a job that holds
    // the production NPM token is credential injection, not a broken script.
    for (const definition of Object.values(
      parse("publish-packages.yml").jobs ?? {}
    )) {
      for (const step of definition.steps ?? []) {
        expect(step.run ?? "").not.toContain("${{ inputs.");
      }
    }
  });

  it("does not fail the publish because main moved after dispatch", () => {
    // The ref pin is the security property: a dispatch resolves
    // refs/heads/main to a tip nobody can forge. Also requiring that tip to
    // still be HEAD adds none, and strands a release off npm whenever
    // anything merges between dispatch and this job starting — the failure
    // this workflow exists to prevent. The release is bound by its tag.
    const guard = steps("publish-packages.yml", "attest-publish")[0];
    expect(guard.run).toContain('"$WORKFLOW_REF" = refs/heads/main');
    expect(guard.run).not.toContain("git/ref/heads/main");
    expect(guard.env).not.toHaveProperty("GH_TOKEN");
    expect(
      stepAt("publish-packages.yml", "attest-publish", "policy")
    ).toBeLessThan(
      stepAt("publish-packages.yml", "attest-publish", "actions/checkout")
    );
  });

  it("accepts the producer run that is still dispatching it", () => {
    // trigger-package-publish lives *inside* the Build Images run and passes
    // its own $GITHUB_RUN_ID, so that run is necessarily in_progress while
    // this gate reads it. A run-level "completed" assertion can therefore
    // never be satisfied, and strands the release off npm.
    const dispatch = shell("build-images.yml", "trigger-package-publish");
    expect(dispatch).toContain('-f image_run_id="$GITHUB_RUN_ID"');
    const gate = shell("publish-packages.yml", "attest-publish");
    expect(gate).not.toContain("Build Images release run is not completed");
    expect(gate).not.toMatch(/'\.status'\s*<<<"\$build_run"/);
    expect(gate).not.toMatch(/'\.conclusion'\s*<<<"\$build_run"/);
    // Identity still has to hold, and per-job attestation is the evidence.
    expect(gate).toContain("head_sha");
    expect(gate).toContain("release-provenance.mjs attest-jobs");
    // The dispatching job must not be one of the jobs it has to wait for.
    const required = read("publish-packages.yml").match(
      /REQUIRED_IMAGE_JOBS: (.+)/
    )?.[1];
    expect(required?.split(" ")).not.toContain("trigger-package-publish");
    expect(required?.split(" ").sort()).toEqual(
      [...REQUIRED_IMAGE_JOBS].sort()
    );
  });

  it("treats an unreadable registry as unknown, not as empty", () => {
    // `npm view --json` prints its error object to STDOUT, so `|| echo '[]'`
    // emitted two JSON values and the version gate could not run at all.
    const body = shell("publish-packages.yml", "publish-packages");
    expect(body).not.toContain("--json 2>/dev/null || echo");
    expect(body).toContain("could not read published @lobu/cli versions");
    expect(body).toContain("release-provenance.mjs assert-newer");
  });
});

describe("the helper CLI the workflows invoke", () => {
  const required = ["generate-tag", "app-image-smoke"];
  const page = (conclusion: string, attempt = 1) => ({
    pages: [
      {
        jobs: [
          {
            name: "generate-tag",
            status: "completed",
            conclusion: "success",
            run_attempt: 1,
          },
          {
            name: "app-image-smoke",
            status: "completed",
            conclusion,
            run_attempt: attempt,
          },
        ],
      },
    ],
    required,
  });

  it("exits zero on a green producer, preferring the newest attempt", () => {
    const green = page("success", 2);
    green.pages[0].jobs.push({
      name: "app-image-smoke",
      status: "completed",
      conclusion: "failure",
      run_attempt: 1,
    });
    const ok = cli("attest-jobs", green);
    expect(ok.code).toBe(0);
    expect(JSON.parse(ok.stdout)).toEqual({ ok: true, required: 2 });
  });

  it.each([
    "failure",
    "skipped",
    "cancelled",
  ])("exits non-zero when a required job is %s", (conclusion) => {
    const red = cli("attest-jobs", page(conclusion));
    expect(red.code).not.toBe(0);
    expect(red.stderr).toContain("not completed-success");
  });

  it("exits non-zero on an unknown subcommand rather than passing", () => {
    const unknown = cli("attest-everything", {});
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain("unknown command");
  });

  it("round-trips each subcommand's shape over stdin", () => {
    expect(
      JSON.parse(cli("release-tag", { version: "17.4.0" }).stdout)
    ).toEqual({ tag: "lobu-v17.4.0" });
    expect(
      JSON.parse(
        cli("manifest-bump", { current: "17.4.0", parent: "17.3.0" }).stdout
      )
    ).toEqual({ bumped: true, version: "17.4.0" });
    expect(
      JSON.parse(
        cli("select-run", {
          runs: [
            { id: 1, head_sha: "a", run_attempt: 1 },
            { id: 9, head_sha: "a", run_attempt: 3 },
          ],
          expected: { head_sha: "a" },
        }).stdout
      )
    ).toEqual({ id: "9" });
    expect(
      cli("assert-newer", { current: "17.3.0", versions: ["17.4.0"] }).code
    ).not.toBe(0);
  });
});

describe("the attestation policy itself", () => {
  it("flattens paginated jobs and selects exactly the latest attempt", () => {
    const pages = [
      {
        jobs: [
          {
            name: "generate-tag",
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
    expect(
      selectLatestRequiredJobs(pages, ["generate-tag", "build-worker"]).map(
        (found) => found.run_attempt
      )
    ).toEqual([1, 2]);
    // Two rows at the same attempt is ambiguous evidence, not a tie to break.
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
    expect(() => selectLatestRequiredJobs(pages, ["absent"])).toThrow(
      "missing required job"
    );
    expect(() => selectLatestRequiredJobs(pages, [])).toThrow(
      "no required job names"
    );
  });

  it("rejects ambiguous and missing CI runs", () => {
    const expected = { head_sha: "a", conclusion: "success" };
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
    expect(() => manifestBump({ current: "17.1.0", parent: "17.2.0" })).toThrow(
      "not newer"
    );
    expect(compareVersions("17.10.0", "17.9.0")).toBe(1);
    expect(releaseTagForVersion("17.3.0")).toBe("lobu-v17.3.0");
    expect(() =>
      assertNoNewerStable({ current: "17.3.0", versions: ["17.4.0"] })
    ).toThrow("newer stable version");
    // A prerelease string is not a stable version and must not veto a release.
    expect(
      assertNoNewerStable({
        current: "17.3.0",
        versions: ["17.9.0-beta.1", "17.2.0"],
      })
    ).toMatchObject({ ok: true, compared: 1 });
    // An `npm view --json` error object must not read as "nothing published".
    expect(() =>
      assertNoNewerStable({
        current: "17.3.0",
        versions: [{ error: { code: "E404" } }],
      })
    ).toThrow("non-version");
  });

  it("peels an annotated tag instead of trusting the ref's own sha", () => {
    const commit = "a".repeat(40);
    expect(
      peelTag({ tagRef: { object: { type: "commit", sha: commit } } })
    ).toBe(commit);
    expect(
      peelTag({
        tagRef: { object: { type: "tag", sha: "c".repeat(40) } },
        tagObject: { object: { sha: commit } },
      })
    ).toBe(commit);
    expect(() =>
      peelTag({ tagRef: { object: { type: "tag", sha: "c".repeat(40) } } })
    ).toThrow("could not peel");
  });

  it("binds a stable release to the commit its tag peels to", () => {
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
    expect(verifyImmutableRelease(stable)).toEqual({ sha, version: "17.3.0" });
    for (const [patch, message] of [
      [{ expectedSha: "b".repeat(40) }, "attested commit"],
      [{ expectedTag: "lobu-v17.4.0" }, "tag/name mismatch"],
      [{ release: { ...stable.release, draft: true } }, "draft"],
      [{ release: { ...stable.release, prerelease: true } }, "prerelease"],
      [
        {
          tagRef: { object: { type: "tag", sha: "c".repeat(40) } },
          tagObject: { object: { sha: "d".repeat(40) } },
        },
        "attested commit",
      ],
    ] as const) {
      expect(() => verifyImmutableRelease({ ...stable, ...patch })).toThrow(
        message
      );
    }
    // GitHub records a branch name when a release is cut from a branch and
    // ignores target_commitish once the tag exists, so only a SHA there
    // carries a binding — and a SHA that disagrees is a real mismatch.
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

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "bun:test";

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
    expect(release).toContain("max_by(.run_attempt // 1)");
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

  it("keeps release creation privileged and non-cancelling, with a final main recheck", () => {
    const release = read("release-please.yml");
    const write = job(release, "release-please-write");
    expect(write).toContain("cancel-in-progress: false");
    expect(write).toContain("contents: write");
    expect(write).toContain("pull-requests: write");
    expect(write).toContain(
      "Recheck current main immediately before release action"
    );
    expect(write).toContain("target-branch: main");
    expect(write).toContain("release_created");
    expect(write).toContain("RELEASE_SHA");
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

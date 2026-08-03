import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "bun:test";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const workflow = (name: string) =>
  readFileSync(`${repoRoot}/.github/workflows/${name}`, "utf8");

/**
 * Slice one top-level job out of a workflow. Scanning to the next job-key line
 * rather than to a named sibling keeps these assertions independent of job
 * order — reordering build-images.yml must not silently empty the haystack.
 */
function jobBlock(yaml: string, jobId: string): string {
  const lines = yaml.split("\n");
  const start = lines.indexOf(`  ${jobId}:`);
  if (start === -1) throw new Error(`job '${jobId}' not found in workflow`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^ {2}[A-Za-z_][\w-]*:/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

describe("release package publication ordering", () => {
  it("slices jobs at every valid job ID", () => {
    const yaml = [
      "jobs:",
      "  target:",
      "    marker: target",
      "  _next-job:",
      "    marker: sibling",
    ].join("\n");

    expect(jobBlock(yaml, "target")).not.toContain("sibling");
  });

  it("does not dispatch package publication at release creation time", () => {
    expect(workflow("release-please.yml")).not.toContain(
      "gh workflow run publish-packages.yml"
    );
  });

  it("dispatches only after app-image-smoke and pins the release tag and run", () => {
    const job = jobBlock(
      workflow("build-images.yml"),
      "trigger-package-publish"
    );

    expect(job).toContain("needs: [generate-tag, app-image-smoke]");
    expect(job).toContain("github.event_name == 'release'");
    expect(job).toContain('--ref "$RELEASE_TAG"');
    expect(job).toContain('-f image_run_id="$GITHUB_RUN_ID"');
  });

  it("keeps the dispatch skipped when app-image-smoke is not green", () => {
    // A job whose `if:` carries no status function inherits `success()` over
    // its `needs`, so a failed or skipped app-image-smoke skips the dispatch.
    // `always()`/`!cancelled()` would opt out of that and publish anyway.
    const job = jobBlock(
      workflow("build-images.yml"),
      "trigger-package-publish"
    );

    expect(job).not.toMatch(/always\(\)|cancelled\(\)|failure\(\)/);
  });

  it("pages when the dispatch itself fails", () => {
    // build-images is the only thing watching this dispatch; if it drops off
    // notify-failure's needs, a failed publish trigger goes unnoticed until
    // someone checks npm.
    const job = jobBlock(workflow("build-images.yml"), "notify-failure");

    expect(job).toMatch(
      /^\s+needs:\s*\[[^\]]*\btrigger-package-publish\b[^\]]*\]/m
    );
  });

  it("validates the exact producer SHA and green smoke before publishing", () => {
    const publish = workflow("publish-packages.yml");

    expect(publish).toMatch(/^permissions:\n(?: {2}.*\n)* {2}actions: read$/m);
    expect(publish).toContain("actions/workflows/build-images.yml");
    expect(publish).toContain("--jq '.id'");
    expect(publish).toContain(
      'if [ "$workflow_id" != "$expected_workflow_id" ]'
    );
    expect(publish).not.toContain(
      'if [ "$workflow_path" != ".github/workflows/build-images.yml" ]'
    );
    expect(publish).toContain("--jq '[.workflow_id, .head_sha] | @tsv'");
    expect(publish).toContain('if [ "$run_sha" != "$sha" ]');
    expect(publish).toContain('select(.name == "app-image-smoke")');
    expect(publish).toContain(
      'if [ "$status" != "completed" ] || [ "$conclusion" != "success" ]'
    );
  });

  it("reads dispatch inputs through env, not template expansion", () => {
    // publish-packages holds `id-token: write` and the production NPM_TOKEN, so
    // a `${{ inputs.* }}` expanded inside a `run:` body is a publish-credential
    // injection reachable by anyone who can dispatch the workflow.
    const publish = workflow("publish-packages.yml");
    const runBodies = publish
      .split("\n")
      .filter((line) => !/^\s{8,}[A-Z_]+:\s/.test(line))
      .join("\n");

    expect(runBodies).not.toContain("${{ inputs.image_run_id }}");
    expect(runBodies).not.toContain("${{ inputs.bump }}");
    expect(publish).toContain('run_id="$IMAGE_RUN_ID"');
  });
});

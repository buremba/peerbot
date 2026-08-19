import { describe, expect, it } from "bun:test";
import {
  buildProofBody,
  COMPARE_FILE_CAP,
  findProofComment,
  isUnhostedRange,
  isHttpsArtifact,
  parseProof,
  permittedFluxTailParent,
  proofMatches,
  selectOwlettoPullRequest,
  type UiReviewComment,
  type UiReviewProof,
} from "../lib/ui-review-proof";
import { githubRepoFromRemote } from "../ui-review";

const BASE_SHA = "1".repeat(40);
const HEAD_SHA = "2".repeat(40);
const OTHER_SHA = "3".repeat(40);

const proof: UiReviewProof = {
  version: 1,
  lobu_repo: "lobu-ai/lobu",
  lobu_pr: 2500,
  lobu_base_owletto_sha: BASE_SHA,
  owletto_sha: HEAD_SHA,
  owletto_pr: 712,
  artifact_url: "https://claude.ai/code/artifact/example",
};

describe("UI review proof", () => {
  it("derives the Owletto repository from supported GitHub remotes", () => {
    expect(githubRepoFromRemote("https://github.com/lobu-ai/owletto.git")).toBe(
      "lobu-ai/owletto"
    );
    expect(githubRepoFromRemote("git@github.com:lobu-ai/owletto.git")).toBe(
      "lobu-ai/owletto"
    );
    expect(() =>
      githubRepoFromRemote("https://example.com/owletto.git")
    ).toThrow("unsupported GitHub remote");
  });

  it("round-trips machine state without hiding the human-readable proof", () => {
    const body = buildProofBody(proof);

    expect(parseProof(body)).toEqual(proof);
    // The machine state rides in an HTML comment. A reader of the PR must still
    // get the range and the comparison link in prose, or the proof is inert.
    expect(body).toContain(HEAD_SHA);
    expect(body).toContain(proof.artifact_url);
    expect(body).toContain(`${proof.lobu_repo}#${proof.lobu_pr}`);
  });

  it("ignores comments that merely contain marker-like text", () => {
    expect(
      parseProof(
        `discussion <!-- lobu-ui-review-proof ${JSON.stringify(proof)} -->`
      )
    ).toBeNull();
  });

  it("picks the proof this Lobu PR owns when several share one Owletto PR", () => {
    const foreign: UiReviewProof = { ...proof, lobu_pr: 2499 };
    const fork: UiReviewProof = { ...proof, lobu_repo: "fork/lobu" };
    const comment = (body: string, id: string): UiReviewComment => ({
      body,
      created_at: "2026-08-04T10:00:00Z",
      html_url: `https://github.com/lobu-ai/owletto/pull/712#${id}`,
      user: { login: "agent" },
    });
    const comments = [
      comment("just discussing the proof", "chatter"),
      comment(buildProofBody(foreign), "foreign"),
      comment(buildProofBody(fork), "fork"),
      comment(buildProofBody(proof), "ours"),
    ];

    expect(
      findProofComment(comments, "lobu-ai/lobu", 2500)?.html_url
    ).toEndWith("#ours");
    expect(
      findProofComment(comments, "lobu-ai/lobu", 2499)?.html_url
    ).toEndWith("#foreign");
    expect(findProofComment(comments, "lobu-ai/lobu", 2501)).toBeUndefined();
  });

  it("selects only the merged PR whose squash commit is the pointer", () => {
    const pulls = [
      {
        number: 710,
        html_url: "https://example/710",
        merge_commit_sha: OTHER_SHA,
        merged_at: "now",
      },
      {
        number: 711,
        html_url: "https://example/711",
        merge_commit_sha: HEAD_SHA,
        merged_at: null,
      },
      {
        number: 712,
        html_url: "https://example/712",
        merge_commit_sha: HEAD_SHA,
        merged_at: "now",
      },
    ];

    expect(selectOwlettoPullRequest(pulls, HEAD_SHA)?.number).toBe(712);
    expect(selectOwlettoPullRequest(pulls, BASE_SHA)).toBeNull();
  });

  it("walks only the exact deploy-only Flux image tail", () => {
    const parent = "4".repeat(40);
    expect(
      permittedFluxTailParent({
        commit: {
          author: { email: "fluxcd@lobu.ai" },
          message: "chore: update images",
        },
        files: [{ filename: "deploy/k8s/apps/lobu/base/helmrelease.yaml" }],
        parents: [{ sha: parent }],
      })
    ).toBe(parent);

    for (const candidate of [
      {
        commit: {
          author: { email: "human@lobu.ai" },
          message: "chore: update images",
        },
        files: [{ filename: "deploy/app.yaml" }],
        parents: [{ sha: parent }],
      },
      {
        commit: {
          author: { email: "fluxcd@lobu.ai" },
          message: "chore: update images later",
        },
        files: [{ filename: "deploy/app.yaml" }],
        parents: [{ sha: parent }],
      },
      {
        commit: {
          author: { email: "fluxcd@lobu.ai" },
          message: "chore: update images",
        },
        files: [{ filename: "src/app.ts" }],
        parents: [{ sha: parent }],
      },
    ]) {
      expect(permittedFluxTailParent(candidate)).toBeNull();
    }
  });

  it("accepts only a complete unhosted endpoint diff", () => {
    expect(
      isUnhostedRange([
        { filename: "deploy/k8s/clusters/lobu-prod/apps.yaml" },
        { filename: "deploy/k8s/apps/lobu/base/helmrelease.yaml" },
      ])
    ).toBe(true);

    // The range spans several merged PRs. A surviving UI change from an earlier
    // commit must still demand proof when the head PR is deploy-only on its own.
    expect(
      isUnhostedRange([
        { filename: "src/components/shell/responsive-app-shell.tsx" },
        { filename: "deploy/k8s/clusters/lobu-prod/apps.yaml" },
      ])
    ).toBe(false);

    // An extension-only or Mac-only range has no hosted URL to compare, so it
    // is exempt from proof the same way a deploy-only range is.
    expect(
      isUnhostedRange([
        { filename: "apps/chrome/watch.js" },
        { filename: "apps/chrome/sidepanel.html" },
      ])
    ).toBe(true);
    expect(isUnhostedRange([{ filename: "apps/mac/Owletto/App.swift" }])).toBe(
      true
    );
    // Mixed unhosted trees still qualify — none of them is hosted.
    expect(
      isUnhostedRange([
        { filename: "deploy/k8s/clusters/lobu-prod/apps.yaml" },
        { filename: "apps/chrome/manifest.json" },
      ])
    ).toBe(true);
    // A hosted change anywhere in the range still demands proof.
    expect(
      isUnhostedRange([
        { filename: "apps/chrome/watch.js" },
        { filename: "src/components/shell/responsive-app-shell.tsx" },
      ])
    ).toBe(false);
    // Fail closed on an apps/ tree that is NOT on the allowlist.
    expect(isUnhostedRange([{ filename: "apps/web/index.tsx" }])).toBe(false);
    // Build/post-build checks run in CI and are never served, so there is no
    // URL to compare — the same reason deploy/ and the packaged apps qualify.
    expect(
      isUnhostedRange([{ filename: "scripts/check-mcp-app-bundle.mjs" }])
    ).toBe(true);
    // ...but the prefix must not swallow a hosted tree that merely contains
    // a scripts/ directory, nor a sibling whose name it merely starts.
    expect(isUnhostedRange([{ filename: "src/scripts/widget.tsx" }])).toBe(
      false
    );
    expect(
      isUnhostedRange([{ filename: "scripts-archive/old-widget.tsx" }])
    ).toBe(false);

    // The unhosted prefixes are path prefixes, not substrings.
    expect(isUnhostedRange([{ filename: "src/deploy/widget.tsx" }])).toBe(
      false
    );
    expect(isUnhostedRange([{ filename: "src/apps/chrome/panel.tsx" }])).toBe(
      false
    );
    expect(
      isUnhostedRange([
        {
          filename: "deploy/k8s/archived-app.tsx",
          previous_filename: "src/app.tsx",
        },
      ])
    ).toBe(false);

    // Fail closed when the compare response tells us nothing, and when it may
    // have been truncated at the cap.
    expect(isUnhostedRange([])).toBe(false);
    expect(
      isUnhostedRange(
        Array.from({ length: COMPARE_FILE_CAP }, (_, index) => ({
          filename: `deploy/k8s/generated/${index}.yaml`,
        }))
      )
    ).toBe(false);
  });

  it("requires a hosted HTTPS artifact", () => {
    expect(isHttpsArtifact("https://claude.ai/code/artifact/example")).toBe(
      true
    );
    expect(isHttpsArtifact("http://localhost:9284/proof.html")).toBe(false);
    expect(isHttpsArtifact("/tmp/proof.html")).toBe(false);
  });

  it("matches only the exact repo/base/head/PR tuple a proof carries", () => {
    const matches = (candidate: UiReviewProof): boolean =>
      proofMatches(candidate, "lobu-ai/lobu", BASE_SHA, HEAD_SHA, 2500, 712);

    expect(matches(proof)).toBe(true);
    expect(matches({ ...proof, lobu_repo: "fork/lobu" })).toBe(false);
    expect(matches({ ...proof, lobu_base_owletto_sha: OTHER_SHA })).toBe(false);
    expect(matches({ ...proof, owletto_sha: OTHER_SHA })).toBe(false);
    expect(matches({ ...proof, lobu_pr: 2501 })).toBe(false);
    expect(matches({ ...proof, owletto_pr: 713 })).toBe(false);
  });
});

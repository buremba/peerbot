import { describe, expect, it } from "bun:test";
import {
  buildProofBody,
  findProofComment,
  isHttpsArtifact,
  parseProof,
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

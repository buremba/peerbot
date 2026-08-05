import { describe, expect, it } from "bun:test";
import {
  approvalCommand,
  buildProofBody,
  findApproval,
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

  it("round-trips machine state without hiding the human review instructions", () => {
    const body = buildProofBody(proof);

    expect(parseProof(body)).toEqual(proof);
    expect(body).toContain(`/ui-approve ${HEAD_SHA}`);
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

  it("binds approval to both ends of the deployed Owletto range", () => {
    expect(
      proofMatches(proof, "lobu-ai/lobu", BASE_SHA, HEAD_SHA, 2500, 712)
    ).toBe(true);
    expect(
      proofMatches(proof, "fork/lobu", BASE_SHA, HEAD_SHA, 2500, 712)
    ).toBe(false);
    expect(
      proofMatches(proof, "lobu-ai/lobu", OTHER_SHA, HEAD_SHA, 2500, 712)
    ).toBe(false);
    expect(
      proofMatches(proof, "lobu-ai/lobu", BASE_SHA, OTHER_SHA, 2500, 712)
    ).toBe(false);
    expect(
      proofMatches(proof, "lobu-ai/lobu", BASE_SHA, HEAD_SHA, 2501, 712)
    ).toBe(false);
    expect(
      proofMatches(proof, "lobu-ai/lobu", BASE_SHA, HEAD_SHA, 2500, 711)
    ).toBe(false);
  });

  it("accepts only an exact, later approval from an admin collaborator", () => {
    const comments: UiReviewComment[] = [
      {
        body: approvalCommand(HEAD_SHA),
        created_at: "2026-08-04T10:00:00Z",
        html_url:
          "https://github.com/lobu-ai/owletto/pull/712#issuecomment-old",
        user: { login: "buremba" },
      },
      {
        body: `${approvalCommand(HEAD_SHA)} please`,
        created_at: "2026-08-04T12:00:00Z",
        html_url:
          "https://github.com/lobu-ai/owletto/pull/712#issuecomment-extra",
        user: { login: "buremba" },
      },
      {
        body: approvalCommand(HEAD_SHA),
        created_at: "2026-08-04T12:01:00Z",
        html_url:
          "https://github.com/lobu-ai/owletto/pull/712#issuecomment-nonadmin",
        user: { login: "contributor" },
      },
      {
        body: approvalCommand(HEAD_SHA),
        created_at: "2026-08-04T12:02:00Z",
        html_url:
          "https://github.com/lobu-ai/owletto/pull/712#issuecomment-approved",
        user: { login: "buremba" },
      },
    ];

    expect(
      findApproval(
        comments,
        HEAD_SHA,
        "2026-08-04T11:00:00Z",
        new Set(["buremba"])
      )?.html_url
    ).toEndWith("issuecomment-approved");
    expect(
      findApproval(
        comments,
        OTHER_SHA,
        "2026-08-04T11:00:00Z",
        new Set(["buremba"])
      )
    ).toBeNull();
  });

  it("fails closed when proof and approval timestamps have equal precision", () => {
    const approval: UiReviewComment = {
      body: approvalCommand(HEAD_SHA),
      created_at: "2026-08-04T12:00:00Z",
      html_url:
        "https://github.com/lobu-ai/owletto/pull/712#issuecomment-same-second",
      user: { login: "buremba" },
    };

    expect(
      findApproval(
        [approval],
        HEAD_SHA,
        "2026-08-04T12:00:00Z",
        new Set(["buremba"])
      )
    ).toBeNull();
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
});

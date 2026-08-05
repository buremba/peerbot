import { Buffer } from "node:buffer";

export interface UiReviewProof {
  version: 1;
  lobu_repo: string;
  lobu_pr: number;
  lobu_base_owletto_sha: string;
  owletto_sha: string;
  owletto_pr: number;
  artifact_url: string;
}

export interface UiReviewComment {
  body: string;
  created_at: string;
  html_url: string;
  user: { login: string } | null;
}

export interface OwlettoPullRequest {
  number: number;
  html_url: string;
  merge_commit_sha: string | null;
  merged_at: string | null;
}

const PROOF_MARKER = "<!-- lobu-ui-review-proof ";
const SHA_PATTERN = /^[0-9a-f]{40}$/;

function isProof(value: unknown): value is UiReviewProof {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<UiReviewProof>;
  return (
    candidate.version === 1 &&
    typeof candidate.lobu_repo === "string" &&
    candidate.lobu_repo.includes("/") &&
    Number.isInteger(candidate.lobu_pr) &&
    (candidate.lobu_pr ?? 0) > 0 &&
    typeof candidate.lobu_base_owletto_sha === "string" &&
    SHA_PATTERN.test(candidate.lobu_base_owletto_sha) &&
    typeof candidate.owletto_sha === "string" &&
    SHA_PATTERN.test(candidate.owletto_sha) &&
    Number.isInteger(candidate.owletto_pr) &&
    (candidate.owletto_pr ?? 0) > 0 &&
    typeof candidate.artifact_url === "string" &&
    isHttpsArtifact(candidate.artifact_url)
  );
}

export function approvalCommand(owlettoSha: string): string {
  return `/ui-approve ${owlettoSha}`;
}

export function isHttpsArtifact(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

export function buildProofBody(proof: UiReviewProof): string {
  const encoded = Buffer.from(JSON.stringify(proof), "utf8").toString(
    "base64url"
  );
  const marker = `${PROOF_MARKER}${encoded} -->`;
  return `${marker}
## UI review required

This proof covers the Owletto version proposed by ${proof.lobu_repo}#${proof.lobu_pr}.

- Before: \`${proof.lobu_base_owletto_sha}\`
- After: \`${proof.owletto_sha}\`
- Visual comparison: ${proof.artifact_url}

After inspecting the comparison, approve this exact version with:

\`\`\`text
${approvalCommand(proof.owletto_sha)}
\`\`\`

A changed Owletto pointer or refreshed proof requires another approval.`;
}

export function parseProof(body: string): UiReviewProof | null {
  const firstLine = body.split("\n", 1)[0];
  if (!firstLine.startsWith(PROOF_MARKER) || !firstLine.endsWith(" -->"))
    return null;

  try {
    const encoded = firstLine.slice(PROOF_MARKER.length, -4);
    const parsed: unknown = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8")
    );
    return isProof(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Selects the proof this Lobu PR owns. Several Lobu PRs can pin the same
 * Owletto squash commit and therefore share one Owletto PR, so the marker
 * alone does not identify a proof — the encoded `lobu_repo`/`lobu_pr` does.
 */
export function findProofComment<Comment extends UiReviewComment>(
  comments: Comment[],
  lobuRepo: string,
  lobuPr: number
): Comment | undefined {
  return comments.find((comment) => {
    const proof = parseProof(comment.body);
    return proof?.lobu_repo === lobuRepo && proof.lobu_pr === lobuPr;
  });
}

export function proofMatches(
  proof: UiReviewProof,
  lobuRepo: string,
  baseOwlettoSha: string,
  owlettoSha: string,
  lobuPr: number,
  owlettoPr: number
): boolean {
  return (
    proof.lobu_repo === lobuRepo &&
    proof.lobu_base_owletto_sha === baseOwlettoSha &&
    proof.owletto_sha === owlettoSha &&
    proof.lobu_pr === lobuPr &&
    proof.owletto_pr === owlettoPr
  );
}

export function findApproval(
  comments: UiReviewComment[],
  owlettoSha: string,
  proofUpdatedAt: string,
  adminLogins: ReadonlySet<string>
): UiReviewComment | null {
  const command = approvalCommand(owlettoSha);
  const proofTime = Date.parse(proofUpdatedAt);
  if (Number.isNaN(proofTime)) return null;

  return (
    comments.find((comment) => {
      const login = comment.user?.login;
      return (
        comment.body.trim() === command &&
        typeof login === "string" &&
        adminLogins.has(login) &&
        Date.parse(comment.created_at) > proofTime
      );
    }) ?? null
  );
}

export function selectOwlettoPullRequest(
  pulls: OwlettoPullRequest[],
  owlettoSha: string
): OwlettoPullRequest | null {
  return (
    pulls.find(
      (pull) => pull.merged_at !== null && pull.merge_commit_sha === owlettoSha
    ) ?? null
  );
}

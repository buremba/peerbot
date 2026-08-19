import { Buffer } from "node:buffer";

interface UiReviewProofBase {
  version: 1;
  lobu_repo: string;
  lobu_pr: number;
  lobu_base_owletto_sha: string;
  owletto_sha: string;
  owletto_pr: number;
}

/** Screenshot-based proof: a hosted before/after comparison a human reviews. */
export interface ArtifactUiReviewProof extends UiReviewProofBase {
  artifact_url: string;
}

/**
 * Agent-judged proof: an independent reviewer CLI (the same one `make review`
 * uses) concluded the range has no user-visible UI surface at all, so a
 * screenshot comparison would have nothing to show. Recorded with its
 * reasoning and how the change was otherwise verified — evidence, not
 * assertion — so a human can audit the call same as a screenshot.
 */
export interface AgentUiReviewProof extends UiReviewProofBase {
  no_ui_surface: true;
  reviewer: string;
  reasoning: string;
  verification_summary: string;
}

export type UiReviewProof = ArtifactUiReviewProof | AgentUiReviewProof;

export function isArtifactProof(
  proof: UiReviewProof
): proof is ArtifactUiReviewProof {
  return "artifact_url" in proof;
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

export interface OwlettoCommit {
  commit: {
    author: { email: string | null } | null;
    message: string;
  };
  files?: Array<{ filename: string }>;
  parents: Array<{ sha: string }>;
}

const PROOF_MARKER = "<!-- lobu-ui-review-proof ";
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const FLUX_AUTHOR_EMAIL = "fluxcd@lobu.ai";
const FLUX_SUBJECT = "chore: update images";

function isProofBase(candidate: Partial<UiReviewProofBase>): boolean {
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
    (candidate.owletto_pr ?? 0) > 0
  );
}

function isProof(value: unknown): value is UiReviewProof {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<
    ArtifactUiReviewProof & AgentUiReviewProof
  >;
  if (!isProofBase(candidate)) return false;
  if (candidate.no_ui_surface === true) {
    return (
      typeof candidate.reviewer === "string" &&
      candidate.reviewer.length > 0 &&
      typeof candidate.reasoning === "string" &&
      candidate.reasoning.length > 0 &&
      typeof candidate.verification_summary === "string" &&
      candidate.verification_summary.length > 0
    );
  }
  return (
    typeof candidate.artifact_url === "string" &&
    isHttpsArtifact(candidate.artifact_url)
  );
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
  if (isArtifactProof(proof)) {
    return `${marker}
## UI proof

Visual evidence for the Owletto version proposed by ${proof.lobu_repo}#${proof.lobu_pr}.

- Before: \`${proof.lobu_base_owletto_sha}\`
- After: \`${proof.owletto_sha}\`
- Visual comparison: ${proof.artifact_url}

The comparison is captured from one booted instance against the same data on
both sides. A later pointer change that needs visual proof republishes it.`;
  }
  return `${marker}
## UI review: no UI surface

Independent review (\`${proof.reviewer}\`) for the Owletto version proposed by
${proof.lobu_repo}#${proof.lobu_pr} found no user-visible UI surface in this
range, so a screenshot comparison would have nothing to show.

- Before: \`${proof.lobu_base_owletto_sha}\`
- After: \`${proof.owletto_sha}\`

**Reasoning:** ${proof.reasoning}

**Verification:** ${proof.verification_summary}

A later pointer change that touches UI surface still needs a real screenshot
comparison — this classification is scoped to this exact range and republishes
whenever the range changes.`;
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

/**
 * The pointer can span several merged PRs, so inspect its endpoint diff rather
 * than only the head PR. GitHub caps comparison files at COMPARE_FILE_CAP and
 * reports no total, so empty and cap-sized responses fail closed. Renames must
 * stay under `deploy/` at both ends.
 */
export const COMPARE_FILE_CAP = 300;

export function isDeployOnlyRange(
  files: Array<{ filename: string; previous_filename?: string }>
): boolean {
  if (files.length === 0 || files.length >= COMPARE_FILE_CAP) return false;
  return files.every(
    (file) =>
      file.filename.startsWith("deploy/") &&
      (file.previous_filename === undefined ||
        file.previous_filename.startsWith("deploy/"))
  );
}

/**
 * Mirrors submodule-drift.yml's narrow exemption. UI proof still binds to the
 * exact parent pointer, but a deploy-only Flux tail is reviewed on the merged
 * product PR immediately beneath it.
 */
export function permittedFluxTailParent(commit: OwlettoCommit): string | null {
  const subject = commit.commit.message.split("\n", 1)[0];
  const files = commit.files ?? [];
  if (
    commit.commit.author?.email !== FLUX_AUTHOR_EMAIL ||
    subject !== FLUX_SUBJECT ||
    commit.parents.length !== 1 ||
    files.length === 0 ||
    files.some((file) => !file.filename.startsWith("deploy/"))
  ) {
    return null;
  }
  const parent = commit.parents[0]?.sha;
  return parent && SHA_PATTERN.test(parent) ? parent : null;
}

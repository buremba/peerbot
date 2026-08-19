#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import {
  buildProofBody,
  findProofComment,
  isUnhostedRange,
  UNHOSTED_PREFIXES,
  isHttpsArtifact,
  permittedFluxTailParent,
  type OwlettoPullRequest,
  parseProof,
  proofMatches,
  selectOwlettoPullRequest,
  type UiReviewComment,
  type UiReviewProof,
} from "./lib/ui-review-proof";

const STATUS_CONTEXT = "ui-review";
const PARENT_MARKER = "<!-- lobu-ui-review-marker -->";

interface PullRequestView {
  number: number;
  url: string;
  baseRefOid: string;
  headRefOid: string;
}

interface ApiComment extends UiReviewComment {
  id: number;
}

interface Options {
  artifactUrl?: string;
  open: boolean;
}

function run(command: string, args: string[], input?: string): string {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    input,
  });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "unknown error").trim();
    throw new Error(`${command} ${args.join(" ")} failed: ${detail}`);
  }
  return result.stdout.trim();
}

function jsonCommand<T>(command: string, args: string[], input?: string): T {
  const output = run(command, args, input);
  try {
    return JSON.parse(output) as T;
  } catch {
    throw new Error(`${command} returned invalid JSON`);
  }
}

function ghApi<T>(endpoint: string, method = "GET", payload?: unknown): T {
  const args = ["api"];
  let input: string | undefined;
  if (method !== "GET") args.push("-X", method);
  args.push(endpoint);
  if (payload !== undefined) {
    args.push("--input", "-");
    input = JSON.stringify(payload);
  }
  return jsonCommand<T>("gh", args, input);
}

function ghApiPages<T>(endpoint: string): T[] {
  const pages = jsonCommand<T[][]>("gh", [
    "api",
    endpoint,
    "--paginate",
    "--slurp",
  ]);
  return pages.flat();
}

function parseOptions(argv: string[]): Options {
  const options: Options = {
    artifactUrl: process.env.ARTIFACT?.trim() || undefined,
    open: ["1", "true", "yes"].includes((process.env.OPEN ?? "").toLowerCase()),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case "--artifact": {
        const value = argv[index + 1];
        if (!value) throw new Error("--artifact requires an HTTPS URL");
        options.artifactUrl = value;
        index += 1;
        break;
      }
      case "--open":
        options.open = true;
        break;
      default:
        throw new Error(`unknown argument: ${argument}`);
    }
  }
  if (options.artifactUrl && !isHttpsArtifact(options.artifactUrl)) {
    throw new Error("--artifact must be a hosted HTTPS URL, not a local path");
  }
  return options;
}

export function githubRepoFromRemote(remote: string): string {
  const normalized = remote
    .trim()
    .replace(/^git@github\.com:/, "")
    .replace(/^ssh:\/\/git@github\.com\//, "")
    .replace(/^https:\/\/github\.com\//, "")
    .replace(/\.git$/, "");
  if (!/^[^/]+\/[^/]+$/.test(normalized)) {
    throw new Error(`unsupported GitHub remote: ${remote}`);
  }
  return normalized;
}

function postStatus(
  repo: string,
  sha: string,
  state: "pending" | "success" | "error",
  description: string,
  targetUrl: string
): void {
  ghApi(`repos/${repo}/statuses/${sha}`, "POST", {
    state,
    context: STATUS_CONTEXT,
    description: description.slice(0, 140),
    target_url: targetUrl,
  });
}

function findComment(
  repo: string,
  issue: number,
  marker: string
): ApiComment | undefined {
  return ghApiPages<ApiComment>(`repos/${repo}/issues/${issue}/comments`).find(
    (comment) => comment.body.startsWith(marker)
  );
}

function writeComment(
  repo: string,
  issue: number,
  existing: ApiComment | undefined,
  body: string
): ApiComment {
  if (existing) {
    return ghApi<ApiComment>(
      `repos/${repo}/issues/comments/${existing.id}`,
      "PATCH",
      { body }
    );
  }
  return ghApi<ApiComment>(`repos/${repo}/issues/${issue}/comments`, "POST", {
    body,
  });
}

function upsertComment(
  repo: string,
  issue: number,
  marker: string,
  body: string
): ApiComment {
  return writeComment(repo, issue, findComment(repo, issue, marker), body);
}

function getPointer(repo: string, commit: string): string {
  const content = ghApi<{ sha?: string; type?: string }>(
    `repos/${repo}/contents/packages/owletto?ref=${commit}`
  );
  if (content.type !== "submodule" || !content.sha) {
    throw new Error(`packages/owletto is not a submodule at ${commit}`);
  }
  return content.sha;
}

function openPullRequest(url: string): void {
  const command = process.platform === "darwin" ? "open" : "xdg-open";
  const result = spawnSync(command, [url], { stdio: "ignore" });
  if (result.status !== 0) {
    console.warn(`Could not open the browser automatically. Open ${url}`);
  }
}

function resolveOwlettoPullRequest(
  repo: string,
  headPointer: string
): OwlettoPullRequest | null {
  let candidate = headPointer;
  // A short bounded walk handles consecutive Flux image bumps without ever
  // treating arbitrary commits as visual-review proof for a product PR.
  for (let depth = 0; depth < 20; depth += 1) {
    const pulls = ghApi<OwlettoPullRequest[]>(
      `repos/${repo}/commits/${candidate}/pulls`
    );
    const pull = selectOwlettoPullRequest(pulls, candidate);
    if (pull) return pull;

    const commit = ghApi<Parameters<typeof permittedFluxTailParent>[0]>(
      `repos/${repo}/commits/${candidate}`
    );
    const parent = permittedFluxTailParent(commit);
    if (!parent) return null;
    candidate = parent;
  }
  return null;
}

function parentCommentBody(
  proof: UiReviewProof,
  proofUrl: string,
  lobuHead: string
): string {
  return `${PARENT_MARKER}
**UI review recorded** for Lobu head \`${lobuHead}\`.

- Owletto range: \`${proof.lobu_base_owletto_sha}\` → \`${proof.owletto_sha}\`
- Proof: ${proofUrl}`;
}

function main(): number {
  const options = parseOptions(process.argv.slice(2));
  const localHead = run("git", ["rev-parse", "HEAD"]);
  const lobuRepo = run("gh", [
    "repo",
    "view",
    "--json",
    "nameWithOwner",
    "-q",
    ".nameWithOwner",
  ]);
  const parentPr = jsonCommand<PullRequestView>("gh", [
    "pr",
    "view",
    "--json",
    "number,url,baseRefOid,headRefOid",
  ]);
  if (parentPr.headRefOid !== localHead) {
    throw new Error(
      `local HEAD ${localHead} is not PR #${parentPr.number} head ${parentPr.headRefOid}; update the branch first`
    );
  }
  postStatus(
    lobuRepo,
    localHead,
    "pending",
    "UI review in progress",
    parentPr.url
  );

  const owlettoRemote = run("git", [
    "config",
    "-f",
    ".gitmodules",
    "--get",
    "submodule.packages/owletto.url",
  ]);
  const owlettoRepo = githubRepoFromRemote(owlettoRemote);

  const basePointer = getPointer(lobuRepo, parentPr.baseRefOid);
  const headPointer = getPointer(lobuRepo, parentPr.headRefOid);
  if (basePointer === headPointer) {
    const parentComment = findComment(lobuRepo, parentPr.number, PARENT_MARKER);
    if (parentComment) {
      ghApi(`repos/${lobuRepo}/issues/comments/${parentComment.id}`, "PATCH", {
        body: `${PARENT_MARKER}
**UI review not applicable** for Lobu head \`${localHead}\`.

\`packages/owletto\` remains at \`${headPointer}\`.`,
      });
    }
    postStatus(
      lobuRepo,
      localHead,
      "success",
      "No Owletto pointer change",
      parentPr.url
    );
    console.log(
      `ui-review: not applicable; packages/owletto remains ${headPointer}`
    );
    return 0;
  }

  const owlettoPr = resolveOwlettoPullRequest(owlettoRepo, headPointer);
  if (!owlettoPr) {
    postStatus(
      lobuRepo,
      localHead,
      "error",
      "Owletto pointer has no reviewable merged product PR",
      parentPr.url
    );
    throw new Error(
      `Owletto ${headPointer} is neither a merged ${owlettoRepo} PR squash commit nor a permitted Flux deploy-only tail`
    );
  }

  const comparison = ghApi<{
    status?: string;
    files?: Array<{ filename: string; previous_filename?: string }>;
  }>(`repos/${owlettoRepo}/compare/${basePointer}...${headPointer}`);
  const rangeFiles = comparison.files ?? [];
  if (comparison.status === "ahead" && isUnhostedRange(rangeFiles)) {
    const parentComment = findComment(lobuRepo, parentPr.number, PARENT_MARKER);
    if (parentComment) {
      ghApi(`repos/${lobuRepo}/issues/comments/${parentComment.id}`, "PATCH", {
        body: `${PARENT_MARKER}
**UI review not applicable** for Lobu head \`${localHead}\`.

\`${basePointer}...${headPointer}\` touches no hosted surface (${rangeFiles.length} files under ${UNHOSTED_PREFIXES.join(", ")}, through Owletto #${owlettoPr.number}).`,
      });
    }
    postStatus(
      lobuRepo,
      localHead,
      "success",
      `Owletto ${basePointer.slice(0, 9)}...${headPointer.slice(0, 9)} ships no hosted surface; no URL to prove`,
      owlettoPr.html_url
    );
    console.log(
      `ui-review: not applicable; Owletto ${basePointer.slice(0, 9)}...${headPointer.slice(0, 9)} touches no hosted surface (${rangeFiles.length} files)`
    );
    if (options.open) openPullRequest(owlettoPr.html_url);
    return 0;
  }

  const comments = ghApiPages<ApiComment>(
    `repos/${owlettoRepo}/issues/${owlettoPr.number}/comments`
  );
  let proofComment = findProofComment(comments, lobuRepo, parentPr.number);
  let currentProof = proofComment ? parseProof(proofComment.body) : null;
  const exactProof =
    currentProof &&
    proofMatches(
      currentProof,
      lobuRepo,
      basePointer,
      headPointer,
      parentPr.number,
      owlettoPr.number
    );

  if (
    !exactProof ||
    (options.artifactUrl && currentProof?.artifact_url !== options.artifactUrl)
  ) {
    if (!options.artifactUrl) {
      postStatus(
        lobuRepo,
        localHead,
        "error",
        "UI proof missing; rerun make ui-review with ARTIFACT=...",
        owlettoPr.html_url
      );
      if (options.open) openPullRequest(owlettoPr.html_url);
      throw new Error(
        `No current proof on ${owlettoPr.html_url}. Rerun with ARTIFACT=<hosted HTTPS comparison>.`
      );
    }

    currentProof = {
      version: 1,
      lobu_repo: lobuRepo,
      lobu_pr: parentPr.number,
      lobu_base_owletto_sha: basePointer,
      owletto_sha: headPointer,
      owletto_pr: owlettoPr.number,
      artifact_url: options.artifactUrl,
    };
    proofComment = writeComment(
      owlettoRepo,
      owlettoPr.number,
      proofComment,
      buildProofBody(currentProof)
    );
  }

  if (!currentProof || !proofComment) {
    throw new Error("UI proof publication did not return a usable comment");
  }

  // The proof is the deliverable: the before/after page is published on the
  // exact merged Owletto PR and linked from the parent, binding the evidence to
  // this pointer pair. Publishing it is what the gate now asserts — a human
  // reviews it on the PR like any other change, rather than blocking the check
  // behind a separate approval comment.
  upsertComment(
    lobuRepo,
    parentPr.number,
    PARENT_MARKER,
    parentCommentBody(currentProof, proofComment.html_url, localHead)
  );
  postStatus(
    lobuRepo,
    localHead,
    "success",
    `UI proof recorded for Owletto ${headPointer.slice(0, 9)}`,
    proofComment.html_url
  );

  console.log(`ui-review: proof recorded at ${proofComment.html_url}`);
  if (options.open) openPullRequest(owlettoPr.html_url);
  return 0;
}

if (import.meta.main) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}

#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import {
  approvalCommand,
  buildProofBody,
  findApproval,
  findProofComment,
  isHttpsArtifact,
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
  updated_at: string;
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

function findAdminLogins(
  repo: string,
  comments: ApiComment[],
  command: string,
  proofUpdatedAt: string
): Set<string> {
  const proofTime = Date.parse(proofUpdatedAt);
  const candidates = new Set(
    comments
      .filter(
        (comment) =>
          comment.body.trim() === command &&
          Date.parse(comment.created_at) > proofTime &&
          comment.user?.login
      )
      .map((comment) => comment.user?.login as string)
  );
  const admins = new Set<string>();
  for (const login of candidates) {
    try {
      const permission = ghApi<{ permission?: string }>(
        `repos/${repo}/collaborators/${login}/permission`
      );
      if (permission.permission === "admin") admins.add(login);
    } catch {
      // A missing collaborator or unreadable permission is not approval.
    }
  }
  return admins;
}

function openPullRequest(url: string): void {
  const command = process.platform === "darwin" ? "open" : "xdg-open";
  const result = spawnSync(command, [url], { stdio: "ignore" });
  if (result.status !== 0) {
    console.warn(`Could not open the browser automatically. Open ${url}`);
  }
}

function parentCommentBody(
  state: "pending" | "success",
  proof: UiReviewProof,
  proofUrl: string,
  approvalUrl: string | null,
  lobuHead: string
): string {
  const headline =
    state === "success" ? "UI review approved" : "UI review awaiting approval";
  const approvalLine = approvalUrl
    ? `- Approval: ${approvalUrl}`
    : `- Approval command: \`${approvalCommand(proof.owletto_sha)}\``;
  return `${PARENT_MARKER}
**${headline}** for Lobu head \`${lobuHead}\`.

- Owletto range: \`${proof.lobu_base_owletto_sha}\` → \`${proof.owletto_sha}\`
- Proof and approval thread: ${proofUrl}
${approvalLine}`;
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

  const pulls = ghApi<OwlettoPullRequest[]>(
    `repos/${owlettoRepo}/commits/${headPointer}/pulls`
  );
  const owlettoPr = selectOwlettoPullRequest(pulls, headPointer);
  if (!owlettoPr) {
    postStatus(
      lobuRepo,
      localHead,
      "error",
      "Owletto pointer is not an exact merged PR squash commit",
      parentPr.url
    );
    throw new Error(
      `Owletto ${headPointer} is not the squash commit of a merged ${owlettoRepo} PR`
    );
  }

  let comments = ghApiPages<ApiComment>(
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
    comments = ghApiPages<ApiComment>(
      `repos/${owlettoRepo}/issues/${owlettoPr.number}/comments`
    );
  }

  if (!currentProof || !proofComment) {
    throw new Error("UI proof publication did not return a usable comment");
  }

  const command = approvalCommand(headPointer);
  const adminLogins = findAdminLogins(
    owlettoRepo,
    comments,
    command,
    proofComment.updated_at
  );
  const approval = findApproval(
    comments,
    headPointer,
    proofComment.updated_at,
    adminLogins
  );
  const state = approval ? "success" : "pending";
  const description = approval
    ? `UI approved for Owletto ${headPointer.slice(0, 9)}`
    : `Awaiting UI approval for Owletto ${headPointer.slice(0, 9)}`;

  upsertComment(
    lobuRepo,
    parentPr.number,
    PARENT_MARKER,
    parentCommentBody(
      state,
      currentProof,
      proofComment.html_url,
      approval?.html_url ?? null,
      localHead
    )
  );
  postStatus(lobuRepo, localHead, state, description, proofComment.html_url);

  if (approval) {
    console.log(
      `ui-review: approved by ${approval.user?.login} at ${approval.html_url}`
    );
    return 0;
  }

  console.log(`ui-review: awaiting an admin comment on ${owlettoPr.html_url}`);
  console.log(command);
  if (options.open) openPullRequest(owlettoPr.html_url);
  return 3;
}

if (import.meta.main) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}

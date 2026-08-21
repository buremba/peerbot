import { readFile } from "node:fs/promises";
import { AGENT_KINDS } from "@lobu/core/contracts/worker/device-automation";
import type { AgentKind } from "@lobu/core/contracts/worker/device-automation";
import {
  attachClaudeAutomation,
  executeClaimedAutomationRun,
  detachClaudeAutomation,
  listClaudeAutomationAttachments,
  resolveClaudeSession,
  type ClaudeSessionResolverOptions,
  UnexecutableRunError,
} from "@lobu/connector-worker/daemon";
import { apiUrlToGatewayOrigin, resolveContext } from "../internal/context.js";

export interface AutomationExecuteOptions {
  apiUrl?: string;
  workerId?: string;
  jobFile?: string;
  defaultAgentKind?: string;
  context?: string;
  debug?: boolean;
}

export interface AutomationAttachOptions {
  sessionId?: string;
}

interface AutomationAttachmentCommandDeps {
  attachmentsFile?: string;
  env?: NodeJS.ProcessEnv;
  sessionResolver?: ClaudeSessionResolverOptions;
}

/** Record a local-only exact Automation → interactive Claude session route. */
export async function automationAttachCommand(
  automationId: string,
  options: AutomationAttachOptions,
  deps: AutomationAttachmentCommandDeps = {}
): Promise<void> {
  const env = deps.env ?? process.env;
  const requestedSessionId =
    options.sessionId?.trim() ?? env.CLAUDE_CODE_SESSION_ID?.trim();
  if (!requestedSessionId) {
    throw new UnexecutableRunError(
      "No Claude Code session id is available. Run this command inside Claude Code, or pass --session-id <id> for testing/manual attachment."
    );
  }
  const session = resolveClaudeSession(
    requestedSessionId,
    deps.sessionResolver
  );
  await attachClaudeAutomation(
    automationId,
    session.sessionId,
    deps.attachmentsFile
  );
  console.log(
    `Attached Automation ${automationId.trim()} locally to Claude session ${session.sessionId}.`
  );
  console.log(
    "This only configures routing for the standalone `lobu daemon`; the Automation must already be pinned to this Lobu device."
  );
}

/** Remove one local Automation → Claude route without mutating the Automation. */
export async function automationDetachCommand(
  automationId: string,
  deps: AutomationAttachmentCommandDeps = {}
): Promise<void> {
  const removed = await detachClaudeAutomation(
    automationId,
    deps.attachmentsFile
  );
  if (removed) {
    console.log(
      `Detached Automation ${automationId.trim()} from its local Claude session.`
    );
  } else {
    console.log(
      `Automation ${automationId.trim()} has no local Claude attachment.`
    );
  }
  console.log("No remote Automation or device pin was changed.");
}

/** List exact local routes and resolve current online/offline state. */
export async function automationAttachmentsCommand(
  deps: AutomationAttachmentCommandDeps = {}
): Promise<void> {
  const attachments = await listClaudeAutomationAttachments(
    deps.attachmentsFile
  );
  if (attachments.length === 0) {
    console.log("No local Claude Automation attachments.");
    return;
  }
  for (const attachment of attachments) {
    let status = "online";
    try {
      resolveClaudeSession(attachment.sessionId, deps.sessionResolver);
    } catch (error) {
      status = `offline (${error instanceof Error ? error.message : String(error)})`;
    }
    console.log(
      `${attachment.automationId}\t${attachment.sessionId}\t${status}`
    );
  }
  console.log(
    "Attachments are local routes for the standalone `lobu daemon`; device pinning remains server-managed."
  );
}

/**
 * Which agent runs an Automation that names no `agent_kind`.
 *
 * The device owns this: `agent_kind` is optional on the wire and which CLIs are
 * installed is a property of the machine. A caller passes its own user-facing
 * pick (the Mac app's menubar default). Rejected loudly rather than ignored —
 * silently falling through would surface much later as "no local agent
 * executor configured", pointing at the Automation instead of the flag.
 */
function parseDefaultAgentKind(
  value: string | undefined
): AgentKind | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (!(AGENT_KINDS as readonly string[]).includes(trimmed)) {
    throw new UnexecutableRunError(
      `--default-agent-kind '${trimmed}' is not a known agent (${AGENT_KINDS.join(", ")})`
    );
  }
  return trimmed as AgentKind;
}

/** Read the whole of stdin. Rejects a TTY so an unpiped invocation fails fast. */
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    throw new UnexecutableRunError(
      "no run envelope on stdin: pipe the /api/workers/poll response body in, or pass --job-file <path>"
    );
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * `lobu automation execute` — run one already-claimed device Automation.
 *
 * The device daemon (`lobu daemon`) claims and executes in one process. A
 * native bridge cannot: the Owletto Mac app must keep its own poll loop for the
 * platform connectors only it can serve, and a poll claims whatever the server
 * returns — including Automation runs pinned to that device. Rather than a
 * second poller racing the first on the same device row, the bridge stays the
 * only claimer and pipes the run here.
 *
 * Exit status IS the handoff contract, because both sides can otherwise report
 * the same run:
 *   - 0  → this command owns the outcome. It posted the exit report, or
 *          deliberately left an undeliverable one to the server's heartbeat
 *          sweep. The caller must not report.
 *   - !0 → nothing was reported and the run is untouched. The caller still owns
 *          it and must post its own failure, or the run sits `running`.
 * An older CLI without this command exits non-zero too ("unknown command"), so
 * a version-skewed caller falls into the safe half of the contract.
 */
export async function automationExecuteCommand(
  options: AutomationExecuteOptions
): Promise<void> {
  let apiUrl = options.apiUrl?.trim();
  if (!apiUrl) {
    try {
      // The worker API is mounted at the ORIGIN, not under the context's
      // `/api/v1` SDK path — see `apiUrlToGatewayOrigin`.
      apiUrl = apiUrlToGatewayOrigin(
        (await resolveContext(options.context)).url
      );
    } catch {
      // No context configured — surface the explicit requirement below.
    }
  }
  if (!apiUrl) {
    throw new UnexecutableRunError(
      "--api-url is required (or run `lobu login` to configure a context)"
    );
  }

  const workerId = options.workerId?.trim();
  if (!workerId) {
    throw new UnexecutableRunError(
      "--worker-id is required: it must be the id of the worker that claimed this run. " +
        "/complete-automation authorizes on claimed_by, and a mismatch is dropped as an " +
        "undelivered report rather than a failure, so the run would silently go unreported"
    );
  }

  // The claiming caller's own bearer. Never discovered from disk: the run is
  // authorized against the claim, so a different credential — even a valid one
  // for the same user — would report against a claim it does not hold.
  const authToken = process.env.WORKER_API_TOKEN?.trim();
  if (!authToken) {
    throw new UnexecutableRunError(
      "WORKER_API_TOKEN is required: pass the same bearer the claiming worker polled with"
    );
  }

  const defaultAgentKind = parseDefaultAgentKind(options.defaultAgentKind);

  const raw = options.jobFile
    ? await readFile(options.jobFile, "utf8")
    : await readStdin();
  let job: unknown;
  try {
    job = JSON.parse(raw);
  } catch (error) {
    throw new UnexecutableRunError(
      `run envelope is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const result = await executeClaimedAutomationRun({
    apiUrl,
    workerId,
    authToken,
    job,
    ...(defaultAgentKind ? { defaultAgentKind } : {}),
    debug: options.debug === true,
  });
  // A reported failure is still a delivered outcome, so it must not become a
  // non-zero exit — that would make the caller report the same run twice.
  if (result.error) {
    console.error(`  Automation run failed: ${result.error}`);
  }
}

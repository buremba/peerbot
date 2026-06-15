#!/usr/bin/env bun

import { createWriteStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createLogger, getSentry, type WorkerTransport } from "@lobu/core";
import type { ImageContent } from "@mariozechner/pi-ai";
import type { SettingsManager } from "@mariozechner/pi-coding-agent";
import * as Sentry from "@sentry/node";
import { classifyError, handleExecutionError } from "../core/error-handler";
import { listAppDirectories } from "../core/project-scanner";
import type {
  ProgressUpdate,
  SessionExecutionResult,
  WorkerConfig,
  WorkerExecutor,
} from "../core/types";
import { WorkspaceManager } from "../core/workspace";
import { HttpWorkerTransport } from "../gateway/gateway-integration";
import { generateCustomInstructions } from "../instructions/builder";
import { ProjectsInstructionProvider } from "../instructions/providers";
import { fetchAudioProviderSuggestions } from "../shared/audio-provider-suggestions";
import { getProviderAuthHintFromError } from "../shared/provider-auth-hints";
import {
  OpenClawCoreInstructionProvider,
  OpenClawPromptIntentInstructionProvider,
} from "./instructions";
import type { openOrCreateSessionManager } from "./model-resolver";
import { OpenClawProgressProcessor } from "./processor";
import { checkSandboxLeak } from "./sandbox-leak";
import {
  type buildAgentSession,
  countCompactionsOnCurrentBranch,
  estimatePromptTokenCost,
  getLatestAssistantText,
  MEMORY_FLUSH_STATE_CUSTOM_TYPE,
  type ResolvedMemoryFlushConfig,
  readLastFlushedCompactionCount,
  runAISession as runAISessionImpl,
} from "./session-runner";
import { type TerminalStatus, writeSnapshot } from "./transcript-snapshot";

// Re-export the session-runner utilities that other modules import via this
// barrel.
export {
  estimatePromptTokenCost,
  type ResolvedMemoryFlushConfig,
  replaceBasePromptIdentity,
  resolveMemoryFlushConfig,
} from "./session-runner";

const logger = createLogger("worker");

type MemoryFlushStateData = {
  compactionCount: number;
  outcome: "no_reply" | "stored";
  timestamp: number;
};

export class OpenClawWorker implements WorkerExecutor {
  private workspaceManager: WorkspaceManager;
  public workerTransport: WorkerTransport;
  private config: WorkerConfig;
  private progressProcessor: OpenClawProgressProcessor;
  /**
   * Terminal status for the current run, used by `cleanup()` to discriminate
   * the snapshot row. Defaults to `failed` (pessimistic) so an early crash
   * before any return-path assignment is recorded as a failure, not silently
   * accepted as a completion. Set to `completed` only on the success path
   * in `execute()`. Resets on every `execute()` invocation.
   */
  private terminalStatus: TerminalStatus = "failed";
  /**
   * Path to the OpenClaw session file for the current run. Captured in
   * `runAISession()` (where SessionManager opens it) so `cleanup()` can
   * read it back for the snapshot without re-deriving the path.
   */
  private sessionFilePath: string | null = null;
  /**
   * Resolved provider / model for the current run. Stamped via the
   * `onModelResolved` callback from `runAISession()` (session-runner.ts, the
   * only place model resolution happens) so the `execute()` catch-all and the
   * inner failure branches can tag Sentry issues with which provider/model
   * failed — the difference between a triageable "openai unknown-model" issue
   * and an opaque worker crash.
   */
  private resolvedProvider: string | undefined;
  private resolvedModelId: string | undefined;

  constructor(config: WorkerConfig) {
    this.config = config;
    this.workspaceManager = new WorkspaceManager(config.workspace);
    this.progressProcessor = new OpenClawProgressProcessor();

    const gatewayUrl = process.env.DISPATCHER_URL;
    const workerToken = process.env.WORKER_TOKEN;
    if (!gatewayUrl || !workerToken) {
      throw new Error(
        "DISPATCHER_URL and WORKER_TOKEN environment variables are required"
      );
    }
    if (!config.teamId) {
      throw new Error("teamId is required for worker initialization");
    }
    if (!config.conversationId) {
      throw new Error("conversationId is required for worker initialization");
    }

    this.workerTransport = new HttpWorkerTransport({
      gatewayUrl,
      workerToken,
      userId: config.userId,
      channelId: config.channelId,
      conversationId: config.conversationId,
      originalMessageTs: config.responseId,
      botResponseTs: config.botResponseId,
      teamId: config.teamId,
      platform: config.platform,
      platformMetadata: config.platformMetadata,
    });
  }

  /**
   * Main execution workflow
   */
  async execute(): Promise<void> {
    const executeStartTime = Date.now();
    // Reset terminal status for this run. Defaults to `failed` (pessimistic);
    // assigned to `completed` only on the success path below. SESSION_TIMEOUT
    // throws and is reassigned in the catch block.
    this.terminalStatus = "failed";
    // Reset per-run resolved provider/model so a prior run's values can't leak
    // into the Sentry tags of a failure that happens before model resolution.
    this.resolvedProvider = undefined;
    this.resolvedModelId = undefined;

    // Fail loud when the per-run scope the gateway is supposed to
    // provide hasn't reached this job. A silent skip in cleanup() would
    // hide a configuration bug across many turns; throwing here surfaces
    // it on the first turn and the runs queue's retry path handles
    // re-delivery. Codex round 2 quality win D on PR #865.
    if (typeof this.config.runId !== "number") {
      throw new Error(
        "WorkerConfig.runId is missing — runs-queue dispatch did not stamp runId on the job payload"
      );
    }
    if (!this.config.runJobToken) {
      throw new Error(
        "WorkerConfig.runJobToken is missing — MessageConsumer did not mint a per-run worker token"
      );
    }

    try {
      this.progressProcessor.reset();

      logger.info(
        `🚀 Starting OpenClaw worker for session: ${this.config.sessionKey}`
      );
      logger.info(
        `[TIMING] Worker execute() started at: ${new Date(executeStartTime).toISOString()}`
      );

      const userPrompt = Buffer.from(this.config.userPrompt, "base64").toString(
        "utf-8"
      );
      logger.info(`User prompt: ${userPrompt.substring(0, 100)}...`);

      logger.info("Setting up workspace...");

      await Sentry.startSpan(
        {
          name: "worker.workspace_setup",
          op: "worker.setup",
          attributes: {
            "user.id": this.config.userId,
            "session.key": this.config.sessionKey,
          },
        },
        async () => {
          await this.workspaceManager.setupWorkspace(
            this.config.userId,
            this.config.sessionKey
          );
        }
      );

      await this.setupIODirectories();
      await this.downloadInputFiles();

      let customInstructions = await generateCustomInstructions(
        [
          new OpenClawCoreInstructionProvider(),
          new OpenClawPromptIntentInstructionProvider(),
          new ProjectsInstructionProvider(),
        ],
        {
          userId: this.config.userId,
          agentId: this.config.agentId,
          sessionKey: this.config.sessionKey,
          workingDirectory: this.workspaceManager.getCurrentWorkingDirectory(),
          userPrompt,
          availableProjects: listAppDirectories(
            this.workspaceManager.getCurrentWorkingDirectory()
          ),
        }
      );

      customInstructions += this.getFileIOInstructions();

      logger.info(
        `[TIMING] Starting OpenClaw session at: ${new Date().toISOString()}`
      );
      const aiStartTime = Date.now();
      logger.info(
        `[TIMING] Total worker startup time: ${aiStartTime - executeStartTime}ms`
      );

      let firstOutputLogged = false;

      let sawUploadedFileEvent = false;

      const result = await Sentry.startSpan(
        {
          name: "worker.openclaw_execution",
          op: "ai.inference",
          attributes: {
            "user.id": this.config.userId,
            "session.key": this.config.sessionKey,
            "conversation.id": this.config.conversationId,
            agent: "OpenClaw",
          },
        },
        async () => {
          return await this.runAISession(
            userPrompt,
            customInstructions,
            async (update) => {
              if (!firstOutputLogged && update.type === "output") {
                logger.info(
                  `[TIMING] First OpenClaw output at: ${new Date().toISOString()} (${Date.now() - aiStartTime}ms after start)`
                );
                firstOutputLogged = true;
              }

              if (update.type === "output" && update.data) {
                const delta =
                  typeof update.data === "string" ? update.data : null;
                if (delta) {
                  await this.workerTransport.sendStreamDelta(delta, false);
                }
              } else if (update.type === "status_update") {
                await this.workerTransport.sendStatusUpdate(
                  update.data.elapsedSeconds,
                  update.data.state
                );
              } else if (update.type === "custom_event") {
                if (update.data.name === "file-uploaded") {
                  sawUploadedFileEvent = true;
                }
                await this.workerTransport.sendCustomEvent(
                  update.data.name,
                  update.data.payload
                );
              }
            }
          );
        }
      );

      if (result.success) {
        // Snapshot writer in cleanup() reads this to discriminate the row.
        // Hydrate skips non-completed snapshots, so getting this right is
        // what stops a failed turn from poisoning the next attempt.
        this.terminalStatus = "completed";
        await this.deliverFinalResult(sawUploadedFileEvent);
        await this.workerTransport.signalDone();
      } else {
        const errorMsg = result.error || "Unknown error";
        const isTimeout = result.exitCode === 124;

        if (isTimeout) {
          // Mark the snapshot as `timeout` instead of `failed` so operators
          // can distinguish runaway agents from genuine failures in the
          // dashboard. The catch block below sees `SESSION_TIMEOUT` and
          // keeps this assignment intact (it only forces `failed` on
          // exceptions that aren't already marked).
          this.terminalStatus = "timeout";
          logger.info(
            `Session timed out (exit code 124) - will be retried automatically, not showing error to user`
          );
          throw new Error("SESSION_TIMEOUT");
        } else {
          const isAuthError =
            /no.credentials.configured|no_credentials|invalid.*api.key|incorrect.*api.key|token.*expired/i.test(
              errorMsg
            );
          const userMessage = isAuthError
            ? "Your AI provider credentials are invalid or expired. End-user provider setup is not available in chat yet. Ask an admin to reconnect the base agent provider."
            : `❌ Session failed: ${errorMsg}`;
          await this.workerTransport.sendStreamDelta(userMessage, true, true);
          // These branches consume the `{success:false}` RESULT from
          // runAISession — the session failed without throwing, so neither
          // reaches execute()'s catch / handleExecutionError. Capture here or
          // the failure is invisible to Sentry. Auth errors are an
          // admin-config condition (level "warning"); other session failures
          // are real faults (level "error").
          this.reportSessionFailureToSentry(
            errorMsg,
            isAuthError ? "warning" : "error"
          );
          if (isAuthError) {
            await this.workerTransport.signalDone();
          } else {
            await this.workerTransport.signalError(
              new Error(errorMsg),
              classifyError(new Error(errorMsg))
            );
          }
        }
      }

      if (result.success) {
        logger.info("Worker completed with success");
      } else {
        // Log the actual failure reason. Without this the run is marked
        // failed (and the reply silently dropped) with no clue why — the
        // `error`/`exitCode` came back from runAISession but were never
        // surfaced, making prod failures undiagnosable from logs alone.
        logger.error(
          { err: result.error, exitCode: result.exitCode },
          "Worker completed with failure"
        );
      }
    } catch (error) {
      await handleExecutionError(error, this.workerTransport, {
        provider: this.resolvedProvider,
        model: this.resolvedModelId,
        agentId: this.config.agentId,
        runId: this.config.runId,
      });
    }
  }

  /**
   * Report a non-throwing session failure (the `{success:false}` result from
   * runAISession) to Sentry Issues, tagged with the resolved provider/model so
   * "openai doesn't work" is triageable. `getSentry()` is DSN-gated, so this is
   * a safe no-op when the worker was spawned without SENTRY_DSN.
   */
  private reportSessionFailureToSentry(
    errorMsg: string,
    level: "warning" | "error"
  ): void {
    const error = new Error(errorMsg);
    getSentry()?.captureException(error, {
      tags: {
        provider: this.resolvedProvider ?? "unknown",
        model: this.resolvedModelId ?? "unknown",
        agent_id: this.config.agentId ?? "unknown",
        run_id:
          this.config.runId != null ? String(this.config.runId) : "unknown",
        classification: classifyError(error) ?? "unclassified",
      },
      level,
    });
  }

  async cleanup(): Promise<void> {
    // Snapshot the post-run session.jsonl to Postgres so the next worker
    // (possibly on a different pod) can hydrate from it. Hydrate filters
    // `terminal_status='completed'`, so we ONLY POST on the success path
    // — writing `failed`/`timeout`/`cancelled` rows is pure network
    // waste (codex round 2 quality win C on PR #865).
    //
    // The runs queue has already moved this run to a terminal state by
    // the time cleanup() fires (sse-client.ts:865 finally block runs
    // after execute() returns). We POST in the worker's own dying
    // breath; the gateway-side advisory lock held by the spawner is
    // released when the subprocess exits, so by the next claim's boot
    // this snapshot is the visible "latest" row.
    if (this.sessionFilePath && this.terminalStatus === "completed") {
      const gatewayUrl = process.env.DISPATCHER_URL;
      const runId = this.config.runId;
      // Per-run JWT minted by the gateway's MessageConsumer alongside
      // `runId`. The snapshot route requires `tokenData.runId ===
      // body.runId`, so the deployment-lifetime WORKER_TOKEN cannot be
      // used here — it would carry no `runId` and the route would 403.
      // Codex round 2 finding A.
      const runJobToken = this.config.runJobToken;
      if (gatewayUrl && runJobToken && typeof runId === "number") {
        await writeSnapshot({
          sessionFile: this.sessionFilePath,
          gatewayUrl,
          workerToken: runJobToken,
          terminalStatus: this.terminalStatus,
          runId,
        });
      } else if (gatewayUrl) {
        // Missing per-run scope (legacy direct-enqueue path or token
        // mint failure on the gateway). Skip the snapshot rather than
        // risk a mis-attributed row; the next run will hydrate from
        // the previous completed snapshot the next time a normal
        // runs-queue dispatch comes through.
        logger.warn(
          `Skipping transcript snapshot: ${
            typeof runId !== "number"
              ? "WorkerConfig.runId is missing"
              : "WorkerConfig.runJobToken is missing"
          } (legacy enqueue path)`
        );
      }
    }
    logger.info("Worker cleanup completed");
  }

  getWorkerTransport(): WorkerTransport | null {
    return this.workerTransport;
  }

  private async maybeRunPreCompactionMemoryFlush(params: {
    session: Awaited<ReturnType<typeof buildAgentSession>>["session"];
    sessionManager: Awaited<ReturnType<typeof openOrCreateSessionManager>>;
    settingsManager: SettingsManager;
    memoryFlushConfig: ResolvedMemoryFlushConfig;
    incomingPromptText: string;
    incomingImageCount: number;
    runSilentPrompt: (prompt: string) => Promise<void>;
  }): Promise<void> {
    const {
      session,
      sessionManager,
      settingsManager,
      memoryFlushConfig,
      incomingPromptText,
      incomingImageCount,
      runSilentPrompt,
    } = params;

    if (!memoryFlushConfig.enabled) {
      return;
    }

    if (!settingsManager.getCompactionEnabled()) {
      return;
    }

    const contextUsage = session.getContextUsage();
    if (!contextUsage) {
      return;
    }

    const reserveTokens = settingsManager.getCompactionReserveTokens();
    const currentCompactionCount =
      countCompactionsOnCurrentBranch(sessionManager);
    const lastFlushedCompactionCount =
      readLastFlushedCompactionCount(sessionManager);

    if (lastFlushedCompactionCount === currentCompactionCount) {
      return;
    }

    const incomingPromptTokens = estimatePromptTokenCost(
      incomingPromptText,
      incomingImageCount
    );
    const thresholdTokens =
      contextUsage.contextWindow -
      reserveTokens -
      memoryFlushConfig.softThresholdTokens;
    const projectedContextTokens = contextUsage.tokens + incomingPromptTokens;

    if (projectedContextTokens < thresholdTokens) {
      return;
    }

    const flushPrompt = `${memoryFlushConfig.systemPrompt}\n\n${memoryFlushConfig.prompt}`;
    logger.info(
      `Running silent pre-compaction memory flush: projected=${projectedContextTokens}, threshold=${thresholdTokens}, compactionCount=${currentCompactionCount}`
    );

    try {
      await runSilentPrompt(flushPrompt);
      const lastAssistant = getLatestAssistantText(
        session.messages as unknown[]
      );
      const outcome: MemoryFlushStateData["outcome"] =
        lastAssistant?.normalizedNoReply === true ? "no_reply" : "stored";

      sessionManager.appendCustomEntry(MEMORY_FLUSH_STATE_CUSTOM_TYPE, {
        compactionCount: currentCompactionCount,
        outcome,
        timestamp: Date.now(),
      } satisfies MemoryFlushStateData);
    } catch (error) {
      logger.warn(
        `Silent pre-compaction memory flush failed, continuing main prompt: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  // ---------------------------------------------------------------------------
  // AI session
  // ---------------------------------------------------------------------------

  private async runAISession(
    userPrompt: string,
    customInstructions: string,
    onProgress: (update: ProgressUpdate) => Promise<void>
  ): Promise<SessionExecutionResult> {
    return runAISessionImpl({
      userPrompt,
      customInstructions,
      onProgress,
      agentOptions: this.config.agentOptions,
      sessionKey: this.config.sessionKey,
      channelId: this.config.channelId,
      conversationId: this.config.conversationId,
      platform: this.config.platform,
      platformMetadata: this.config.platformMetadata,
      agentId: this.config.agentId,
      runJobToken: this.config.runJobToken,
      workspaceDir: this.workspaceManager.getCurrentWorkingDirectory(),
      progressProcessor: this.progressProcessor,
      onSessionFilePathResolved: (filePath) => {
        this.sessionFilePath = filePath;
      },
      onModelResolved: (provider, modelId) => {
        // Stamp for Sentry tagging in execute()'s catch-all + failure
        // branches. Anything that fails after this point (unknown model,
        // unresolved base URL, provider auth) is attributable to a specific
        // provider/model.
        this.resolvedProvider = provider;
        this.resolvedModelId = modelId;
      },
      loadImageAttachments: () => this.loadImageAttachments(),
      maybeRunPreCompactionMemoryFlush: (p) =>
        this.maybeRunPreCompactionMemoryFlush(p),
      maybeBuildAuthHintMessage: (msg, provider, modelId) =>
        this.maybeBuildAuthHintMessage(msg, provider, modelId),
    });
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private async setupIODirectories(): Promise<void> {
    const workspaceDir = this.workspaceManager.getCurrentWorkingDirectory();
    const inputDir = path.join(workspaceDir, "input");
    const outputDir = path.join(workspaceDir, "output");
    const tempDir = path.join(workspaceDir, "temp");

    await fs.mkdir(inputDir, { recursive: true });
    await fs.mkdir(outputDir, { recursive: true });
    await fs.mkdir(tempDir, { recursive: true });

    try {
      const files = await fs.readdir(outputDir);
      await Promise.all(
        files.map((file) =>
          fs.unlink(path.join(outputDir, file)).catch(() => {
            /* intentionally empty */
          })
        )
      );
    } catch (error) {
      logger.debug("Could not clear output directory:", error);
    }

    logger.info("I/O directories setup completed");
  }

  private async downloadInputFiles(): Promise<void> {
    const files = this.uploadedFiles;
    if (files.length === 0) {
      return;
    }

    logger.info(`Downloading ${files.length} input files...`);
    const workspaceDir = this.workspaceManager.getCurrentWorkingDirectory();
    const inputDir = path.join(workspaceDir, "input");

    for (const file of files) {
      try {
        if (!file.downloadUrl) {
          logger.warn(
            { fileName: file.name, fileId: file.id },
            "Inbound file has no downloadUrl; gateway must publish it as an artifact before forwarding"
          );
          continue;
        }
        logger.info(`Downloading file: ${file.name} (${file.id})`);

        // The gateway pre-publishes every inbound attachment as a signed,
        // time-limited artifact and embeds the URL in `downloadUrl`. We
        // fetch through the worker's egress proxy — no platform tokens or
        // worker JWT cross this boundary anymore.
        const response = await fetch(file.downloadUrl, {
          signal: AbortSignal.timeout(60_000),
        });

        if (!response.ok) {
          logger.error(
            `Failed to download file ${file.name}: ${response.statusText}`
          );
          continue;
        }

        // Sanitize file name to prevent path traversal
        const safeName = path.basename(file.name);
        if (!safeName || safeName === "." || safeName === "..") {
          logger.warn(`Skipping file with invalid name: ${file.name}`);
          continue;
        }
        if (safeName !== file.name) {
          logger.warn(
            `Sanitized file name from "${file.name}" to "${safeName}"`
          );
        }

        if (!response.body) {
          logger.error(`Response body is null for file ${safeName}`);
          continue;
        }

        const destPath = path.join(inputDir, safeName);
        const fileStream = Readable.fromWeb(response.body as any);
        const writeStream = createWriteStream(destPath);

        await pipeline(fileStream, writeStream);
        logger.info(`Downloaded: ${safeName} to input directory`);
      } catch (error) {
        logger.error(`Error downloading file ${file.name}:`, error);
      }
    }
  }

  private get uploadedFiles(): Array<{
    id: string;
    name: string;
    mimetype: string;
    downloadUrl?: string;
  }> {
    return (this.config as any).platformMetadata?.files || [];
  }

  private static isImage(mimetype?: string): boolean {
    return !!mimetype?.startsWith("image/");
  }

  private getFileIOInstructions(): string {
    const workspaceDir = this.workspaceManager.getCurrentWorkingDirectory();
    const files = this.uploadedFiles;

    const fileOutputRules = `
**Mandatory workflow for ANY file you create or generate:**
1. Write the file to disk (e.g. \`output/report.pdf\`).
2. Call \`upload_file\` with the file path — this is the ONLY way the user can access it.
3. Confirm delivery ONLY after \`upload_file\` succeeds.

**Workspace paths are not accessible to users.** Paths like \`/workspace/...\` or \`/app/workspaces/...\` are internal sandbox paths. Never show them as file locations, download links, or "saved at" references. The user cannot reach them. Always use \`upload_file\` instead.`;

    const common = `

## File Generation & Output

${fileOutputRules}

**When to Create Files:**
Create and show files for any output that helps answer the user's request:
- **Charts & visualizations**: pie charts, bar graphs, plots, diagrams via \`matplotlib\`
- **Reports & documents**: analysis reports, summaries, PDFs
- **Data files**: CSV exports, JSON data, spreadsheets
- **Code files**: scripts, configurations, examples
- **Images**: generated images, processed photos, screenshots.
`;

    if (files.length === 0) {
      return common;
    }

    const fileListing = files
      .map(
        (f) =>
          `- \`${workspaceDir}/input/${f.name}\` (${f.mimetype || "unknown type"})`
      )
      .join("\n");

    const hasImages = files.some((f) => OpenClawWorker.isImage(f.mimetype));
    const hasNonImages = files.some((f) => !OpenClawWorker.isImage(f.mimetype));

    let hints = "";
    if (hasImages) {
      hints +=
        "\nImage files have been included directly in this message for visual analysis.";
    }
    if (hasNonImages) {
      hints +=
        "\nYou can read non-image files with standard commands like `cat`, `less`, or `head`.";
    }

    return `${common}
### User-Uploaded Files
The user has uploaded ${files.length} file(s) for you to analyze:
${fileListing}

**Use these files to answer the user's request.**${hints}
`;
  }

  /** Max image size to embed in prompt (20 MB). Larger files are skipped. */
  private static readonly MAX_IMAGE_BYTES = 20 * 1024 * 1024;

  private async loadImageAttachments(): Promise<ImageContent[]> {
    const imageFiles = this.uploadedFiles.filter((f) =>
      OpenClawWorker.isImage(f.mimetype)
    );
    if (imageFiles.length === 0) return [];

    const inputDir = path.join(
      this.workspaceManager.getCurrentWorkingDirectory(),
      "input"
    );
    const results: ImageContent[] = [];

    for (const file of imageFiles) {
      try {
        // Sanitize file name to prevent path traversal
        const safeName = path.basename(file.name);
        if (!safeName || safeName === "." || safeName === "..") {
          logger.warn(`Skipping image with invalid name: ${file.name}`);
          continue;
        }
        if (safeName !== file.name) {
          logger.warn(
            `Sanitized image file name from "${file.name}" to "${safeName}"`
          );
        }
        const data = await fs.readFile(path.join(inputDir, safeName));
        if (data.length > OpenClawWorker.MAX_IMAGE_BYTES) {
          logger.warn(
            `Skipping image ${file.name}: ${Math.round(data.length / 1024 / 1024)}MB exceeds limit`
          );
          continue;
        }
        results.push({
          type: "image",
          data: data.toString("base64"),
          mimeType: file.mimetype,
        });
        logger.info(
          `Loaded image: ${file.name} (${file.mimetype}, ${Math.round(data.length / 1024)}KB)`
        );
      } catch (error) {
        logger.warn(`Failed to load image ${file.name}:`, error);
      }
    }

    return results;
  }

  /**
   * Finalize a successful turn: run the sandbox-leak safety net against the
   * agent's user-facing output and, when a leak is detected, re-send a redacted
   * full-replacement so the client discards the already-streamed leaky prefix.
   *
   * The content has normally already been streamed delta-by-delta, so the
   * no-leak path does NOT re-send (that would duplicate the message). The final
   * result must be populated by runAISession() on the success path (via
   * progressProcessor.setFinalResult) — when it is left null, getFinalResult()
   * returns null here and the leak check never runs.
   */
  private async deliverFinalResult(
    sawUploadedFileEvent: boolean
  ): Promise<void> {
    const outputSnapshot = this.progressProcessor.getOutputSnapshot();
    const hintGatewayUrl = process.env.DISPATCHER_URL;
    const hintWorkerToken = process.env.WORKER_TOKEN;
    const audioPermissionHint =
      hintGatewayUrl && hintWorkerToken
        ? await this.maybeBuildAudioPermissionHintMessage(
            outputSnapshot,
            hintGatewayUrl,
            hintWorkerToken
          )
        : null;
    const finalResult = this.progressProcessor.getFinalResult();
    const leakCheck = finalResult
      ? checkSandboxLeak(finalResult.text, sawUploadedFileEvent)
      : null;
    if (leakCheck?.leaked && finalResult) {
      logger.warn(
        "Detected unfulfilled file-delivery claim in final message; redacting link targets"
      );
      // The already-streamed content still contains the pre-redaction URLs —
      // a delta-append would leave them on the client. Force a full
      // replacement so the client discards the leaky prefix.
      const finalText = audioPermissionHint
        ? `${leakCheck.redactedText}\n\n${audioPermissionHint}`
        : leakCheck.redactedText;
      logger.info(
        `📤 Re-sending redacted final result (${finalText.length} chars) as full replacement`
      );
      await this.workerTransport.sendStreamDelta(
        finalText,
        true,
        finalResult.isFinal
      );
    } else if (audioPermissionHint) {
      logger.info("📤 Sending audio permission settings hint to user");
      await this.workerTransport.sendStreamDelta(
        `\n\n${audioPermissionHint}`,
        false
      );
    } else {
      logger.info(
        "Session completed successfully - all content already streamed"
      );
    }
  }

  private maybeBuildAuthHintMessage(
    errorMessage: string,
    provider: string,
    modelId: string
  ): string {
    const authHint = getProviderAuthHintFromError(errorMessage, provider);
    if (!authHint) {
      return errorMessage;
    }

    return `To use ${modelId}, an admin needs to connect ${authHint.providerName} on the base agent. Ask an admin to configure ${authHint.providerName} and then try again.`;
  }

  private async maybeBuildAudioPermissionHintMessage(
    outputText: string,
    gatewayUrl: string,
    workerToken: string
  ): Promise<string | null> {
    const lower = outputText.toLowerCase();
    if (!lower.includes("api.model.audio.request")) {
      return null;
    }

    if (
      lower.includes("settings button has been sent") ||
      lower.includes("connect button has been sent") ||
      lower.includes("open settings") ||
      lower.includes("secure connect link")
    ) {
      return null;
    }

    try {
      const suggestions = await fetchAudioProviderSuggestions({
        gatewayUrl,
        workerToken,
      });
      const providerList =
        suggestions.providerDisplayList || "an audio-capable provider";

      return `Voice generation needs an audio-capable provider (${providerList}) connected on the base agent. Ask an admin to connect one of these providers, then try again.`;
    } catch (error) {
      logger.error("Failed to fetch audio provider suggestions", error);
      return null;
    }
  }
}

/**
 * The history an agent turn resumes from, fitted to the model's real context.
 *
 * The isolate lane used to take the last twelve messages of the transcript and
 * cap each at 16 000 characters. That is a hard truncation with two failure
 * modes and no signal for either: a short conversation on a large model threw
 * away context it could have carried, and a long one silently lost whatever
 * fell off the front — the model answered as if the earlier turns had never
 * happened. The subprocess lane never had that problem because pi compacted
 * against the model's own window.
 *
 * This module restores that on the producer side, where it belongs:
 *
 *  - the budget comes from the model's REAL context window
 *    (`resolveModelCapability`), not a hardcoded 200k;
 *  - as much recent history as fits is kept verbatim;
 *  - what does not fit is SUMMARIZED rather than dropped, through the gateway's
 *    existing shared LLM transport (`gatewayCompletion`), so continuity
 *    survives and no new provider client or credential is introduced;
 *  - if summarization is unavailable or fails, the turn still runs on the
 *    recent window and says so in the log — a degraded turn beats no turn.
 *
 * Compaction runs HERE and not in the guest deliberately. The guest has one
 * credential, which is the turn's own provider placeholder; making it summarize
 * would mean a second model call on the turn's wall clock, inside the isolate,
 * against the agent's own provider. The producer already holds an org-scoped
 * completion target for exactly this class of work.
 */

import { createLogger, estimateMessageTokens, getErrorMessage } from "@lobu/core";
import {
  gatewayCompletion,
  resolveCompletionTarget,
} from "../inference/gateway-completion.js";
import type { ModelCapability } from "../inference/model-capability.js";

const logger = createLogger("turn-history");

/** A transcript message in pi's shape, as the wire carries it. */
export type HistoryMessage = Record<string, unknown> & { role: string };

/**
 * Share of the context window the resumed history may occupy.
 *
 * The rest is not spare: the turn's system prompt, its tool schemas, the new
 * user message and the model's own reply all come out of the same window, and
 * the tool schemas in particular are large and not knowable here. Half is the
 * same order pi's own `DEFAULT_COMPACTION_SETTINGS` reserves.
 */
const HISTORY_BUDGET_FRACTION = 0.5;

/** Never resume from fewer than this many recent messages, budget permitting. */
const MIN_RECENT_MESSAGES = 2;

/**
 * Characters of dropped transcript fed to the summarizer. The summary exists
 * to preserve continuity, not to be a second transcript, and an unbounded
 * prompt here would put the producer's own cost on a conversation's length.
 */
const SUMMARY_SOURCE_CHARS = 60_000;

/** Output ceiling for the summary itself, in tokens. */
const SUMMARY_MAX_TOKENS = 700;

/** The summarizer's budget. Well inside the enqueue path's own tolerance. */
const SUMMARY_TIMEOUT_MS = 20_000;

const SUMMARY_SYSTEM_PROMPT = [
  "You compact the earlier part of an ongoing conversation between a user and an assistant so the assistant can continue it without having read that part.",
  "Write a factual brief, not a narrative summary and not a reply to anyone.",
  "Preserve, in this order of priority: decisions and commitments made; facts, names, ids, numbers and file paths established; what the user asked for and any constraint they stated; work already completed and work still outstanding; anything the assistant promised to do next.",
  "Drop pleasantries, restatements and reasoning that led nowhere.",
  "Never invent detail that is not in the transcript, and never answer the user's questions yourself.",
  "Reply with the brief only — no preamble, no headings, no markdown fences.",
].join(" ");

export interface FittedHistory {
  /** Messages to resume from, oldest first, already squared off. */
  messages: HistoryMessage[];
  /** Prose summary of everything older, or null when nothing was dropped. */
  summary: string | null;
  /** How many messages the summary stands in for. */
  droppedCount: number;
  /** Estimated tokens of the kept window. */
  keptTokens: number;
  /** The token budget the window was fitted to. */
  budgetTokens: number;
  /**
   * True when history was dropped and no summary could be produced, so the
   * turn resumes with a real gap. The caller logs this; it is the honest
   * degraded outcome, not an error.
   */
  summaryUnavailable: boolean;
}

/** The message that carries a compaction summary into the turn. */
export function summaryMessage(summary: string, droppedCount: number): HistoryMessage {
  return {
    role: "user",
    content: [
      {
        type: "text",
        text:
          `[Earlier in this conversation — ${droppedCount} message${droppedCount === 1 ? "" : "s"} summarized, not shown verbatim]\n\n` +
          `${summary}\n\n` +
          "[End of summary. The messages that follow are the recent conversation, verbatim.]",
      },
    ],
  };
}

/**
 * Square off a window so a provider will accept it: it must open on a user
 * message, and it must not end on an assistant tool call whose result was left
 * behind. Both are provider-level rejections, not preferences.
 */
export function squareOff(window: HistoryMessage[]): HistoryMessage[] {
  const firstUser = window.findIndex((message) => message.role === "user");
  if (firstUser < 0) return [];
  const squared = window.slice(firstUser);
  while (squared.length > 0) {
    const last = squared[squared.length - 1]!;
    if (last.role === "assistant" && hasToolCall(last)) {
      squared.pop();
      continue;
    }
    break;
  }
  return squared;
}

function hasToolCall(message: HistoryMessage): boolean {
  return (
    Array.isArray(message.content) &&
    message.content.some(
      (block) => !!block && typeof block === "object" && (block as { type?: unknown }).type === "toolCall"
    )
  );
}

/** Plain text of a message, for the summarizer's prompt. */
function messageText(message: HistoryMessage): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const typed = block as { type?: unknown; text?: unknown; name?: unknown };
    if (typed.type === "text" && typeof typed.text === "string") parts.push(typed.text);
    else if (typed.type === "toolCall" && typeof typed.name === "string") {
      parts.push(`[called tool ${typed.name}]`);
    }
  }
  return parts.join("\n");
}

/**
 * Render the dropped prefix for the summarizer, oldest first and capped.
 *
 * The cap keeps the TAIL of the prefix — the part nearest the surviving window
 * — because that is what the recent messages refer back to.
 */
function renderForSummary(dropped: HistoryMessage[]): string {
  const lines: string[] = [];
  for (const message of dropped) {
    const text = messageText(message).trim();
    if (!text) continue;
    const speaker =
      message.role === "user" ? "User" : message.role === "assistant" ? "Assistant" : "Tool";
    lines.push(`${speaker}: ${text}`);
  }
  const joined = lines.join("\n\n");
  return joined.length > SUMMARY_SOURCE_CHARS ? joined.slice(-SUMMARY_SOURCE_CHARS) : joined;
}

/**
 * Split `messages` into the newest window that fits `budgetTokens` and the
 * older remainder.
 *
 * Always keeps at least `MIN_RECENT_MESSAGES` even when they exceed the budget:
 * a turn that resumes from nothing is worse than one that resumes from a window
 * the upstream may itself trim, and the caller's oversize check below is what
 * turns a genuinely impossible turn into an honest failure rather than a
 * silently empty one.
 */
function fitWindow(
  messages: HistoryMessage[],
  budgetTokens: number
): { kept: HistoryMessage[]; dropped: HistoryMessage[]; keptTokens: number } {
  let keptTokens = 0;
  let index = messages.length;
  while (index > 0) {
    const cost = estimateMessageTokens(messages[index - 1]!);
    const wouldKeep = messages.length - index + 1;
    if (keptTokens + cost > budgetTokens && wouldKeep > MIN_RECENT_MESSAGES) break;
    keptTokens += cost;
    index--;
  }
  return {
    kept: messages.slice(index),
    dropped: messages.slice(0, index),
    keptTokens,
  };
}

/**
 * Fit a conversation to the model's context, summarizing what does not fit.
 *
 * `organizationId` scopes the summarizer's credentials, so a summary is always
 * produced with the asking org's own provider row and one org's transcript can
 * never be sent through another's.
 */
export async function fitHistoryToContext(args: {
  messages: HistoryMessage[];
  capability: ModelCapability;
  organizationId: string;
  agentId: string;
  conversationId: string;
}): Promise<FittedHistory> {
  const budgetTokens = Math.max(
    1,
    Math.floor(args.capability.contextWindow * HISTORY_BUDGET_FRACTION)
  );
  const { kept, dropped, keptTokens } = fitWindow(args.messages, budgetTokens);
  const squared = squareOff(kept);
  // Squaring off can shed leading messages; whatever it shed is older than the
  // window and belongs with the dropped prefix, in order.
  const shed = kept.length - squared.length;
  const allDropped = shed > 0 ? [...dropped, ...kept.slice(0, shed)] : dropped;

  if (allDropped.length === 0) {
    return {
      messages: squared,
      summary: null,
      droppedCount: 0,
      keptTokens,
      budgetTokens,
      summaryUnavailable: false,
    };
  }

  const source = renderForSummary(allDropped);
  if (!source) {
    // Nothing summarizable was dropped (tool noise, empty messages). Not a gap.
    return {
      messages: squared,
      summary: null,
      droppedCount: allDropped.length,
      keptTokens,
      budgetTokens,
      summaryUnavailable: false,
    };
  }

  let summary: string | null = null;
  try {
    const target = await resolveCompletionTarget(args.organizationId);
    if (!target) {
      logger.info(
        { agentId: args.agentId, conversationId: args.conversationId },
        "Turn history: the org has no completion target, so the dropped prefix could not be summarized"
      );
    } else {
      const reply = await gatewayCompletion({
        target,
        systemPrompt: SUMMARY_SYSTEM_PROMPT,
        userPrompt: source,
        timeoutMs: SUMMARY_TIMEOUT_MS,
        maxTokens: SUMMARY_MAX_TOKENS,
        // Fail-open: the turn runs on the recent window either way, and a
        // retry here spends the enqueue path's latency for a nicety.
        maxRetries: 1,
      });
      const trimmed = reply.trim();
      if (trimmed) summary = trimmed;
    }
  } catch (error) {
    logger.warn(
      {
        agentId: args.agentId,
        conversationId: args.conversationId,
        error: getErrorMessage(error),
      },
      "Turn history: summarizing the dropped prefix failed; the turn resumes from the recent window only"
    );
  }

  return {
    messages: squared,
    summary,
    droppedCount: allDropped.length,
    keptTokens,
    budgetTokens,
    summaryUnavailable: summary === null,
  };
}

import { createLogger } from "@lobu/core";
import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import { formatToolExecution } from "../shared/processor-utils";

const logger = createLogger("openclaw-processor");

/**
 * Processes Pi agent streaming events and extracts user-friendly content.
 * Implements chronological display with tool progress and mixed text/tool output.
 */
export class OpenClawProgressProcessor {
  private chronologicalOutput = "";
  private lastSentContent = "";
  private currentThinking = "";
  private verboseLogging = false;
  private finalResult: { text: string; isFinal: boolean } | null = null;
  private hasStreamedText = false;
  private fatalErrorMessage: string | null = null;

  setVerboseLogging(enabled: boolean): void {
    this.verboseLogging = enabled;
    logger.info(`Verbose logging ${enabled ? "enabled" : "disabled"}`);
  }

  /**
   * Process a Pi agent session event and append to chronological output.
   * Returns true if new content was appended.
   */
  processEvent(event: AgentSessionEvent): boolean {
    switch (event.type) {
      case "message_update": {
        if (event.message.role !== "assistant") {
          return false;
        }
        const assistantEvent = event.assistantMessageEvent;

        if (assistantEvent.type === "text_delta") {
          this.hasStreamedText = true;
          this.chronologicalOutput += assistantEvent.delta;
          return true;
        }

        if (assistantEvent.type === "thinking_delta") {
          this.currentThinking += assistantEvent.delta;
          if (this.verboseLogging) {
            this.chronologicalOutput += assistantEvent.delta;
            return true;
          }
          return false;
        }

        if (assistantEvent.type === "thinking_start" && this.verboseLogging) {
          this.chronologicalOutput += "\n💭 *Reasoning:*\n";
          return true;
        }

        if (assistantEvent.type === "thinking_end" && this.verboseLogging) {
          this.chronologicalOutput += "\n\n";
          return true;
        }

        return false;
      }

      case "message_end": {
        if (event.message.role !== "assistant") {
          return false;
        }
        const assistantMessage = event.message;
        if (
          assistantMessage.stopReason === "error" &&
          assistantMessage.errorMessage?.trim()
        ) {
          this.fatalErrorMessage = assistantMessage.errorMessage.trim();
          return false;
        }
        // If text was already streamed via deltas, skip extraction
        if (this.hasStreamedText) {
          return false;
        }
        // Fallback: extract text from final message content
        let extracted = false;
        for (const block of assistantMessage.content) {
          if (block.type === "text" && block.text.trim()) {
            this.chronologicalOutput += block.text;
            extracted = true;
          }
        }
        return extracted;
      }

      case "tool_execution_start": {
        const params =
          event.args && typeof event.args === "object"
            ? (event.args as Record<string, unknown>)
            : {};
        const formatted = formatToolExecution(
          event.toolName,
          params,
          this.verboseLogging
        );
        if (formatted) {
          this.chronologicalOutput += `${formatted}\n`;
          return true;
        }
        return false;
      }

      case "auto_compaction_start": {
        this.chronologicalOutput += "🗜️ *Compacting context...*\n";
        return true;
      }

      case "auto_compaction_end": {
        if (event.aborted) {
          this.chronologicalOutput += "🗜️ *Compaction aborted*\n";
        } else if (event.result) {
          this.chronologicalOutput += "🗜️ *Context compacted*\n";
        }
        return true;
      }

      case "auto_retry_start": {
        this.chronologicalOutput += `🔄 *Retrying (attempt ${event.attempt}/${event.maxAttempts})...*\n`;
        return true;
      }

      case "auto_retry_end": {
        if (!event.success && event.finalError) {
          this.chronologicalOutput += `🔄 *Retry failed: ${event.finalError}*\n`;
          return true;
        }
        return false;
      }

      default:
        return false;
    }
  }

  /**
   * Get delta since last sent content.
   * Returns null if no new content.
   */
  getDelta(): string | null {
    const fullContent = this.chronologicalOutput.trim();

    if (!fullContent) {
      return null;
    }

    if (fullContent === this.lastSentContent) {
      return null;
    }

    if (this.lastSentContent && fullContent.startsWith(this.lastSentContent)) {
      const delta = fullContent.slice(this.lastSentContent.length);
      this.lastSentContent = fullContent;
      return delta;
    }

    this.lastSentContent = fullContent;
    return fullContent;
  }

  setFinalResult(result: { text: string; isFinal: boolean }): void {
    this.finalResult = result;
  }

  getFinalResult(): { text: string; isFinal: boolean } | null {
    const result = this.finalResult;
    this.finalResult = null;
    return result;
  }

  consumeFatalErrorMessage(): string | null {
    const result = this.fatalErrorMessage;
    this.fatalErrorMessage = null;
    return result;
  }

  getCurrentThinking(): string | null {
    return this.currentThinking || null;
  }

  getOutputSnapshot(): string {
    return this.chronologicalOutput.trim();
  }

  reset(): void {
    this.lastSentContent = "";
    this.chronologicalOutput = "";
    this.currentThinking = "";
    this.finalResult = null;
    this.hasStreamedText = false;
    this.fatalErrorMessage = null;
  }
}

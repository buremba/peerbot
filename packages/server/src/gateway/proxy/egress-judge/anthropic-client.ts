// gateway-llm-ok: pending migration to gateway-completion.ts. This judge fails
// closed, so changing its credential and transport path needs separate
// red→green coverage. See scripts/check-gateway-llm-calls.mjs.
import Anthropic from "@anthropic-ai/sdk";
import type { JudgeClient, JudgeVerdict } from "./types.js";
import { parseVerdict } from "./verdict-parser.js";

/**
 * Anthropic-backed judge transport. Calls the Messages API and parses the
 * strict JSON verdict. Any parse failure becomes a thrown error so the
 * caller can record it as a circuit-breaker failure.
 *
 * API key comes from `ANTHROPIC_API_KEY`. The judge is a gateway-level
 * dependency — it does NOT use any agent's own API key, to avoid leaking
 * agent context into audit logs or bills.
 */
export class AnthropicJudgeClient implements JudgeClient {
  private readonly client: Anthropic;
  private readonly timeoutMs: number;

  constructor(options?: { apiKey?: string; timeoutMs?: number }) {
    const apiKey = options?.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error(
        "Egress judge requires ANTHROPIC_API_KEY — set it in the gateway environment or pass apiKey explicitly"
      );
    }
    this.client = new Anthropic({ apiKey });
    this.timeoutMs = options?.timeoutMs ?? 5000;
  }

  async judge(args: {
    model: string;
    systemPrompt: string;
    userPrompt: string;
  }): Promise<JudgeVerdict> {
    const response = await this.client.messages.create(
      {
        model: args.model,
        max_tokens: 256,
        system: args.systemPrompt,
        messages: [{ role: "user", content: args.userPrompt }],
      },
      { timeout: this.timeoutMs }
    );

    const textBlock = response.content.find((block) => block.type === "text");
    if (!textBlock || textBlock.type !== "text" || !textBlock.text) {
      throw new Error("Judge response contained no text");
    }
    return parseVerdict(textBlock.text);
  }
}

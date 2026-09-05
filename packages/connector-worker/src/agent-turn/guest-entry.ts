/**
 * The agent-session GUEST. This module is bundled by `bundle.ts` with the
 * lane's own esbuild options and executed inside the isolate, so it must stay
 * portable: no `node:` import, no host module, nothing the guest prelude does
 * not provide.
 *
 * It runs one turn of pi's agent loop. The loop itself (`pi-agent-core`) has no
 * Node dependency; the provider call is pi-ai's fetch-native Anthropic or
 * OpenAI path, which reaches the network through the prelude's streaming
 * `fetch` and therefore through the host's one egress module.
 *
 * The turn never sees a real provider key. `provider.apiKey` is the gateway's
 * own `lobu_secret_` placeholder and `provider.baseUrl` is its agent-scoped
 * secret-proxy, so the swap happens at the gateway, where it already happens
 * for the subprocess lane.
 */

import { Agent } from '@mariozechner/pi-agent-core';
import { streamAnthropic } from '@mariozechner/pi-ai/anthropic';
import { streamOpenAICompletions } from '@mariozechner/pi-ai/openai-completions';
import type { AgentTurnEvent, AgentTurnInput, AgentTurnOutput } from './types.js';

/**
 * The model object pi-ai reads. The gateway resolves which model a turn runs,
 * not its price list or its window, so the fields pi only uses for bookkeeping
 * are zeroed rather than guessed. `cost` carries all FOUR keys: pi divides by
 * each one to price a turn, so a missing `cacheRead`/`cacheWrite` puts NaN in
 * the transcript entry the next turn resumes from.
 */
function buildModel(input: AgentTurnInput): Record<string, unknown> {
  return {
    id: input.provider.modelId,
    name: input.provider.modelId,
    api: input.provider.api,
    provider: input.provider.provider,
    baseUrl: input.provider.baseUrl,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    // Only read to decide when to compact, which this lane never does: one
    // turn, one request, and the gateway owns the history it sends.
    contextWindow: 200_000,
    maxTokens: input.provider.maxTokens ?? 8192,
    ...(input.provider.headers ? { headers: input.provider.headers } : {}),
  };
}

/**
 * Run one turn and resolve with the transcript it produced.
 *
 * `emit` is the host bridge: every call crosses into the worker while the
 * stream is still open, which is what makes a delta on this lane arrive at the
 * same point in the turn as a delta on the subprocess lane.
 */
export async function runAgentTurn(
  input: AgentTurnInput,
  emit: (event: AgentTurnEvent) => void
): Promise<AgentTurnOutput> {
  if (!input.provider.apiKey) throw new Error('the agent turn reached the guest with no provider credential');
  const model = buildModel(input);
  const stream = input.provider.api === 'anthropic-messages' ? streamAnthropic : streamOpenAICompletions;

  const agent = new Agent({
    initialState: {
      systemPrompt: input.systemPrompt,
      model: model as never,
      messages: input.messages as never,
    },
    // pi hands the loop's own options through; the key rides here rather than
    // in the model so it never lands in a transcript entry.
    streamFn: ((m: unknown, context: unknown, options: Record<string, unknown> | undefined) =>
      (stream as (a: unknown, b: unknown, c: unknown) => unknown)(m, context, {
        ...(options ?? {}),
        apiKey: input.provider.apiKey,
      })) as never,
  });

  let text = '';
  let stopReason: string | null = null;
  let usage: AgentTurnOutput['usage'] = null;
  // pi does not throw a failed provider call: it ends the turn with an
  // assistant message whose stopReason is 'error'. On this lane a failed turn
  // must be a failed RUN, or the job completes 'successfully' with no text.
  let failure: string | null = null;

  agent.subscribe((event) => {
    if (event.type === 'message_update') {
      const partial = event.assistantMessageEvent as { type?: string; delta?: string };
      if (partial.type === 'text_delta' && typeof partial.delta === 'string') {
        text += partial.delta;
        emit({ type: 'text_delta', delta: partial.delta });
      } else if (partial.type === 'thinking_delta' && typeof partial.delta === 'string') {
        emit({ type: 'thinking_delta', delta: partial.delta });
      }
      return;
    }
    if (event.type === 'message_end') {
      const message = event.message as unknown as {
        stopReason?: string;
        errorMessage?: string;
        usage?: { input?: number; output?: number };
      };
      if (typeof message.stopReason === 'string') stopReason = message.stopReason;
      if (typeof message.errorMessage === 'string' && message.errorMessage) failure = message.errorMessage;
      if (message.usage) usage = { input: message.usage.input ?? 0, output: message.usage.output ?? 0 };
      emit({ type: 'message_end' });
    }
  });

  await agent.prompt(input.userMessage);
  await agent.waitForIdle();

  const stateError = (agent.state as { errorMessage?: string }).errorMessage;
  const ended = failure ?? (typeof stateError === 'string' && stateError ? stateError : null);
  if (ended) throw new Error(ended);

  return {
    text,
    stopReason,
    usage,
    messages: agent.state.messages as unknown as AgentTurnOutput['messages'],
  };
}

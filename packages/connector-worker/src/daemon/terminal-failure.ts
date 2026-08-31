import type { PollResponse, ExecutorClient } from './client.js';

const TERMINAL_DELIVERY_DEADLINE_MS = 15_000;

async function completeActionWithBoundedRetry(
  client: ExecutorClient,
  payload: Parameters<ExecutorClient['completeAction']>[0],
): Promise<void> {
  const deadline = Date.now() + TERMINAL_DELIVERY_DEADLINE_MS;
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const budget = Math.max(1, Math.floor(remaining / (2 - attempt)));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        client.completeAction(payload),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('terminal completion deadline exceeded')), budget);
          timer.unref?.();
        }),
      ]);
      return;
    } catch (error) {
      lastError = error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function reportTerminalFailure(
  client: ExecutorClient,
  job: PollResponse,
  message: string,
  exitReason: 'error_message' | 'crash' = 'crash',
): Promise<void> {
  if (job.run_id == null) return;
  if (job.run_type === 'action') {
    await completeActionWithBoundedRetry(client, {
      run_id: job.run_id,
      worker_id: client.id,
      status: 'failed',
      error_message: message,
    });
    return;
  }
  if (job.run_type === 'auth') {
    await client.completeAuth({
      run_id: job.run_id,
      worker_id: client.id,
      status: 'failed',
      error_message: message,
    });
    return;
  }
  if (job.run_type === 'chat_message') {
    // Device chat completes through its adapter so the waiting Activity turn
    // receives a thread_response. Generic sync completion would finalize the
    // row without publishing that response.
    await client.completeDeviceChat(job.run_id, {
      worker_id: client.id,
      error: message,
      exit_reason: exitReason,
    });
    return;
  }
  if (job.run_type === 'automation') {
    await client.completeAutomation(job.run_id, {
      worker_id: client.id,
      output: '',
      error: message,
      duration_ms: 0,
      exit_reason: exitReason,
    });
    return;
  }
  await client.complete({
    run_id: job.run_id,
    worker_id: client.id,
    status: 'failed',
    error_message: message,
    items_collected: 0,
  });
}

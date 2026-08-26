import type { PollResponse, ExecutorClient } from './client.js';

export async function reportTerminalFailure(
  client: ExecutorClient,
  job: PollResponse,
  message: string,
  exitReason: 'error_message' | 'crash' = 'crash',
): Promise<void> {
  if (job.run_id == null) return;
  if (job.run_type === 'action') {
    await client.completeAction({
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

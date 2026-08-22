import type { ContentItem, PollResponse, StreamBatch } from '../client.js';
import type { WorkerClient } from '../client.js';
import { log } from '../log.js';
import { NativeBridgeClient, type NativeBridgeRunResult } from './client.js';

const VIRTUAL_FEED_ACTION = '__lobu_virtual_feed_read';

export async function executeNativeBridgeRun(
  client: WorkerClient,
  bridge: NativeBridgeClient,
  job: PollResponse,
): Promise<{ itemsCollected: number; error?: string }> {
  if (!job.run_id) throw new Error('native bridge run is missing run_id');

  const runId = job.run_id;
  const operation = nativeOperation(job);
  let itemsCollected = 0;
  let checkpoint = asRecord(job.checkpoint);
  let terminalAttempted = false;

  const completeSync = async (result: NativeBridgeRunResult, errorMessage?: string) => {
    if (terminalAttempted) return;
    terminalAttempted = true;
    await client.complete({
      run_id: runId,
      worker_id: client.id,
      status: errorMessage ? 'failed' : 'success',
      items_collected: itemsCollected,
      ...(!errorMessage && checkpoint ? { checkpoint } : {}),
      ...(result.auth_update ? { auth_update: result.auth_update } : {}),
      ...(errorMessage ? { error_message: errorMessage } : {}),
    });
  };
  const completeAction = async (result: NativeBridgeRunResult, errorMessage?: string) => {
    if (terminalAttempted) return;
    terminalAttempted = true;
    const output = result.action_output ?? {};
    await client.completeAction({
      run_id: runId,
      worker_id: client.id,
      status: errorMessage ? 'failed' : 'success',
      ...(errorMessage ? { error_message: errorMessage } : { action_output: output }),
    });
  };
  const completeAuth = async (result: NativeBridgeRunResult, errorMessage?: string) => {
    if (terminalAttempted) return;
    terminalAttempted = true;
    await client.completeAuth({
      run_id: runId,
      worker_id: client.id,
      status: errorMessage ? 'failed' : 'success',
      ...(result.credentials ? { credentials: result.credentials } : {}),
      ...(result.metadata ? { metadata: result.metadata } : {}),
      ...(errorMessage ? { error_message: errorMessage } : {}),
    });
  };

  try {
    const result = await bridge.run({
      operation: operation === 'query' || operation === 'search' ? operation : 'run',
      job: bridgeJob(job),
      onStream:
        operation === 'sync'
          ? async (payload) => {
              const items = readItems(payload.items);
              const nextCheckpoint = asRecord(payload.checkpoint);
              if (items.length === 0 && !nextCheckpoint) return;
              const batch: StreamBatch = {
                type: 'batch',
                run_id: runId,
                worker_id: client.id,
                items,
                ...(nextCheckpoint ?? checkpoint
                  ? { checkpoint: nextCheckpoint ?? checkpoint }
                  : {}),
              };
              await client.stream(batch);
              if (nextCheckpoint) checkpoint = nextCheckpoint;
              itemsCollected += items.length;
            }
          : undefined,
    });

    if (result.checkpoint) checkpoint = result.checkpoint;
    if (operation === 'sync') await completeSync(result);
    else if (operation === 'auth') await completeAuth(result);
    else await completeAction(result);
    return { itemsCollected };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.info(`[native-bridge] Run ${runId} failed:`, message);
    try {
      if (operation === 'sync') await completeSync({}, message);
      else if (operation === 'auth') await completeAuth({}, message);
      else await completeAction({}, message);
    } catch (completionError) {
      log.info(`[native-bridge] Terminal report for run ${runId} failed:`, completionError);
    }
    return { itemsCollected, error: message };
  }
}

function nativeOperation(job: PollResponse): 'sync' | 'action' | 'query' | 'search' | 'auth' {
  if (job.run_type === 'sync') return 'sync';
  if (job.run_type === 'auth') return 'auth';
  if (job.action_key === VIRTUAL_FEED_ACTION) {
    const input = asRecord(job.action_input);
    return Array.isArray(input?.terms) && input.terms.some((term) => typeof term === 'string' && term.trim())
      ? 'search'
      : 'query';
  }
  return 'action';
}

function bridgeJob(job: PollResponse): Record<string, unknown> {
  const input = job.action_input ?? {};
  return {
    run_id: job.run_id,
    run_type: job.run_type,
    connector_key: job.connector_key,
    connector_version: job.connector_version,
    connector_manifest_hash: job.connector_manifest_hash,
    feed_key: job.feed_key,
    feed_id: job.feed_id,
    config: job.config ?? {},
    checkpoint: job.checkpoint,
    entity_ids: job.entity_ids,
    action_key: job.action_key,
    operation_key: job.operation_key,
    action_input: input,
  };
}

function readItems(value: unknown): ContentItem[] {
  if (!Array.isArray(value)) throw new Error('native bridge stream payload is missing items');
  return value.map((item, index) => {
    if (!isRecord(item) || typeof item.id !== 'string' || typeof item.payload_text !== 'string' || typeof item.occurred_at !== 'string') {
      throw new Error(`native bridge stream item ${index} is malformed`);
    }
    return item as ContentItem;
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

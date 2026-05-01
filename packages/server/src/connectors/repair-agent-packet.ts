/**
 * Diagnostic packet builders for connector repair threads.
 *
 * The packet is plain text; the agent reads it as a regular user message.
 * No new schema is invented here — all fields come from existing run/feed
 * rows. `output_tail` is already redacted by the worker before it reaches
 * the backend (see PR 1's diagnostic substrate); the builder MUST NOT
 * source raw values from anywhere else.
 */

export interface DiagnosticRunRow {
  id: number;
  status: string;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  errorMessage: string | null;
  exitReason: string | null;
  exitCode: number | null;
  exitSignal: string | null;
  outputTail: string | null;
}

export interface OpenPacketInput {
  feedId: number;
  feedDisplayName: string | null;
  connectorKey: string | null;
  connectorName: string | null;
  connectorVersion: string | null;
  feedConfig: Record<string, unknown> | null;
  feedSchedule: string | null;
  consecutiveFailures: number;
  firstFailureAt: string | null;
  connectionId: number | null;
  connectionDisplayName: string | null;
  authProfileStatus: string | null;
  recentRuns: DiagnosticRunRow[];
}

function fmtRun(run: DiagnosticRunRow): string {
  const lines: string[] = [];
  lines.push(`- id: ${run.id}`);
  lines.push(`  status: ${run.status}`);
  if (run.startedAt) lines.push(`  started_at: ${run.startedAt}`);
  if (run.completedAt) lines.push(`  completed_at: ${run.completedAt}`);
  if (run.durationMs != null) lines.push(`  duration_ms: ${run.durationMs}`);
  if (run.errorMessage) lines.push(`  error_message: ${run.errorMessage}`);
  if (run.exitReason) lines.push(`  exit_reason: ${run.exitReason}`);
  if (run.exitCode != null) lines.push(`  exit_code: ${run.exitCode}`);
  if (run.exitSignal) lines.push(`  exit_signal: ${run.exitSignal}`);
  if (run.outputTail) {
    lines.push('  output_tail: |');
    for (const tailLine of run.outputTail.split('\n')) {
      lines.push(`    ${tailLine}`);
    }
  }
  return lines.join('\n');
}

export function buildOpenPacket(input: OpenPacketInput): string {
  const connectorLabel = input.connectorName || input.connectorKey || 'unknown';
  const feedLabel = input.feedDisplayName || `feed#${input.feedId}`;

  const sections: string[] = [];
  sections.push(`Title: Connector feed repair — ${connectorLabel} / ${feedLabel}`);
  sections.push('');
  sections.push(
    'A connector feed sync has been failing repeatedly. Diagnose the cause and, if you can, fix it.'
  );
  sections.push('');

  const feedLines: string[] = [];
  feedLines.push('Feed');
  feedLines.push(`- id: ${input.feedId}`);
  if (input.connectorKey) feedLines.push(`- connector_key: ${input.connectorKey}`);
  if (input.connectorVersion) feedLines.push(`- connector_version: ${input.connectorVersion}`);
  feedLines.push(`- config: ${input.feedConfig ? JSON.stringify(input.feedConfig) : 'null'}`);
  feedLines.push(`- schedule: ${input.feedSchedule ?? 'null'}`);
  feedLines.push(`- consecutive_failures: ${input.consecutiveFailures}`);
  feedLines.push(`- first_failure_at: ${input.firstFailureAt ?? 'null'}`);
  sections.push(feedLines.join('\n'));
  sections.push('');

  if (input.connectionId != null) {
    const connLines: string[] = [];
    connLines.push('Connection');
    connLines.push(`- id: ${input.connectionId}`);
    if (input.connectionDisplayName)
      connLines.push(`- display_name: ${input.connectionDisplayName}`);
    if (input.authProfileStatus)
      connLines.push(`- auth_profile_status: ${input.authProfileStatus}`);
    sections.push(connLines.join('\n'));
    sections.push('');
  }

  sections.push(`Recent runs (most recent first, up to ${input.recentRuns.length}):`);
  for (const run of input.recentRuns) sections.push(fmtRun(run));
  sections.push('');

  const cdLines: string[] = [];
  cdLines.push('Connector definition');
  cdLines.push(`- name: ${input.connectorName ?? 'unknown'}`);
  cdLines.push(`- version: ${input.connectorVersion ?? 'unknown'}`);
  cdLines.push(
    '- source: fetch via the connector-source MCP tool when needed (not inlined here)'
  );
  sections.push(cdLines.join('\n'));
  sections.push('');

  sections.push(
    'You have access to the manage_feeds, manage_connections, manage_operations, query_sql, and connector-source CRUD tools. Investigate the cause; if it is in the connector code, propose or apply a fix per the org\'s policy. If you make any change, run a single test sync after to verify.'
  );

  return sections.join('\n');
}

export function buildAppendPacket(input: {
  consecutiveFailures: number;
  run: DiagnosticRunRow;
}): string {
  return [
    `Still failing — ${input.consecutiveFailures} consecutive failures, latest run below.`,
    '',
    fmtRun(input.run),
  ].join('\n');
}

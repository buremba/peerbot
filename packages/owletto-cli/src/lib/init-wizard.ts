/**
 * Shared init wizard logic — detect agents, authenticate, configure.
 */

import { spawnSync } from 'node:child_process';
import * as p from '@clack/prompts';
import { type DetectedAgent, detectAgents } from './agent-detect.ts';
import { getInstallTarget, INSTALL_TARGETS } from './install-targets.ts';
import { getUsableToken } from './openclaw-auth.ts';

export function isLocalUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  } catch {
    return false;
  }
}

export async function healthPing(url: string, timeoutMs = 5000): Promise<boolean> {
  try {
    const healthUrl = url.replace(/\/mcp\/?$/, '/health');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(healthUrl, { signal: controller.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

export async function authenticate(mcpUrl: string, skipAuth: boolean): Promise<void> {
  if (skipAuth) {
    p.log.info('Skipping authentication (--skip-auth)');
    return;
  }

  const existing = await getUsableToken(mcpUrl);
  if (existing) {
    const org = existing.session.org;
    p.log.success(`Already logged in${org ? ` — workspace: ${org}` : ''}`);

    const reuse = await p.confirm({ message: 'Continue with this session?' });
    if (p.isCancel(reuse)) {
      p.cancel('Cancelled.');
      process.exit(0);
    }
    if (reuse) return;
  }

  p.log.info('Logging in to Owletto...');

  const loginResult = spawnSync(process.execPath, [process.argv[1], 'login', mcpUrl], {
    stdio: 'inherit',
    timeout: 300_000,
  });

  if (loginResult.status !== 0) {
    p.log.error(`Login failed. You can retry with: owletto login ${mcpUrl}`);
    const cont = await p.confirm({ message: 'Continue without authentication?' });
    if (p.isCancel(cont) || !cont) {
      p.cancel('Cancelled.');
      process.exit(0);
    }
  }
}

function formatDetectionLine(agent: DetectedAgent): string {
  const target = getInstallTarget(agent.id);
  if (target?.mode === 'manual') return `${agent.name} (web/manual setup)`;
  if (target?.mode === 'handoff') return `${agent.name} (browser handoff)`;
  if (agent.kind === 'manual') return `${agent.name} (manual setup)`;
  if (agent.detected) return `${agent.name} — ${agent.path}`;
  return `${agent.name} — not found`;
}

export async function selectAgents(agentFlag?: string): Promise<string[]> {
  if (agentFlag) {
    const target = getInstallTarget(agentFlag);
    if (!target) {
      p.log.error(
        `Unknown agent: ${agentFlag}. Available: ${INSTALL_TARGETS.map((t) => t.id).join(', ')}`
      );
      process.exit(1);
    }
    return [agentFlag];
  }

  const s = p.spinner();
  s.start('Scanning for installed agents...');
  const agents = detectAgents();
  s.stop('Agent detection complete');

  for (const agent of agents) {
    if (agent.kind === 'manual') {
      p.log.info(`  ${agent.name} — manual setup`);
    } else if (agent.detected) {
      p.log.success(`  ${agent.name} — ${agent.path}`);
    } else {
      p.log.warning(`  ${agent.name} — not found`);
    }
  }

  const options = agents.map((agent) => ({
    value: agent.id,
    label: formatDetectionLine(agent),
    hint:
      getInstallTarget(agent.id)?.mode === 'manual'
        ? 'will show settings steps'
        : getInstallTarget(agent.id)?.mode === 'handoff'
          ? 'will open a handoff flow'
          : undefined,
  }));

  const initialValues = agents.filter((a) => a.detected).map((a) => a.id);

  const selected = await p.multiselect({
    message: 'Which agents do you want to configure?',
    options,
    initialValues,
    required: false,
  });

  if (p.isCancel(selected)) {
    p.cancel('Cancelled.');
    process.exit(0);
  }

  return selected as string[];
}

export async function configureAgents(selectedIds: string[], mcpUrl: string): Promise<void> {
  if (selectedIds.length === 0) {
    p.log.info('No agents selected.');
    return;
  }

  const isLocal = isLocalUrl(mcpUrl);
  const manualInstructions: string[] = [];
  let configuredCount = 0;
  let handoffCount = 0;
  let manualCount = 0;
  let failCount = 0;

  for (const id of selectedIds) {
    const target = getInstallTarget(id);
    if (!target) continue;

    if (isLocal && (id === 'openclaw' || id === 'codex')) {
      p.log.warning(
        `  ${target.name} may run on a remote server where ${mcpUrl} isn't reachable.\n` +
          '  Consider using a tunnel (ngrok, Tailscale) or a public URL.'
      );
    }

    const s = p.spinner();
    s.start(`Configuring ${target.name}...`);

    const result = await target.configure(mcpUrl);

    if (result.status === 'configured') {
      s.stop(`${target.name} — ${result.message}`);
      configuredCount++;
    } else if (result.status === 'handoff') {
      s.stop(`${target.name} — ${result.message}`);
      handoffCount++;
    } else if (result.status === 'manual') {
      s.stop(`${target.name} — ${result.message}`);
      manualCount++;
    } else {
      s.stop(`${target.name} — failed: ${result.message}`);
      failCount++;
    }

    if (target.manualInstructions) {
      manualInstructions.push(`${target.name}:\n${target.manualInstructions(mcpUrl)}`);
    }
  }

  if (manualInstructions.length > 0) {
    p.note(manualInstructions.join('\n\n'), 'Manual setup needed');
  }

  const parts: string[] = [];
  if (configuredCount > 0) parts.push(`${configuredCount} configured`);
  if (handoffCount > 0) parts.push(`${handoffCount} handed off`);
  if (manualCount > 0) parts.push(`${manualCount} require web/manual setup`);
  if (failCount > 0) parts.push(`${failCount} failed`);
  p.log.info(parts.join(', '));
}

/**
 * Run the full init flow: auth → detect → configure.
 */
export async function runInitWizard(mcpUrl: string, opts?: { skipAuth?: boolean; agent?: string }) {
  if (isLocalUrl(mcpUrl)) {
    p.note(
      'Local URLs (localhost/127.0.0.1) are only reachable from this machine.\n' +
        "Agents running on remote servers won't be able to connect.\n" +
        'Use a tunnel (ngrok, Tailscale) or a public URL if your agents run remotely.',
      'Local network only'
    );
  }

  await authenticate(mcpUrl, !!opts?.skipAuth);
  const selectedIds = await selectAgents(opts?.agent);
  await configureAgents(selectedIds, mcpUrl);
}

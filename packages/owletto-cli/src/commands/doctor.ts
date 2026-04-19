import { execFileSync } from 'node:child_process';
import { defineCommand } from 'citty';
import { getActiveSession } from '../lib/openclaw-auth.ts';
import { isJson, printJson, printText } from '../lib/output.ts';

interface Check {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
}

function checkBinaryExists(name: string): Check {
  try {
    const path = execFileSync('which', [name], { encoding: 'utf-8' }).trim();
    return { name, status: 'ok', detail: path };
  } catch {
    return { name, status: 'fail', detail: 'not found' };
  }
}

function checkNodeVersion(): Check {
  const version = process.version;
  const major = parseInt(version.slice(1), 10);
  return {
    name: 'node',
    status: major >= 20 ? 'ok' : 'warn',
    detail: version,
  };
}

async function checkUrl(name: string, url: string): Promise<Check> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    return { name, status: res.ok ? 'ok' : 'warn', detail: `${res.status} ${url}` };
  } catch (_err) {
    return { name, status: 'fail', detail: `unreachable: ${url}` };
  }
}

export default defineCommand({
  meta: {
    name: 'doctor',
    description: 'Check system health and dependencies',
  },
  async run() {
    const checks: Check[] = [];

    checks.push(checkNodeVersion());
    for (const bin of ['docker']) {
      checks.push(checkBinaryExists(bin));
    }

    // Check active server connectivity
    const { session } = getActiveSession();
    if (session?.mcpUrl) {
      const origin = new URL(session.mcpUrl).origin;
      checks.push(await checkUrl('server', origin));
    }

    if (isJson()) {
      printJson({ checks });
    } else {
      const icons = { ok: '+', warn: '!', fail: 'x' } as const;
      for (const c of checks) {
        printText(`  ${icons[c.status]} ${c.name}: ${c.detail}`);
      }
      const fails = checks.filter((c) => c.status === 'fail');
      if (fails.length > 0) {
        printText(`\n${fails.length} issue(s) found.`);
        process.exitCode = 1;
      } else {
        printText('\nAll checks passed.');
      }
    }
  },
});

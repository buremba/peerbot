import * as p from '@clack/prompts';
import { defineCommand } from 'citty';
import { healthPing, runInitWizard } from '../lib/init-wizard.ts';
import { normalizeMcpUrl } from '../lib/openclaw-auth.ts';

const CLOUD_MCP_URL = 'https://owletto.com/mcp';

async function chooseMcpUrl(urlFlag?: string): Promise<string> {
  if (urlFlag) return normalizeMcpUrl(urlFlag);

  const mode = await p.select({
    message: 'Which Owletto MCP endpoint should your agents use?',
    options: [
      { value: 'cloud', label: 'Owletto Cloud', hint: 'https://owletto.com/mcp' },
      { value: 'local', label: 'Local runtime', hint: 'http://localhost:8787/mcp' },
      { value: 'custom', label: 'Custom MCP URL', hint: 'enter URL' },
    ],
  });

  if (p.isCancel(mode)) {
    p.cancel('Cancelled.');
    process.exit(0);
  }

  if (mode === 'cloud') return CLOUD_MCP_URL;
  if (mode === 'local') return normalizeMcpUrl('http://localhost:8787');

  const url = await p.text({
    message: 'Enter your Owletto MCP URL:',
    placeholder: 'https://your-server.com/mcp',
    validate(value) {
      if (!value) return 'URL is required';
      try {
        new URL(value);
        return undefined;
      } catch {
        return 'Please enter a valid URL';
      }
    },
  });

  if (p.isCancel(url)) {
    p.cancel('Cancelled.');
    process.exit(0);
  }

  const s = p.spinner();
  s.start('Checking MCP endpoint...');
  const ok = await healthPing(url);
  s.stop(ok ? 'Endpoint is reachable' : 'Endpoint did not respond — continuing anyway');

  return normalizeMcpUrl(url);
}

export default defineCommand({
  meta: {
    name: 'init',
    description: 'Configure agents to use an Owletto MCP endpoint',
  },
  args: {
    url: { type: 'string', description: 'MCP server URL (skips prompt)' },
    agent: { type: 'string', description: 'Configure a specific agent only' },
    skipAuth: { type: 'boolean', description: 'Skip authentication step' },
  },
  async run({ args }) {
    p.intro('Owletto');
    p.log.info(
      'Choose the Owletto MCP endpoint your agents should use. If you want the local runtime, start it first with `owletto start`.'
    );

    const mcpUrl = await chooseMcpUrl(args.url);
    await runInitWizard(mcpUrl, { skipAuth: args.skipAuth, agent: args.agent });

    p.outro('Done');
  },
});

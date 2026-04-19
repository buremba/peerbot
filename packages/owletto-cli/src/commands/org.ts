import { defineCommand } from 'citty';
import { getActiveSession, resolveOrg, setActiveOrg } from '../lib/openclaw-auth.ts';
import { isJson, printJson, printText } from '../lib/output.ts';

function showCurrentOrg(storePath?: string) {
  const { session, key } = getActiveSession(storePath);

  if (!session || !key) {
    if (isJson()) {
      printJson({ org: null });
    } else {
      printText('No active session. Run: owletto login');
    }
    return;
  }

  const org = resolveOrg(undefined, session);

  if (isJson()) {
    printJson({ org: org || null, server: key });
  } else {
    printText(`org: ${org || '(none)'}`);
    printText(`server: ${key}`);
  }
}

const current = defineCommand({
  meta: { name: 'current', description: 'Show the current organization' },
  args: {
    storePath: { type: 'string', description: 'Custom auth store path' },
  },
  run({ args }) {
    showCurrentOrg(args.storePath);
  },
});

const set = defineCommand({
  meta: { name: 'set', description: 'Set the default organization' },
  args: {
    orgSlug: {
      type: 'positional',
      description: 'Organization slug to set as default',
      required: true,
    },
    storePath: { type: 'string', description: 'Custom auth store path' },
  },
  run({ args }) {
    setActiveOrg(args.orgSlug, args.storePath);

    if (isJson()) {
      printJson({ org: args.orgSlug });
    } else {
      printText(`Default org: ${args.orgSlug}`);
    }
  },
});

export default defineCommand({
  meta: {
    name: 'org',
    description: 'Manage organization selection',
  },
  subCommands: { current, set },
});

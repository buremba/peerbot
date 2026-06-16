/**
 * Property/fuzz guard for the MCP tool surface: no tool may surface an
 * UNHANDLED error (Postgres syntax error, TypeError, raw 500) on adversarial
 * input. A tool may reject bad input gracefully (ToolUserError) or succeed — but
 * a leaked engine error is a bug.
 *
 * Motivation: a `read_knowledge` query with a leading newline used to throw a
 * Postgres `syntax error in tsquery` (a 400 leaking the engine). That class —
 * "adversarial input crashes a tool" — should be caught for the WHOLE surface,
 * not one tool at a time. This harness drives each free-text tool with a shared
 * corpus of nasty values and asserts the only errors are typed user errors.
 *
 * `search_memory` has its own dedicated 1440-combo fuzz; this covers the rest.
 * To guard a new tool, add a spec to TOOL_SPECS.
 *
 * Harness: vitest + embedded Postgres. Handlers are called directly.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../../../index';
import type { ToolContext } from '../../../tools/registry';
import { saveContent } from '../../../tools/save_content';
import { resolvePath } from '../../../tools/resolve_path';
import { ToolUserError } from '../../../utils/errors';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestEntity,
  createTestOrganization,
  createTestUser,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';

// Schema-valid but adversarial string values (all pass `type: string`, so they
// reach handler/SQL logic rather than bouncing off validation).
const NASTY: Array<[string, string]> = [
  ['leading newline', '\nhello world'],
  ['leading tab', '\thello'],
  ['embedded newlines', 'a\n\nb\nc'],
  ['crlf', 'a\r\nb'],
  ['only whitespace', '\n\t  \r\n'],
  ['tsquery operators', 'foo & bar | baz ! qux : * ( )'],
  ['leading pipe', '| foo'],
  ['unbalanced paren', '(unclosed'],
  ['wildcard', 'pre*fix:*'],
  ['phrase op', 'a <-> b <2> c'],
  ['unicode + emoji', '🎉 日本語 café ümlaut'],
  ['quotes/apostrophe', `O'Brien said "hi"`],
  ['sql-ish', `'; DROP TABLE events; --`],
  ['percent/underscore (ILIKE)', '100%_done_\\'],
  ['only punctuation', '!@#$%^&*()_+-=[]{}|;:,.<>?'],
  ['only stopwords', 'the and of to is a an'],
  ['numbers only', '1234567890'],
  ['empty', ''],
  ['oversized', 'x '.repeat(4000)],
  ['null byte-ish', 'a\u0000b'],
];

interface ToolSpec {
  name: string;
  // Build a full args object given the adversarial value (fill required fields).
  args: (nasty: string) => unknown;
  call: (args: unknown, env: Env, ctx: ToolContext) => Promise<unknown>;
}

describe('MCP tool surface > input fuzz: no tool leaks an engine error', () => {
  let org: Awaited<ReturnType<typeof createTestOrganization>>;
  let entityId: number;
  const env = { ENVIRONMENT: 'test' } as Env;

  function ctx(): ToolContext {
    return {
      organizationId: org.id,
      userId: 'fuzz-user',
      memberRole: 'owner',
      isAuthenticated: true,
      tokenType: 'oauth',
      scopedToOrg: false,
      allowCrossOrg: true,
      scopes: ['mcp:read', 'mcp:write'],
    };
  }

  let TOOL_SPECS: ToolSpec[];

  beforeAll(async () => {
    await initWorkspaceProvider();
    await cleanupTestDatabase();
    await seedSystemEntityTypes();
    org = await createTestOrganization({ name: 'Tool Fuzz Org' });
    const user = await createTestUser({ email: 'tool-fuzz@example.com' });
    await addUserToOrganization(user.id, org.id, 'owner');
    entityId = (await createTestEntity({ name: 'Fuzz Entity', organization_id: org.id })).id;

    TOOL_SPECS = [
      {
        name: 'save_memory',
        args: (nasty) => ({
          entity_ids: [entityId],
          content: nasty,
          title: nasty.slice(0, 50),
          author: nasty.slice(0, 20),
          semantic_type: 'note',
          metadata: {},
        }),
        call: (a, e, c) => saveContent(a as never, e as never, c as never),
      },
      {
        name: 'resolve_path',
        args: (nasty) => ({ path: `/${nasty}` || '/x' }),
        call: (a, e, c) => resolvePath(a as never, e as never, c as never),
      },
    ];
  });

  it('every tool either succeeds or throws a typed ToolUserError (never a raw engine error)', async () => {
    const leaks: Array<{ tool: string; label: string; error: string }> = [];
    let ran = 0;
    for (const spec of TOOL_SPECS) {
      for (const [label, nasty] of NASTY) {
        try {
          await spec.call(spec.args(nasty), env, ctx());
          ran++;
        } catch (e) {
          // A graceful, typed user-facing rejection is acceptable.
          if (e instanceof ToolUserError) {
            ran++;
            continue;
          }
          leaks.push({ tool: spec.name, label, error: String(e).slice(0, 160) });
        }
      }
    }
    if (leaks.length > 0) {
      throw new Error(
        `${leaks.length} tool/input combinations leaked an engine error:\n` +
          leaks.map((l) => `  ${l.tool} [${l.label}] -> ${l.error}`).join('\n')
      );
    }
    expect(ran).toBe(TOOL_SPECS.length * NASTY.length);
  });
});

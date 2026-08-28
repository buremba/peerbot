import { describe, expect, it } from 'bun:test';
import type { Env } from '../../index';
import { resolvePath } from '../../tools/resolve_path';
import type { ToolContext } from '../../tools/registry';

const context = {
  organizationId: 'org-fast-reject',
  userId: 'user-fast-reject',
  memberRole: 'owner',
  tokenType: 'oauth',
} as ToolContext;

describe('resolve_path user namespace rejection', () => {
  it('rejects existing-looking and unknown users uniformly before provider lookup', async () => {
    for (const path of ['/@known-user', '/@unknown-user']) {
      try {
        await resolvePath({ path }, {} as Env, context);
        throw new Error('expected resolve_path to reject');
      } catch (error) {
        expect(error).toMatchObject({
          message: 'Workspace is not available for this authorization',
          httpStatus: 404,
        });
      }
    }
  });
});

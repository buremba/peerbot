import { describe, expect, it } from 'bun:test';
import { handleSubmitFeedback } from '../../tools/admin/manage_automations/feedback';
import type { ToolContext } from '../../tools/registry';
import { parsePositiveIntegerId } from '../../utils/errors';

describe('Automation tool input validation', () => {
  it('accepts only positive safe-integer ID strings with a 400 client error', () => {
    expect(parsePositiveIntegerId('71', 'automation_id')).toBe(71);

    for (const value of ['71)', '0', '-1', '1.5', '9007199254740992']) {
      let thrown: unknown;
      try {
        parsePositiveIntegerId(value, 'automation_id');
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toMatchObject({
        name: 'ToolUserError',
        httpStatus: 400,
        message: 'automation_id must be a positive integer',
      });
    }
  });

  it('rejects non-object correction entries before property access', async () => {
    const ctx = {
      organizationId: 'org-1',
      userId: 'user-1',
      isAuthenticated: true,
    } as ToolContext;

    await expect(
      handleSubmitFeedback(
        {
          action: 'submit_feedback',
          automation_id: '71',
          run_id: 1,
          corrections: [null],
        } as never,
        ctx
      )
    ).rejects.toMatchObject({
      name: 'ToolUserError',
      httpStatus: 400,
      message: 'each correction must be an object with a string field_path',
    });
  });
});

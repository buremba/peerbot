/**
 * Gap 2: a personal OAuth connection is created successfully and is then
 * SILENTLY unreachable to agents owned by someone else.
 *
 * Chat runs resolve connections as the AGENT OWNER
 * (`workspace/multi-tenant.ts` → `owner_user_id FROM agents`), while a private
 * connection is visible only via `created_by = principal`
 * (`authz/connection-visibility.ts`). A personal credential is FORCED private,
 * so a DM user's own Gmail yields a healthy-looking row whose runtime lookup
 * returns ZERO ROWS rather than an error.
 *
 * Forcing `private` is correct and unchanged; this only makes it legible.
 */

import { describe, expect, it } from 'vitest';
import { personalConnectionScopeWarning } from '../connection-helpers';

describe('personalConnectionScopeWarning', () => {
  it('explains which agents can use a private personal connection', () => {
    const warning = personalConnectionScopeWarning({
      visibility: 'private',
      profileKind: 'oauth_account',
    });

    // Must name the actual MECHANISM, not just say "private" — the whole point
    // is that the user cannot otherwise tell why the agent ignored it.
    expect(warning).toContain('AGENT OWNER');
    expect(warning).toContain('not the person who sent the message');
    expect(warning).toContain('does not exist');
  });

  it('stays silent for an org-visible connection', () => {
    expect(
      personalConnectionScopeWarning({
        visibility: 'org',
        profileKind: 'oauth_account',
      })
    ).toBeUndefined();
  });

  it('stays silent for non-personal credential kinds', () => {
    for (const kind of ['oauth_app', 'service_account', 'env', null]) {
      expect(
        personalConnectionScopeWarning({
          visibility: 'private',
          profileKind: kind,
        })
      ).toBeUndefined();
    }
  });
});

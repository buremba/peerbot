import { describe, expect, it } from 'bun:test';
import { stripMemberEmailsFromRows } from '../../utils/member-redaction';

describe('stripMemberEmailsFromRows ($member traversal redaction)', () => {
  it('strips emailField from $member rows surfaced via template data', () => {
    const input = {
      members: [
        {
          entity_type: '$member',
          name: 'Alice',
          metadata: { email: 'alice@example.com', role: 'member' },
        },
        {
          entity_type: '$member',
          name: 'Bob',
          metadata: { email: 'bob@example.com', role: 'admin' },
        },
      ],
    };
    const out = stripMemberEmailsFromRows(input, 'email');
    expect(out).not.toBeNull();
    const rows = out!.members as Array<{ metadata: Record<string, unknown> }>;
    expect(rows[0]!.metadata).toEqual({ role: 'member' });
    expect(rows[1]!.metadata).toEqual({ role: 'admin' });
  });

  it('also strips top-level email columns (e.g. SELECT metadata->> email AS email)', () => {
    const input = {
      members: [
        {
          entity_type: '$member',
          name: 'Alice',
          email: 'alice@example.com',
        },
      ],
    };
    const out = stripMemberEmailsFromRows(input, 'email');
    const rows = out!.members as Array<Record<string, unknown>>;
    expect('email' in rows[0]!).toBe(false);
    expect(rows[0]!.name).toBe('Alice');
  });

  it('leaves non-member rows untouched', () => {
    const input = {
      companies: [
        {
          entity_type: 'company',
          name: 'Acme',
          metadata: { email: 'hello@acme.example', website: 'acme.example' },
        },
      ],
    };
    const out = stripMemberEmailsFromRows(input, 'email');
    expect(out!.companies).toEqual(input.companies);
  });

  it('passes through nullish or malformed rows', () => {
    expect(stripMemberEmailsFromRows(null, 'email')).toBeNull();
    const out = stripMemberEmailsFromRows(
      { mixed: [null, 'string', 42, { entity_type: '$member', metadata: {} }] },
      'email'
    );
    expect(out!.mixed).toEqual([
      null,
      'string',
      42,
      { entity_type: '$member', metadata: {} },
    ]);
  });

  it('no-ops when emailField is empty', () => {
    const input = {
      members: [
        { entity_type: '$member', metadata: { email: 'a@b' } },
      ],
    };
    const out = stripMemberEmailsFromRows(input, '');
    expect(out).toEqual(input);
  });
});

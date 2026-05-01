import type { EntityLinkRule } from '@lobu/connector-sdk';
import { describe, expect, it } from 'vitest';
import { resolveEntityLinkRules, validateEntityLinkOverrides } from '../entity-link-validation';

const baseRule: EntityLinkRule = {
  entityType: '$member',
  autoCreate: true,
  identities: [
    { namespace: 'phone', eventPath: 'metadata.phone' },
    { namespace: 'email', eventPath: 'metadata.email' },
  ],
};

describe('validateEntityLinkOverrides', () => {
  it('accepts null and well-formed input', () => {
    expect(validateEntityLinkOverrides(null)).toEqual([]);
    expect(
      validateEntityLinkOverrides({
        $member: { autoCreate: false, maskIdentities: ['phone'] },
        chat_group: { disable: true },
      })
    ).toEqual([]);
  });

  it('reports shape errors', () => {
    expect(validateEntityLinkOverrides(['x'])).toHaveLength(1);
    expect(
      validateEntityLinkOverrides({ $member: { disable: 'yes' } }).some((e) =>
        /disable: must be a boolean/.test(e)
      )
    ).toBe(true);
    expect(
      validateEntityLinkOverrides({ $member: { maskIdentities: [1, 2] } }).some((e) =>
        /maskIdentities: must be an array of strings/.test(e)
      )
    ).toBe(true);
  });
});

describe('resolveEntityLinkRules', () => {
  it('returns rules unchanged when overrides is null', () => {
    expect(resolveEntityLinkRules([baseRule], null)).toEqual([baseRule]);
  });

  it('disable drops the rule', () => {
    expect(resolveEntityLinkRules([baseRule], { $member: { disable: true } })).toEqual([]);
  });

  it('retarget + autoCreate + mask compose', () => {
    const [out] = resolveEntityLinkRules([baseRule], {
      $member: { retargetEntityType: 'customer', autoCreate: false, maskIdentities: ['phone'] },
    });
    expect(out.entityType).toBe('customer');
    expect(out.autoCreate).toBe(false);
    expect(out.identities.map((i) => i.namespace)).toEqual(['email']);
  });

  it('drops the rule if masking leaves zero identities', () => {
    expect(
      resolveEntityLinkRules([baseRule], {
        $member: { maskIdentities: ['phone', 'email'] },
      })
    ).toEqual([]);
  });
});

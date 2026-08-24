import { describe, expect, it } from 'vitest';
import {
  LINKEDIN_IDENTITY,
  linkedInIdentityModule,
  normalizeLinkedInIdentityValue,
  normalizeLinkedInMemberId,
  normalizeLinkedInSlug,
} from '../linkedin-identity';

describe('LinkedIn identity module', () => {
  it('normalizes profile slugs and rejects non-profile URLs', () => {
    expect(
      normalizeLinkedInSlug('https://www.LinkedIn.com/in/Jane-Doe/?trk=x'),
    ).toBe('jane-doe');
    expect(
      normalizeLinkedInSlug('https://www.linkedin.com/company/acme'),
    ).toBeNull();
  });

  it('normalizes person member ids and rejects other URNs', () => {
    expect(normalizeLinkedInMemberId('urn:li:fsd_profile:ACoAAB1234')).toBe(
      'ACoAAB1234',
    );
    expect(normalizeLinkedInMemberId('urn:li:fsd_company:99')).toBeNull();
  });

  it('owns both namespaces and makes both recallable', () => {
    expect(
      normalizeLinkedInIdentityValue(LINKEDIN_IDENTITY.SLUG, 'Jane-Doe'),
    ).toBe('jane-doe');
    expect(linkedInIdentityModule.recallNamespaces).toEqual([
      LINKEDIN_IDENTITY.SLUG,
      LINKEDIN_IDENTITY.MEMBER_ID,
    ]);
  });
});

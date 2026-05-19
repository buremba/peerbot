/**
 * Unit tests for `auth/install-operator.ts`.
 *
 * Pure functions only — integration coverage for `ensureInstallOperator()`
 * lives in `__tests__/integration/auth/install-operator.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import {
  HUMAN_KIND,
  INSTALL_OPERATOR_KIND,
  NOT_INSTALL_OPERATOR_PREDICATE,
  installOperatorEmail,
  isInstallOperator,
} from '../install-operator';

describe('isInstallOperator', () => {
  it('returns true for an install_operator row', () => {
    expect(isInstallOperator({ principal_kind: INSTALL_OPERATOR_KIND })).toBe(true);
  });

  it('returns false for a human row', () => {
    expect(isInstallOperator({ principal_kind: HUMAN_KIND })).toBe(false);
  });

  it('returns false for a row missing the discriminator', () => {
    expect(isInstallOperator({})).toBe(false);
    expect(isInstallOperator(null)).toBe(false);
    expect(isInstallOperator(undefined)).toBe(false);
  });

  it('returns false for unknown principal_kind values', () => {
    expect(isInstallOperator({ principal_kind: 'service-account' })).toBe(false);
  });
});

describe('installOperatorEmail', () => {
  it('returns a lowercase install@<hostname> address', () => {
    const email = installOperatorEmail();
    expect(email.startsWith('install@')).toBe(true);
    expect(email).toBe(email.toLowerCase());
  });

  it('never produces a bare `install@` even if hostname is empty', () => {
    // Sanity guard — the implementation falls back to "localhost".
    const email = installOperatorEmail();
    expect(email).not.toBe('install@');
    expect(email.length).toBeGreaterThan('install@'.length);
  });
});

describe('NOT_INSTALL_OPERATOR_PREDICATE', () => {
  it('matches the discriminator constant', () => {
    // If anyone ever renames INSTALL_OPERATOR_KIND, every SQL call site that
    // hand-rolled the literal `WHERE principal_kind <> 'install_operator'`
    // will drift; pin the predicate string so a rename forces a test fail.
    expect(NOT_INSTALL_OPERATOR_PREDICATE).toBe(
      `principal_kind <> '${INSTALL_OPERATOR_KIND}'`
    );
    expect(NOT_INSTALL_OPERATOR_PREDICATE).toBe(
      "principal_kind <> 'install_operator'"
    );
  });
});

import { describe, expect, test } from 'bun:test';
import {
  GITHUB_IDENTITY,
  githubKeyForOriginId,
  githubUserIdentityKey,
  normalizeGithubIdentityValue,
  normalizeGithubLogin,
  normalizeGithubRepoFullName,
} from '../github-identity';

describe('normalizeGithubLogin', () => {
  test('lowercases valid logins', () => {
    expect(normalizeGithubLogin('Burak-Emre')).toBe('burak-emre');
    expect(normalizeGithubLogin('octocat')).toBe('octocat');
  });

  test('rejects logins that violate GitHub rules', () => {
    expect(normalizeGithubLogin('-leading-dash')).toBeNull();
    expect(normalizeGithubLogin('double--dash')).toBeNull();
    expect(normalizeGithubLogin('trailing-')).toBeNull();
    expect(normalizeGithubLogin('a'.repeat(40))).toBeNull();
    expect(normalizeGithubLogin('')).toBeNull();
  });
});

describe('normalizeGithubRepoFullName', () => {
  test('lowercases owner/repo full names', () => {
    expect(normalizeGithubRepoFullName('Lobu-AI/Lobu')).toBe('lobu-ai/lobu');
  });

  test('rejects invalid full names', () => {
    expect(normalizeGithubRepoFullName('missing-repo')).toBeNull();
    expect(normalizeGithubRepoFullName('/repo')).toBeNull();
    expect(normalizeGithubRepoFullName('owner/')).toBeNull();
  });
});

describe('normalizeGithubIdentityValue', () => {
  test('dispatches github namespaces', () => {
    expect(normalizeGithubIdentityValue(GITHUB_IDENTITY.LOGIN, 'Octocat')).toBe(
      'octocat',
    );
    expect(normalizeGithubIdentityValue(GITHUB_IDENTITY.USER_ID, '  583231 ')).toBe(
      '583231',
    );
    expect(
      normalizeGithubIdentityValue(GITHUB_IDENTITY.REPO_FULL_NAME, 'Lobu-AI/Lobu'),
    ).toBe('lobu-ai/lobu');
  });

  test('returns undefined for non-github namespaces', () => {
    expect(normalizeGithubIdentityValue('email', 'a@b.com')).toBeUndefined();
  });
});

describe('githubUserIdentityKey', () => {
  test('prefers immutable user id when present', () => {
    expect(githubUserIdentityKey({ userId: 583231, login: 'Octocat' })).toBe(
      'github_user_id:583231',
    );
  });

  test('falls back to normalized login without id', () => {
    expect(githubUserIdentityKey({ login: 'Octocat' })).toBe('github_login:octocat');
  });

  test('falls back to lowercased login when normalization rejects', () => {
    expect(githubUserIdentityKey({ login: '-bad' })).toBe('github_login:-bad');
  });
});

describe('githubKeyForOriginId', () => {
  test('sanitizes colons for origin_id suffix', () => {
    expect(githubKeyForOriginId('github_user_id:583231')).toBe(
      'github_user_id_583231',
    );
  });
});
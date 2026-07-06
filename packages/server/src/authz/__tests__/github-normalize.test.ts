import { describe, expect, it } from 'vitest';
import { normalizeGithubLogin, normalizeGithubRepoFullName } from '../github-normalize.js';

describe('normalizeGithubLogin', () => {
  it('lowercases valid logins', () => {
    expect(normalizeGithubLogin('Burak-Emre')).toBe('burak-emre');
    expect(normalizeGithubLogin('octocat')).toBe('octocat');
  });

  it('rejects logins that violate GitHub rules', () => {
    expect(normalizeGithubLogin('-leading-dash')).toBeNull();
    expect(normalizeGithubLogin('double--dash')).toBeNull();
    expect(normalizeGithubLogin('trailing-')).toBeNull();
    expect(normalizeGithubLogin('a'.repeat(40))).toBeNull();
    expect(normalizeGithubLogin('')).toBeNull();
  });
});

describe('normalizeGithubRepoFullName', () => {
  it('lowercases owner/repo full names', () => {
    expect(normalizeGithubRepoFullName('Lobu-AI/Lobu')).toBe('lobu-ai/lobu');
  });

  it('rejects invalid full names', () => {
    expect(normalizeGithubRepoFullName('missing-repo')).toBeNull();
    expect(normalizeGithubRepoFullName('/repo')).toBeNull();
    expect(normalizeGithubRepoFullName('owner/')).toBeNull();
  });
});
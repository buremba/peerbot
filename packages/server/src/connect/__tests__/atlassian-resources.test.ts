/**
 * Unit tests for Atlassian 3LO site discovery (Jira cloud_id stamping).
 */

import { describe, expect, it, vi } from 'vitest';
import {
  fetchAtlassianAccessibleResources,
  mergeJiraSiteIntoConnectionConfig,
  pickPrimaryJiraSite,
  resolveJiraCloudSite,
} from '../atlassian-resources';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('fetchAtlassianAccessibleResources', () => {
  it('parses resources and ignores malformed rows', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse([
        {
          id: 'cloud-a',
          url: 'https://a.atlassian.net',
          name: 'A',
          scopes: ['read:jira-work'],
        },
        { id: 123 }, // ignored — id not string
        { url: 'https://orphan.atlassian.net' }, // no id
        {
          id: 'cloud-b',
          url: 'https://b.atlassian.net',
          name: 'B',
          scopes: ['read:confluence-content.summary'],
        },
      ])
    );

    const resources = await fetchAtlassianAccessibleResources('tok', fetchImpl as typeof fetch);
    expect(resources).toEqual([
      {
        id: 'cloud-a',
        url: 'https://a.atlassian.net',
        name: 'A',
        scopes: ['read:jira-work'],
      },
      {
        id: 'cloud-b',
        url: 'https://b.atlassian.net',
        name: 'B',
        scopes: ['read:confluence-content.summary'],
      },
    ]);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.atlassian.com/oauth/token/accessible-resources',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'Bearer tok',
        }),
      })
    );
  });

  it('returns [] on non-2xx without throwing', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 401 }));
    await expect(
      fetchAtlassianAccessibleResources('tok', fetchImpl as typeof fetch)
    ).resolves.toEqual([]);
  });

  it('returns [] on network error without throwing', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    });
    await expect(
      fetchAtlassianAccessibleResources('tok', fetchImpl as typeof fetch)
    ).resolves.toEqual([]);
  });
});

describe('pickPrimaryJiraSite', () => {
  it('prefers a resource with a jira scope', () => {
    const site = pickPrimaryJiraSite([
      {
        id: 'confluence-only',
        url: 'https://c.atlassian.net',
        name: 'C',
        scopes: ['read:confluence-content.summary'],
      },
      {
        id: 'jira-site',
        url: 'https://j.atlassian.net',
        name: 'J',
        scopes: ['read:jira-work', 'read:jira-user'],
      },
    ]);
    expect(site?.cloudId).toBe('jira-site');
    expect(site?.siteUrl).toBe('https://j.atlassian.net');
    expect(site?.siteName).toBe('J');
    expect(site?.accessibleResources).toHaveLength(2);
  });

  it('falls back to the first resource when none carry jira scopes', () => {
    const site = pickPrimaryJiraSite([
      {
        id: 'first',
        url: 'https://1.atlassian.net',
        name: 'One',
        scopes: [],
      },
      {
        id: 'second',
        url: 'https://2.atlassian.net',
        name: 'Two',
        scopes: [],
      },
    ]);
    expect(site?.cloudId).toBe('first');
  });

  it('returns null for an empty list', () => {
    expect(pickPrimaryJiraSite([])).toBeNull();
  });
});

describe('resolveJiraCloudSite', () => {
  it('composes fetch + pick', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse([
        {
          id: 'cloud-1',
          url: 'https://rakam1.atlassian.net',
          name: 'rakam1',
          scopes: ['read:jira-work'],
        },
      ])
    );
    const site = await resolveJiraCloudSite('tok', fetchImpl as typeof fetch);
    expect(site).toMatchObject({
      cloudId: 'cloud-1',
      siteUrl: 'https://rakam1.atlassian.net',
      siteName: 'rakam1',
    });
  });
});

describe('mergeJiraSiteIntoConnectionConfig', () => {
  it('preserves existing keys and stamps site fields', () => {
    const site = pickPrimaryJiraSite([
      {
        id: 'cloud-1',
        url: 'https://a.atlassian.net',
        name: 'A',
        scopes: ['read:jira-work'],
      },
    ])!;
    const merged = mergeJiraSiteIntoConnectionConfig(
      { action_modes: { create_issue: 'approval' }, webhook_external_id: '99' },
      site
    );
    expect(merged).toEqual({
      action_modes: { create_issue: 'approval' },
      webhook_external_id: '99',
      cloud_id: 'cloud-1',
      site_url: 'https://a.atlassian.net',
      site_name: 'A',
      accessible_sites: [{ id: 'cloud-1', url: 'https://a.atlassian.net', name: 'A' }],
    });
  });

  it('handles null existing config', () => {
    const site = pickPrimaryJiraSite([
      { id: 'c', url: null, name: null, scopes: [] },
    ])!;
    expect(mergeJiraSiteIntoConnectionConfig(null, site)).toMatchObject({
      cloud_id: 'c',
      accessible_sites: [{ id: 'c', url: null, name: null }],
    });
  });
});

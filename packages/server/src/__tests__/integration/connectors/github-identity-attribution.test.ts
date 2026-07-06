/**
 * GitHub member-identity attribution contract (#17).
 *
 * Two ingestion paths must attribute a GitHub author to a tenant-scoped
 * `person`, keyed PRIMARY on the immutable `github_user_id` and SECONDARY on
 * `github_login`:
 *
 *   1. poll/sync — `applyEventAttributions` reads the connector's `attributions` rules
 *      from `connector_definitions` and resolves/creates the person.
 *   2. live webhook — `resolveGithubWebhookActor` (App-webhook path, no feed)
 *      extracts the actor and resolves the SAME person, returning the entity
 *      ids to stamp onto `events.entity_ids`.
 *
 * Both are org-scoped end to end: entity_identities are UNIQUE per
 * (org, namespace, identifier), so a second org never resolves to another's
 * person even with the same login/id.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyEventAttributions,
  clearEntityLinkRulesCache,
} from '../../../utils/entity-link-upsert';
import { resolveGithubWebhookActor } from '../../../gateway/routes/public/github-webhook-actor';
import { entityLinkMatchSql } from '../../../utils/content-search/entity-link';
import { insertEvent } from '../../../utils/insert-event';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestConnectorDefinition,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';

const connectorKey = 'github';
const feedKey = 'issues';

/** The github person attribution rule, mirrored from the github connector. */
const githubPersonAttribution = {
  role: 'authored_by',
  autoCreate: true,
  target: {
    entityType: 'person',
    titlePath: 'metadata.author_login',
    identities: [
      { namespace: 'github_user_id', eventPath: 'metadata.author_id', primary: true },
      { namespace: 'github_login', eventPath: 'metadata.author_login' },
    ],
  },
  traits: {
    github_login: { eventPath: 'metadata.author_login', behavior: 'prefer_non_empty' },
    last_authored_at: { eventPath: 'occurred_at', behavior: 'overwrite' },
  },
};

async function ensurePersonType(orgId: string): Promise<void> {
  const sql = getTestDb();
  const existing = await sql`
    SELECT id FROM entity_types
    WHERE organization_id = ${orgId} AND slug = 'person' AND deleted_at IS NULL
    LIMIT 1
  `;
  if (existing.length === 0) {
    await sql`
      INSERT INTO entity_types (organization_id, slug, name, created_at, updated_at)
      VALUES (${orgId}, 'person', 'Person', current_timestamp, current_timestamp)
    `;
  }
}

async function seedOrg(name: string) {
  const org = await createTestOrganization({ name });
  const user = await createTestUser();
  await addUserToOrganization(user.id, org.id, 'owner');
  await ensurePersonType(org.id);
  return org;
}

async function seedGithubConnector(orgId: string) {
  await createTestConnectorDefinition({
    key: connectorKey,
    name: 'GitHub',
    organization_id: orgId,
    feeds_schema: {
      [feedKey]: {
        eventKinds: {
          issue: { attributions: [githubPersonAttribution] },
        },
      },
    },
  });
}

async function members(orgId: string) {
  const sql = getTestDb();
  return sql<{ id: number; name: string; metadata: Record<string, unknown> }[]>`
    SELECT e.id, e.name, e.metadata
    FROM entities e
    JOIN entity_types et ON et.id = e.entity_type_id
    WHERE e.organization_id = ${orgId}
      AND et.slug = 'person'
      AND e.deleted_at IS NULL
  `;
}

async function identitiesFor(entityId: number) {
  const sql = getTestDb();
  const rows = await sql<{ namespace: string; identifier: string }[]>`
    SELECT namespace, identifier
    FROM entity_identities
    WHERE entity_id = ${entityId} AND deleted_at IS NULL
    ORDER BY namespace, identifier
  `;
  return rows.map((r) => `${r.namespace}:${r.identifier}`);
}

describe('github member-identity attribution', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
    clearEntityLinkRulesCache();
  });

  it('poll/sync: a synced issue auto-creates a person with github_user_id + github_login identities and stamps the metadata namespace slot', async () => {
    const org = await seedOrg('GitHub Poll Org');
    await seedGithubConnector(org.id);
    clearEntityLinkRulesCache();

    const item: {
      origin_type: string;
      occurred_at: string;
      metadata: Record<string, unknown>;
    } = {
      origin_type: 'issue',
      // Top-level EventEnvelope field — the `last_authored_at` trait reads it.
      occurred_at: '2026-06-22T00:00:00.000Z',
      metadata: {
        number: 7,
        author_login: 'Octocat',
        author_id: '583231',
      },
    };

    await applyEventAttributions({ connectorKey, feedKey, orgId: org.id, items: [item] });

    const people = await members(org.id);
    expect(people).toHaveLength(1);
    expect(people[0].name).toBe('Octocat');
    // The `github_login` trait preserves the raw display casing; the identity
    // (and the read-time metadata slot below) carry the normalized form.
    expect(people[0].metadata.github_login).toBe('Octocat');
    expect(people[0].metadata.last_authored_at).toBe('2026-06-22T00:00:00.000Z');

    expect(await identitiesFor(people[0].id)).toEqual([
      'github_login:octocat',
      'github_user_id:583231',
    ]);

    // The canonical read-time namespace slot (normalized) is stamped onto the
    // item so the entity_identities JOIN surfaces the event.
    expect(item.metadata.github_login).toBe('octocat');
    expect(item.metadata.github_user_id).toBe('583231');
  });

  it('poll/sync: a renamed login still resolves to the same person via the immutable github_user_id', async () => {
    const org = await seedOrg('GitHub Rename Org');
    await seedGithubConnector(org.id);
    clearEntityLinkRulesCache();

    await applyEventAttributions({
      connectorKey,
      feedKey,
      orgId: org.id,
      items: [
        {
          origin_type: 'issue',
          metadata: { author_login: 'oldname', author_id: '999', occurred_at: '2026-06-01T00:00:00.000Z' },
        },
      ],
    });
    // Same user id, new login → must NOT create a second person.
    await applyEventAttributions({
      connectorKey,
      feedKey,
      orgId: org.id,
      items: [
        {
          origin_type: 'issue',
          metadata: { author_login: 'newname', author_id: '999', occurred_at: '2026-06-22T00:00:00.000Z' },
        },
      ],
    });

    const people = await members(org.id);
    expect(people).toHaveLength(1);
    // Both logins are now claimed by the one person (sorted by namespace then
    // identifier; both logins share the github_login namespace).
    expect(await identitiesFor(people[0].id)).toEqual([
      'github_login:newname',
      'github_login:oldname',
      'github_user_id:999',
    ]);
  });

  it('poll/sync: a renamed-then-reused login does NOT conflate a new account into the old person (github_user_id primary)', async () => {
    const org = await seedOrg('GitHub Reuse Org');
    await seedGithubConnector(org.id);
    clearEntityLinkRulesCache();

    // Login "shared" was user_id 1 → person-1 created and claims github_login:shared.
    await applyEventAttributions({
      connectorKey,
      feedKey,
      orgId: org.id,
      items: [{ origin_type: 'issue', metadata: { author_login: 'shared', author_id: '1' } }],
    });
    const afterFirst = await members(org.id);
    expect(afterFirst).toHaveLength(1);
    const personOneId = afterFirst[0].id;

    // The original "shared" account renamed away; a DIFFERENT account (user_id 2)
    // now uses the login "shared". The immutable github_user_id is PRIMARY and
    // present (=2, unmatched), so resolution must NOT fall through to the stale
    // github_login:shared match → a distinct person-2 is created.
    await applyEventAttributions({
      connectorKey,
      feedKey,
      orgId: org.id,
      items: [{ origin_type: 'issue', metadata: { author_login: 'shared', author_id: '2' } }],
    });

    const people = await members(org.id);
    expect(people).toHaveLength(2);
    const personTwo = people.find((p) => p.id !== personOneId);
    expect(personTwo).toBeDefined();
    // person-2 owns github_user_id:2. The login stayed with whoever claimed it
    // first (UNIQUE per org,namespace,identifier), so person-2 only has the id.
    expect(await identitiesFor(personTwo!.id)).toEqual(['github_user_id:2']);
    // person-1 is untouched — no conflation.
    expect(await identitiesFor(personOneId)).toEqual([
      'github_login:shared',
      'github_user_id:1',
    ]);
  });

  it('poll/sync: a stale secondary identity is NOT mis-claimed in the in-batch matches map', async () => {
    const org = await seedOrg('GitHub Map Claim Org');
    await seedGithubConnector(org.id);
    clearEntityLinkRulesCache();

    // Pre-seed person-1 owning github_login:shared + github_user_id:1.
    await applyEventAttributions({
      connectorKey,
      feedKey,
      orgId: org.id,
      items: [{ origin_type: 'issue', metadata: { author_login: 'shared', author_id: '1' } }],
    });
    const personOneId = (await members(org.id))[0].id;

    // In ONE batch:
    //   (a) login "shared" + a FRESH id 2 → creates person-2; the login stays on
    //       person-1 (ON CONFLICT no-op), so the matches map must NOT claim
    //       github_login:shared for person-2.
    //   (b) a login-only "shared" event → must resolve to person-1 (the real
    //       owner of that login), proving the map wasn't mis-claimed for person-2.
    await applyEventAttributions({
      connectorKey,
      feedKey,
      orgId: org.id,
      items: [
        { origin_type: 'issue', metadata: { author_login: 'shared', author_id: '2' } },
        { origin_type: 'issue', metadata: { author_login: 'shared' } },
      ],
    });

    const people = await members(org.id);
    // Exactly two people: person-1 (login owner) and person-2 (id:2). The
    // login-only event resolved to person-1, NOT a third entity or person-2.
    expect(people).toHaveLength(2);
    const personTwo = people.find((p) => p.id !== personOneId);
    expect(personTwo).toBeDefined();
    expect(await identitiesFor(personTwo!.id)).toEqual(['github_user_id:2']);
    expect(await identitiesFor(personOneId)).toEqual([
      'github_login:shared',
      'github_user_id:1',
    ]);
  });

  it('poll/sync READ-TIME: a reused-login event attributes to the user_id-2 person, NOT the old person-1', async () => {
    const org = await seedOrg('GitHub Read-Time Reuse Org');
    await seedGithubConnector(org.id);
    clearEntityLinkRulesCache();
    const sql = getTestDb();

    // Helper: which events attribute to `entityId` at READ TIME (the
    // entityLinkMatchSql JOIN against entity_identities + events.metadata).
    const readTimeEventIds = async (entityId: number): Promise<number[]> => {
      const rows = await sql<{ id: number }[]>`
        SELECT f.id FROM events f
        WHERE f.organization_id = ${org.id}
          AND ${sql.unsafe(entityLinkMatchSql(`${entityId}::bigint`, 'f'))}
        ORDER BY f.id
      `;
      return rows.map((r) => Number(r.id));
    };

    // Event 1: login "shared" + user_id 1 → person-1. applyEventAttributions stamps
    // the attached identifier slots onto item1.metadata.
    const item1: { origin_type: string; metadata: Record<string, unknown> } = {
      origin_type: 'issue',
      metadata: { author_login: 'shared', author_id: '1' },
    };
    await applyEventAttributions({ connectorKey, feedKey, orgId: org.id, items: [item1] });
    const personOneId = (await members(org.id))[0].id;
    const e1 = await insertEvent({
      entityIds: [],
      organizationId: org.id,
      originId: 'evt-1',
      semanticType: 'content',
      title: 'issue 1',
      originType: 'issue',
      connectorKey: 'github',
      metadata: item1.metadata,
    });

    // Event 2: same login "shared" reclaimed by a DIFFERENT account (user_id 2)
    // → person-2 (immutable id primary). applyEventAttributions stamps ONLY the
    // attached identifier (github_user_id:2), not the stale github_login:shared.
    const item2: { origin_type: string; metadata: Record<string, unknown> } = {
      origin_type: 'issue',
      metadata: { author_login: 'shared', author_id: '2' },
    };
    await applyEventAttributions({ connectorKey, feedKey, orgId: org.id, items: [item2] });
    const people = await members(org.id);
    expect(people).toHaveLength(2);
    const personTwoId = people.find((p) => p.id !== personOneId)!.id;
    const e2 = await insertEvent({
      entityIds: [],
      organizationId: org.id,
      originId: 'evt-2',
      semanticType: 'content',
      title: 'issue 2',
      originType: 'issue',
      connectorKey: 'github',
      metadata: item2.metadata,
    });

    // THE read-time assertion: event-2 attributes to person-2 (via the immutable
    // github_user_id), NOT to the old person-1 (the reused login is not stamped).
    expect(await readTimeEventIds(personTwoId)).toEqual([Number(e2.id)]);
    expect(await readTimeEventIds(personOneId)).toEqual([Number(e1.id)]);
    // The stale login is not on event-2's metadata, so it can't JOIN person-1.
    expect(item2.metadata.github_login).toBeUndefined();
    expect(item2.metadata.github_user_id).toBe('2');
  });

  it('webhook: resolveGithubWebhookActor resolves the actor to a person and returns entity ids + the github_login metadata slot', async () => {
    const org = await seedOrg('GitHub Webhook Org');
    // The rule is loaded from the connector definition (not mirrored), so the
    // webhook path needs the github def seeded just like the poll path.
    await seedGithubConnector(org.id);
    clearEntityLinkRulesCache();

    const resolution = await resolveGithubWebhookActor({
      organizationId: org.id,
      githubEvent: 'issue_comment',
      payload: {
        action: 'created',
        comment: { user: { login: 'Hubot', id: 42 }, html_url: 'https://github.com/x/y/issues/1#c1' },
        issue: { user: { login: 'someone-else', id: 7 }, title: 'Bug' },
        sender: { login: 'Hubot', id: 42 },
      },
    });

    expect(resolution).not.toBeNull();
    expect(resolution?.entityIds).toHaveLength(1);
    // The COMMENT author (Hubot), not the issue author, is attributed.
    expect(resolution?.metadata.github_login).toBe('hubot');
    expect(resolution?.metadata.github_user_id).toBe('42');

    const people = await members(org.id);
    expect(people).toHaveLength(1);
    expect(people[0].id).toBe(resolution?.entityIds[0]);
    expect(await identitiesFor(people[0].id)).toEqual([
      'github_login:hubot',
      'github_user_id:42',
    ]);
    // The `last_authored_at` trait populates on the webhook path too (occurred_at
    // is on the top-level item, where the rule's trait path reads it).
    expect(people[0].metadata.last_authored_at).toBeTruthy();
    expect(typeof people[0].metadata.last_authored_at).toBe('string');
  });

  it('webhook: an unmapped github event (push) resolves no actor', async () => {
    const org = await seedOrg('GitHub Push Org');
    const resolution = await resolveGithubWebhookActor({
      organizationId: org.id,
      githubEvent: 'push',
      payload: { pusher: { name: 'someone' }, sender: { login: 'someone', id: 1 } },
    });
    expect(resolution).toBeNull();
    expect(await members(org.id)).toHaveLength(0);
  });

  it('tenant-scoped: the same github user in two orgs resolves to two distinct persons', async () => {
    const orgA = await seedOrg('GitHub Tenant A');
    const orgB = await seedOrg('GitHub Tenant B');
    await seedGithubConnector(orgA.id);
    await seedGithubConnector(orgB.id);
    clearEntityLinkRulesCache();

    const a = await resolveGithubWebhookActor({
      organizationId: orgA.id,
      githubEvent: 'issues',
      payload: { action: 'opened', issue: { user: { login: 'Shared', id: 555 }, title: 'A' } },
    });
    const b = await resolveGithubWebhookActor({
      organizationId: orgB.id,
      githubEvent: 'issues',
      payload: { action: 'opened', issue: { user: { login: 'Shared', id: 555 }, title: 'B' } },
    });

    const peopleA = await members(orgA.id);
    const peopleB = await members(orgB.id);
    expect(peopleA).toHaveLength(1);
    expect(peopleB).toHaveLength(1);
    // Distinct entities despite identical login + id — entity_identities are
    // UNIQUE per (org, namespace, identifier), never cross-org.
    expect(peopleA[0].id).not.toBe(peopleB[0].id);
    expect(a?.entityIds[0]).toBe(peopleA[0].id);
    expect(b?.entityIds[0]).toBe(peopleB[0].id);
  });
});

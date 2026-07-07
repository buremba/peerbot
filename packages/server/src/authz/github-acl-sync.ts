/**
 * GitHub repo-membership ACL SYNC — the production path that populates the repo
 * graph the resource gate reads, mirroring `./slack-acl-sync` for the second
 * source. Per GitHub connection: enumerate the repos it captures (from its
 * feeds), fetch each repo's collaborators, and hand them to `buildGithubRepoGraph`
 * (which materializes the `member_of` edges, reconciles departures, and stamps
 * the connection `full`/`fresh`).
 *
 * Fail-closed on error, ATOMIC per connection: if ANY repo's collaborator fetch
 * throws (GitHub outage, token expiry, repo gone), we mark the connection's ACL
 * state `failed` rather than build a half-synced graph — but only DOWNGRADE an
 * existing row (a connection that has never been graphed stays on the legacy
 * fence). The external calls (repo list, collaborator fetch) are injected so the
 * sync logic is tested with stubs and the live tick wires the real GitHub API.
 */

import { createLogger } from '@lobu/core';
import { getDb } from '../db/client.js';
import { getInstallationTokenRegistry } from '../gateway/installation/registry.js';
import type { CoreServices } from '../gateway/services/core-services.js';
import type { AppInstallationStore } from '../lobu/stores/app-installation-store.js';
import {
  type GithubRepoCollaborator,
  githubAclSource,
  githubReposToResources,
} from '@lobu/connectors/github-identity';
import { buildAccessGraph } from './access-graph.js';

const logger = createLogger('github-acl-sync');

/** `owner/repo` split, as a repo is captured by a connection's feed. */
export interface GithubRepoRef {
  owner: string;
  repo: string;
}

/** Injectable seams: tests drive the real graph build + gate with stubbed GitHub
 * calls; the live tick wires the real repo list + collaborator API. */
export interface GithubAclSyncDeps {
  /** The repos this connection captures (from its feeds' config). */
  listRepos: (params: { organizationId: string; connectionId: string }) => Promise<GithubRepoRef[]>;
  /** A repo's current collaborators. Throws on a GitHub-level error (fail-closed). */
  fetchCollaborators: (params: {
    organizationId: string;
    repo: GithubRepoRef;
  }) => Promise<GithubRepoCollaborator[]>;
}

export interface GithubAclSyncResult {
  ok: boolean;
  reposSynced: number;
}

/** Downgrade an EXISTING ACL row to `failed` so the gate fails closed. No-op
 * when the connection was never graphed (it stays on the legacy fence). */
async function markConnectionAclFailed(
  organizationId: string,
  connectionId: string,
): Promise<void> {
  const sql = getDb();
  await sql`
		UPDATE authz_source_acl_state
		SET freshness_state = 'failed', updated_at = current_timestamp
		WHERE organization_id = ${organizationId}
		  AND connection_id = ${connectionId}
	`;
}

/**
 * Sync ONE GitHub connection's repo-membership graph. Resolves its captured
 * repos, fetches collaborators per repo, and builds the graph. See the file
 * header for the fail-closed contract.
 */
export async function syncGithubConnectionAcl(
  deps: GithubAclSyncDeps,
  params: { connectionId: string; organizationId: string },
): Promise<GithubAclSyncResult> {
  const { connectionId, organizationId } = params;

  const repos = await deps.listRepos({ organizationId, connectionId });
  if (repos.length === 0) {
    return { ok: true, reposSynced: 0 };
  }

  try {
    const repoInputs = [];
    for (const repo of repos) {
      const collaborators = await deps.fetchCollaborators({ organizationId, repo });
      repoInputs.push({ fullName: `${repo.owner}/${repo.repo}`, collaborators });
    }
    await buildAccessGraph({
      organizationId,
      connectionId,
      connectorKey: githubAclSource.key,
      resourceType: githubAclSource.resourceType,
      memberIdentities: githubAclSource.memberIdentities,
      resources: githubReposToResources(repoInputs),
    });
    return { ok: true, reposSynced: repoInputs.length };
  } catch (error) {
    logger.error(
      { organization_id: organizationId, connection_id: connectionId, error: String(error) },
      'GitHub ACL sync failed — marking connection fail-closed',
    );
    await markConnectionAclFailed(organizationId, connectionId);
    return { ok: false, reposSynced: 0 };
  }
}

/** Parse `owner/repo` from a feed config (the GitHub connector stores
 * `repo_owner`/`repo_name`). Skips feeds without a fully-specified repo. */
function repoRefsFromFeedConfigs(configs: Array<Record<string, unknown> | null>): GithubRepoRef[] {
  const seen = new Set<string>();
  const refs: GithubRepoRef[] = [];
  for (const config of configs) {
    const owner = typeof config?.repo_owner === 'string' ? config.repo_owner.trim() : '';
    const repo = typeof config?.repo_name === 'string' ? config.repo_name.trim() : '';
    if (!owner || !repo) continue;
    const key = `${owner}/${repo}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({ owner, repo });
  }
  return refs;
}

/** GitHub `/repos/{owner}/{repo}/collaborators`, paginated, bare `{login,id}`.
 * Throws on a non-OK response so the sync treats it fail-closed. */
async function fetchRepoCollaborators(
  token: string,
  repo: GithubRepoRef,
): Promise<GithubRepoCollaborator[]> {
  const collaborators: GithubRepoCollaborator[] = [];
  const perPage = 100;
  for (let page = 1; page <= 100; page++) {
    const url = `https://api.github.com/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/collaborators?per_page=${perPage}&page=${page}`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'lobu',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!res.ok) {
      throw new Error(`GitHub collaborators ${repo.owner}/${repo.repo} returned ${res.status}`);
    }
    const body = (await res.json()) as Array<{ login?: string; id?: number }>;
    const items = Array.isArray(body) ? body : [];
    for (const c of items) {
      if (typeof c.login === 'string' && c.login) {
        collaborators.push({ login: c.login, id: typeof c.id === 'number' ? c.id : undefined });
      }
    }
    if (items.length < perPage) break;
  }
  return collaborators;
}

/**
 * The periodic production caller (registered via `./acl-sync`). Re-syncs every
 * active GitHub connection's repo-membership graph so collaborator changes
 * converge within the cadence and the gate's freshness window keeps a stalled
 * connection fail-closed. Runs on one replica per tick (the runs-queue claim).
 *
 * NOTE: the live token/collaborator path needs a real GitHub App install to
 * verify end to end; the sync LOGIC is covered by `__tests__/.../github-acl-sync`
 * driving {@link syncGithubConnectionAcl} with stubbed deps.
 */
export async function runGithubAclSyncTick(coreServices: CoreServices): Promise<void> {
  const sql = getDb();
  const connections = await sql<{ id: string; organization_id: string }>`
		SELECT id::text AS id, organization_id
		FROM connections
		WHERE connector_key = 'github' AND status = 'active' AND deleted_at IS NULL
	`;
  if (connections.length === 0) return;

  const installStore = coreServices.getAppInstallationStore();

  const deps: GithubAclSyncDeps = {
    listRepos: async ({ connectionId }) => {
      const rows = await sql<{ config: Record<string, unknown> | null }>`
				SELECT config FROM feeds WHERE connection_id = ${Number(connectionId)} AND deleted_at IS NULL
			`;
      return repoRefsFromFeedConfigs(rows.map((r) => r.config));
    },
    fetchCollaborators: async ({ organizationId, repo }) => {
      const token = await resolveGithubInstallationToken(installStore, organizationId);
      if (!token) throw new Error(`No GitHub installation token for org ${organizationId}`);
      return fetchRepoCollaborators(token, repo);
    },
  };

  let ok = 0;
  let failed = 0;
  for (const conn of connections) {
    const result = await syncGithubConnectionAcl(deps, {
      connectionId: conn.id,
      organizationId: conn.organization_id,
    });
    if (result.ok) ok += 1;
    else failed += 1;
  }
  logger.info({ connections: connections.length, ok, failed }, 'GitHub ACL sync tick complete');
}

/** Resolve an org's GitHub App installation token (collaborator-capable), minted
 * the same way the install flow does (`mintFor` over the install row with the
 * app-id/private-key env-var names). Returns null when the org has no active
 * GitHub install. */
async function resolveGithubInstallationToken(
  installStore: AppInstallationStore,
  organizationId: string,
): Promise<string | null> {
  const installs = await installStore.listByProviderAndOrg('github', organizationId);
  const install = installs.find((i) => i.status === 'active');
  if (!install) return null;
  const installWithKeys = {
    ...install,
    metadata: {
      ...install.metadata,
      appIdKey: install.metadata?.appIdKey ?? 'GITHUB_APP_ID',
      privateKeyKey: install.metadata?.privateKeyKey ?? 'GITHUB_APP_PRIVATE_KEY',
    },
  };
  const minted = await getInstallationTokenRegistry().mintFor(installWithKeys);
  return minted.token;
}

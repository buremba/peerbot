/**
 * GitHub repository membership graph — the SECOND ACL source, and the one that
 * proves `./access-graph` generalizes (the engine was extracted from Slack with
 * exactly this caller in mind).
 *
 * A repo's read audience is its COLLABORATORS. Each repo becomes a `repo` entity
 * keyed on its `github_repo_full_name` (`owner/repo`, normalized) — the SAME key
 * the GitHub connector stamps on the data it ingests (`metadata.github_repo_full_name`
 * + the repo entity link), so the resource gate (`./resource-visibility`) joins an
 * event's repo to these `member_of` edges and restricts GitHub recall to repos the
 * requester belongs to. Each collaborator resolves identity-first on
 * `github_user_id` (+ `github_login`), so a collaborator who has also authored
 * issues — or signed in — collapses onto their existing entity instead of forking
 * a duplicate. Folding GitHub onto the shared engine gives it the departure
 * reconcile + identity-first collapse the original org-level `buildGithubTeamGraph`
 * lacked.
 */

import {
  GITHUB_IDENTITY,
  normalizeGithubLogin,
  normalizeGithubRepoFullName,
} from '@lobu/connectors/github-identity';
import { normalizeNumericId } from '@lobu/connector-sdk';
import {
  type AccessGraphResult,
  type AccessMember,
  type AccessResource,
  buildAccessGraph,
} from './access-graph.js';
import { GITHUB_SOURCE } from './sources.js';

/** A repo collaborator as the GitHub collaborators API reports it. */
export interface GithubRepoCollaborator {
  login: string;
  id?: number;
}

/** A repository and the collaborators who may read it. */
export interface GithubRepoInput {
  /** `owner/repo`. */
  fullName: string;
  collaborators: GithubRepoCollaborator[];
}

/**
 * Materialize a GitHub installation's repo-membership graph and mark the
 * connection ACL-enforced. Injectable `repos` (with their collaborators) so tests
 * and the live sync both call the same builder.
 */
export async function buildGithubRepoGraph(params: {
  organizationId: string;
  connectionId: string;
  repos: GithubRepoInput[];
}): Promise<AccessGraphResult> {
  const resources: AccessResource[] = [];
  for (const repo of params.repos) {
    const key = normalizeGithubRepoFullName(repo.fullName);
    if (!key) continue;
    const members: AccessMember[] = [];
    for (const c of repo.collaborators) {
      const login = normalizeGithubLogin(c.login);
      const idValue = c.id != null ? normalizeNumericId(String(c.id)) : null;
      const identities: { namespace: string; value: string }[] = [];
      if (idValue) identities.push({ namespace: GITHUB_IDENTITY.USER_ID, value: idValue });
      if (login) identities.push({ namespace: GITHUB_IDENTITY.LOGIN, value: login });
      if (identities.length === 0) continue;
      members.push({ key: idValue ?? (login as string), name: c.login, identities });
    }
    resources.push({ key, name: repo.fullName, members });
  }

  return buildAccessGraph({
    organizationId: params.organizationId,
    connectionId: params.connectionId,
    connectorKey: GITHUB_SOURCE.key,
    resourceType: GITHUB_SOURCE.resourceType,
    memberIdentities: GITHUB_SOURCE.memberIdentities,
    resources,
  });
}

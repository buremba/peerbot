import { createLogger } from "@lobu/core";
import { agentExistsInOrganization } from "../../../lobu/stores/postgres-stores.js";
import { isAdminOrOwnerRole } from "../../../tools/access-control.js";
import { getMembershipRole } from "../../../workspace/multi-tenant.js";

const logger = createLogger("org-agent-access");

interface OrgAgentMembershipGrant {
  organizationId: string;
  userId: string;
  role: string;
}

/**
 * Authorize a human to USE an org's agent through MEMBERSHIP rather than
 * ownership. Grants `use`, never `manage` (agent management stays owner/admin
 * on the org-scoped REST routes).
 *
 * `organizationId` MUST already be a PROVEN tenant — the workspace the request
 * named (`x-lobu-org`, resolved by slug) or the org stamped on an existing
 * session row — never the caller's ambient default org. Membership in THAT org
 * is verified against `member`, and the agent must actually exist in it: the
 * same agent id string can exist in every org, so membership alone would
 * authorize the wrong tenant's agent.
 *
 * Returns null (the caller keeps its ownership denial) rather than a Response,
 * so the response shape stays uniform with no oracle for which check failed.
 * An unreachable lookup denies rather than turning authorization into a 500.
 */
export async function authorizeOrgAgentMemberInProvenOrg(args: {
  organizationId: string;
  agentId: string;
  userId: string;
}): Promise<OrgAgentMembershipGrant | null> {
  try {
    const role = await getMembershipRole(
      args.organizationId,
      args.userId
    );
    if (!role) return null;
    if (!(await agentExistsInOrganization(args.organizationId, args.agentId))) {
      return null;
    }
    return {
      organizationId: args.organizationId,
      userId: args.userId,
      role,
    };
  } catch (error) {
    logger.warn(
      {
        err: error,
        agentId: args.agentId,
        organizationId: args.organizationId,
      },
      "org-agent membership lookup failed — denying"
    );
    return null;
  }
}

/**
 * True for a membership-authorized caller WITHOUT org oversight. Org
 * owner/admins keep oversight of their members' agent conversations; a plain
 * member is confined to their own. `undefined` means the caller reached the
 * agent by OWNERSHIP, which this restriction never applies to.
 */
export function isRestrictedOrgAgentMember(role: string | undefined): boolean {
  return role !== undefined && !isAdminOrOwnerRole(role);
}

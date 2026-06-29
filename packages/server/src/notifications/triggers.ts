import { getDb } from '../db/client';
import { emit } from '../events/emitter';
import { createNotificationForUsers } from './service';

/** Notification content minus the org id (the dispatch helpers stamp it). */
type OrgNotification = Omit<Parameters<typeof createNotificationForUsers>[1], 'organizationId'>;

async function getOrgAdminUserIds(organizationId: string): Promise<string[]> {
  const sql = getDb();
  const rows = await sql<{ userId: string }>`
    SELECT "userId"
    FROM "member"
    WHERE "organizationId" = ${organizationId}
      AND role IN ('admin', 'owner')
  `;
  return rows.map((r) => r.userId);
}

async function getOrgSlug(organizationId: string): Promise<string | null> {
  const sql = getDb();
  const rows = await sql<{ slug: string }>`
    SELECT slug FROM "organization" WHERE id = ${organizationId} LIMIT 1
  `;
  return rows[0]?.slug ?? null;
}

/**
 * Shared trigger tail: write the notification for the resolved recipients and
 * poke the org's SSE keys so inboxes refresh. Every trigger below ends here;
 * what varies is recipient resolution — admins (with the org slug fetched for
 * URL building) vs an explicit user — kept explicit per trigger.
 */
async function sendNotification(
  orgId: string,
  userIds: string[],
  notification: OrgNotification
): Promise<void> {
  await createNotificationForUsers(userIds, { organizationId: orgId, ...notification });
  emit(orgId, { keys: ['notifications', 'notifications-unread-count'] });
}

/**
 * Admin-recipient triggers: resolve the org's admins/owners (no-op when there
 * are none — the slug isn't fetched either), then build the notification with
 * the org slug available for resource URLs.
 */
async function notifyOrgAdmins(
  orgId: string,
  build: (orgSlug: string | null) => OrgNotification
): Promise<void> {
  const adminIds = await getOrgAdminUserIds(orgId);
  if (adminIds.length === 0) return;

  const orgSlug = await getOrgSlug(orgId);
  await sendNotification(orgId, adminIds, build(orgSlug));
}

export async function notifyActionApprovalNeeded(params: {
  orgId: string;
  runId: number;
  actionKey: string;
  connectionName?: string;
  eventId?: number;
  approvalUrl?: string;
}): Promise<void> {
  await notifyOrgAdmins(params.orgId, (orgSlug) => {
    const connLabel = params.connectionName ? ` on ${params.connectionName}` : '';
    const resourceUrl =
      params.eventId && orgSlug
        ? `/${orgSlug}/events/${params.eventId}`
        : orgSlug
          ? `/${orgSlug}/events?run=${params.runId}`
          : undefined;
    const urlLine = params.approvalUrl ? `\n\nReview: ${params.approvalUrl}` : '';
    return {
      type: 'action_approval_needed',
      title: `Action "${params.actionKey}" needs approval`,
      body: `A queued action${connLabel} is waiting for your review.${urlLine}`,
      resourceType: 'event',
      resourceId: params.eventId ? String(params.eventId) : String(params.runId),
      resourceUrl,
    };
  });
}

export async function notifyConnectionPermissionRequest(params: {
  orgId: string;
  connectionId: number;
  connectorKey: string;
  connectUrl?: string;
}): Promise<void> {
  await notifyOrgAdmins(params.orgId, (orgSlug) => {
    const urlLine = params.connectUrl ? `\n\nAuthorize: ${params.connectUrl}` : '';
    return {
      type: 'connection_permission_request',
      title: `Connection "${params.connectorKey}" needs authorization`,
      body: `A new connection was created and requires OAuth authorization.${urlLine}`,
      resourceType: 'connection',
      resourceId: String(params.connectionId),
      resourceUrl: orgSlug ? `/${orgSlug}/connections` : undefined,
    };
  });
}

export async function notifyBrowserAuthExpired(params: {
  orgId: string;
  connectionId: number;
  connectorKey: string;
  /**
   * Set for connectors that store a `browser_session` auth profile (the CLI /
   * Mac browser-auth capture flow). Omitted for extension-scrape connectors
   * (e.g. Revolut, LinkedIn) that reuse the live browser session and have no
   * stored auth profile — those just need the user to re-login on the site.
   */
  authProfileSlug?: string | null;
}): Promise<void> {
  await notifyOrgAdmins(params.orgId, (orgSlug) => ({
    type: 'browser_auth_expired',
    title: `${params.connectorKey} needs sign-in`,
    body: params.authProfileSlug
      ? 'Session needs re-authentication.\n' +
        'Enable remote debugging in Chrome: chrome://inspect/#remote-debugging\n' +
        `Or run: lobu memory browser-auth --connector ${params.connectorKey} --auth-profile-slug ${params.authProfileSlug}`
      : `Your ${params.connectorKey} session has expired, so syncing has stopped. ` +
        `Open ${params.connectorKey} in the browser where your Owletto extension runs and sign in to resume.`,
    resourceType: 'connection',
    resourceId: String(params.connectionId),
    resourceUrl: orgSlug ? `/${orgSlug}/connectors` : undefined,
  }));
}

export async function notifyInvitationReceived(params: {
  orgId: string;
  userId: string;
  orgName: string;
  inviterName?: string;
}): Promise<void> {
  const inviterLabel = params.inviterName ? ` by ${params.inviterName}` : '';
  await sendNotification(params.orgId, [params.userId], {
    type: 'invitation_received',
    title: `You've been invited to ${params.orgName}`,
    body: `You were invited${inviterLabel} to join the organization.`,
    resourceType: 'organization',
    resourceId: params.orgId,
  });
}

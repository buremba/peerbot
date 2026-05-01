import { getDb } from '../db/client';
import { emit } from '../events/emitter';
import { createNotificationForUsers } from './service';

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

export async function notifyActionApprovalNeeded(params: {
  orgId: string;
  runId: number;
  actionKey: string;
  connectionName?: string;
  eventId?: number;
  approvalUrl?: string;
}): Promise<void> {
  const adminIds = await getOrgAdminUserIds(params.orgId);
  if (adminIds.length === 0) return;

  const orgSlug = await getOrgSlug(params.orgId);
  const connLabel = params.connectionName ? ` on ${params.connectionName}` : '';
  const resourceUrl =
    params.eventId && orgSlug
      ? `/${orgSlug}/events/${params.eventId}`
      : orgSlug
        ? `/${orgSlug}/events?run=${params.runId}`
        : undefined;
  const urlLine = params.approvalUrl ? `\n\nReview: ${params.approvalUrl}` : '';
  await createNotificationForUsers(adminIds, {
    organizationId: params.orgId,
    type: 'action_approval_needed',
    title: `Action "${params.actionKey}" needs approval`,
    body: `A queued action${connLabel} is waiting for your review.${urlLine}`,
    resourceType: 'event',
    resourceId: params.eventId ? String(params.eventId) : String(params.runId),
    resourceUrl,
  });
  emit(params.orgId, { keys: ['notifications', 'notifications-unread-count'] });
}

export async function notifyConnectionPermissionRequest(params: {
  orgId: string;
  connectionId: number;
  connectorKey: string;
  connectUrl?: string;
}): Promise<void> {
  const adminIds = await getOrgAdminUserIds(params.orgId);
  if (adminIds.length === 0) return;

  const orgSlug = await getOrgSlug(params.orgId);
  const urlLine = params.connectUrl ? `\n\nAuthorize: ${params.connectUrl}` : '';
  await createNotificationForUsers(adminIds, {
    organizationId: params.orgId,
    type: 'connection_permission_request',
    title: `Connection "${params.connectorKey}" needs authorization`,
    body: `A new connection was created and requires OAuth authorization.${urlLine}`,
    resourceType: 'connection',
    resourceId: String(params.connectionId),
    resourceUrl: orgSlug ? `/${orgSlug}/connections` : undefined,
  });
  emit(params.orgId, { keys: ['notifications', 'notifications-unread-count'] });
}

export async function notifyBrowserAuthExpired(params: {
  orgId: string;
  connectionId: number;
  connectorKey: string;
  authProfileSlug: string;
}): Promise<void> {
  const adminIds = await getOrgAdminUserIds(params.orgId);
  if (adminIds.length === 0) return;

  const orgSlug = await getOrgSlug(params.orgId);
  await createNotificationForUsers(adminIds, {
    organizationId: params.orgId,
    type: 'browser_auth_expired',
    title: `Browser auth expired for ${params.connectorKey}`,
    body:
      'Session needs re-authentication.\n' +
      'Enable remote debugging in Chrome: chrome://inspect/#remote-debugging\n' +
      `Or run: lobu memory browser-auth --connector ${params.connectorKey} --auth-profile-slug ${params.authProfileSlug}`,
    resourceType: 'connection',
    resourceId: String(params.connectionId),
    resourceUrl: orgSlug ? `/${orgSlug}/connectors` : undefined,
  });
  emit(params.orgId, { keys: ['notifications', 'notifications-unread-count'] });
}

export async function notifyInvitationReceived(params: {
  orgId: string;
  userId: string;
  orgName: string;
  inviterName?: string;
}): Promise<void> {
  const inviterLabel = params.inviterName ? ` by ${params.inviterName}` : '';
  await createNotificationForUsers([params.userId], {
    organizationId: params.orgId,
    type: 'invitation_received',
    title: `You've been invited to ${params.orgName}`,
    body: `You were invited${inviterLabel} to join the organization.`,
    resourceType: 'organization',
    resourceId: params.orgId,
  });
  emit(params.orgId, { keys: ['notifications', 'notifications-unread-count'] });
}

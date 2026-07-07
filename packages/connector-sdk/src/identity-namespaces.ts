/**
 * Canonical identity namespace registry.
 *
 * This is the shared contract between connectors, the identity engine, and
 * read-time attribution/search. Adding a connector identity namespace should be
 * a registry change first, then an index/config migration if the namespace is
 * intended to participate in event recall.
 */

export type IdentityNormalizerKind =
  | 'email'
  | 'phone'
  | 'wa_jid'
  | 'slack_user_id'
  | 'numeric_id'
  | 'auth_user_id'
  | 'x_handle'
  | 'trim';

export type IdentitySubjectKind = 'person' | 'member' | 'resource' | 'account';

export interface IdentityNamespaceDefinition {
  /** Stable namespace stored in entity_identities.namespace and fact metadata. */
  namespace: string;
  /** What kind of real-world thing this namespace identifies most commonly. */
  subjectKind: IdentitySubjectKind;
  /** Normalizer dispatch key. */
  normalizer: IdentityNormalizerKind;
  /** Whether read-time event recall may JOIN on events.metadata[namespace]. */
  eventRecallIndexed: boolean;
  /** Human-review hint: true means a value should identify at most one entity per org. */
  uniquePerOrg: boolean;
  /** Human-readable notes for connector authors and migration reviewers. */
  notes?: string;
}

export const IDENTITY = {
  PHONE: 'phone',
  EMAIL: 'email',
  WA_JID: 'wa_jid',
  SLACK_USER_ID: 'slack_user_id',
  SLACK_CHANNEL_ID: 'slack_channel_id',
  GITHUB_LOGIN: 'github_login',
  GITHUB_USER_ID: 'github_user_id',
  GITHUB_REPO_ID: 'github_repo_id',
  GITHUB_REPO_FULL_NAME: 'github_repo_full_name',
  AUTH_USER_ID: 'auth_user_id',
  GOOGLE_CONTACT_ID: 'google_contact_id',
  X_USER_ID: 'x_user_id',
  X_HANDLE: 'x_handle',
} as const;

export type IdentityNamespace = (typeof IDENTITY)[keyof typeof IDENTITY];

export const IDENTITY_NAMESPACE_REGISTRY = [
  {
    namespace: IDENTITY.EMAIL,
    subjectKind: 'person',
    normalizer: 'email',
    eventRecallIndexed: true,
    uniquePerOrg: true,
  },
  {
    namespace: IDENTITY.PHONE,
    subjectKind: 'person',
    normalizer: 'phone',
    eventRecallIndexed: true,
    uniquePerOrg: true,
  },
  {
    namespace: IDENTITY.WA_JID,
    subjectKind: 'person',
    normalizer: 'trim',
    eventRecallIndexed: true,
    uniquePerOrg: true,
    notes: 'Legacy recall namespace: preserve trim-only dispatch until existing rows are backfilled.',
  },
  {
    namespace: IDENTITY.SLACK_USER_ID,
    subjectKind: 'person',
    normalizer: 'trim',
    eventRecallIndexed: true,
    uniquePerOrg: true,
    notes:
      'Workspace-scoped form T…:U…; bare Slack user ids are unsafe. Legacy recall namespace: preserve trim-only dispatch until existing rows are backfilled.',
  },
  {
    namespace: IDENTITY.GITHUB_LOGIN,
    subjectKind: 'person',
    normalizer: 'trim',
    eventRecallIndexed: true,
    uniquePerOrg: false,
    notes:
      'Mutable/reusable; prefer github_user_id as the primary identity. Legacy recall namespace: preserve trim-only dispatch until existing rows are backfilled.',
  },
  {
    namespace: IDENTITY.GITHUB_USER_ID,
    subjectKind: 'person',
    normalizer: 'trim',
    eventRecallIndexed: true,
    uniquePerOrg: true,
    notes: 'Legacy recall namespace: preserve trim-only dispatch until existing rows are backfilled.',
  },
  {
    namespace: IDENTITY.AUTH_USER_ID,
    subjectKind: 'account',
    normalizer: 'auth_user_id',
    eventRecallIndexed: true,
    uniquePerOrg: true,
  },
  {
    namespace: IDENTITY.GOOGLE_CONTACT_ID,
    subjectKind: 'person',
    normalizer: 'trim',
    eventRecallIndexed: true,
    uniquePerOrg: true,
  },
  {
    namespace: IDENTITY.X_USER_ID,
    subjectKind: 'person',
    normalizer: 'numeric_id',
    eventRecallIndexed: true,
    uniquePerOrg: true,
    notes: 'Immutable X/Twitter user id; primary namespace for X author/DM attribution.',
  },
  {
    namespace: IDENTITY.X_HANDLE,
    subjectKind: 'person',
    normalizer: 'x_handle',
    eventRecallIndexed: false,
    uniquePerOrg: false,
    notes: 'Mutable/reusable; useful as a secondary claim but not recall-indexed by default.',
  },
  {
    namespace: IDENTITY.GITHUB_REPO_ID,
    subjectKind: 'resource',
    normalizer: 'trim',
    eventRecallIndexed: false,
    uniquePerOrg: true,
    notes: 'Legacy namespace: preserve trim-only dispatch until existing rows are backfilled.',
  },
  {
    namespace: IDENTITY.GITHUB_REPO_FULL_NAME,
    subjectKind: 'resource',
    normalizer: 'trim',
    eventRecallIndexed: false,
    uniquePerOrg: true,
    notes: 'Legacy namespace: preserve trim-only dispatch until existing rows are backfilled.',
  },
  {
    namespace: IDENTITY.SLACK_CHANNEL_ID,
    subjectKind: 'resource',
    normalizer: 'trim',
    eventRecallIndexed: false,
    uniquePerOrg: true,
  },
] as const satisfies readonly IdentityNamespaceDefinition[];

export const EVENT_RECALL_IDENTITY_NAMESPACES: readonly string[] = IDENTITY_NAMESPACE_REGISTRY.filter(
  (def) => def.eventRecallIndexed
).map((def) => def.namespace);

export function getIdentityNamespaceDefinition(
  namespace: string
): IdentityNamespaceDefinition | undefined {
  return IDENTITY_NAMESPACE_REGISTRY.find((def) => def.namespace === namespace);
}

export function isEventRecallIdentityNamespace(namespace: string): boolean {
  return EVENT_RECALL_IDENTITY_NAMESPACES.includes(namespace);
}

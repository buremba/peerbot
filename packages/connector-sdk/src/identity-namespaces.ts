/**
 * Canonical registry of GENERIC identity namespaces.
 *
 * These namespaces are provider-agnostic — every connector may produce them and
 * core code understands them directly: `email`, `email_domain`, `phone`,
 * `auth_user_id`. Connector-SPECIFIC namespaces (slack_user_id, github_login,
 * x_user_id, …) do NOT live here — each connector owns its own namespace
 * constants + normalizers in its package (`@lobu/connectors/<key>-identity`),
 * and the server assembles them (see
 * server/src/identity/connector-identity-modules.ts). This keeps core code free
 * of any specific connector's vocabulary so connectors can iterate independently.
 */

export type IdentityNormalizerKind =
  | 'email'
  | 'email_domain'
  | 'phone'
  | 'auth_user_id'
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
  EMAIL_DOMAIN: 'email_domain',
  AUTH_USER_ID: 'auth_user_id',
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
    namespace: IDENTITY.EMAIL_DOMAIN,
    subjectKind: 'person',
    normalizer: 'email_domain',
    eventRecallIndexed: false,
    uniquePerOrg: false,
    notes:
      "Derived from the person's email fact (the part after @); the engine emits it, connectors never supply it directly. Many people share a domain (not unique-per-org) and it isn't a recall key — its sole job is powering domain-keyed auto_create_when rules (e.g. works_at → company.domain).",
  },
  {
    namespace: IDENTITY.PHONE,
    subjectKind: 'person',
    normalizer: 'phone',
    eventRecallIndexed: true,
    uniquePerOrg: true,
  },
  {
    namespace: IDENTITY.AUTH_USER_ID,
    subjectKind: 'account',
    normalizer: 'auth_user_id',
    eventRecallIndexed: true,
    uniquePerOrg: true,
  },
] as const satisfies readonly IdentityNamespaceDefinition[];

/**
 * The GENERIC event-recall namespaces. Connector-owned recall namespaces
 * (slack_user_id, github_login, github_user_id, x_user_id) are contributed
 * separately by each connector module and combined server-side — see
 * server/src/identity/connector-identity-modules.ts.
 */
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

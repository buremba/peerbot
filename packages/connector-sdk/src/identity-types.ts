/**
 * Identity-engine SDK contracts.
 *
 * Connectors emit `ConnectorFact[]` for the authenticated subject; catalog
 * YAMLs declare `AutoCreateWhenRule[]` on relationship types; the engine
 * matches facts against rules and writes derivations.
 *
 * Schemas are TypeBox so they double as runtime validators at every write
 * boundary (seeder, engine, MCP tools). Validation is mandatory — the
 * collapsed model puts a lot in `metadata jsonb`, so without validation the
 * engine silently corrupts on malformed input.
 */

import { Type, type Static } from '@sinclair/typebox';

// =============================================================================
// Assurance levels
// =============================================================================

/**
 * How strongly the connector vouches for a fact. Rules require a minimum
 * assurance to fire. The order is total: `oauth_verified_admin_role` >
 * `oauth_verified` > `cookie_session` > `self_attested`.
 */
export const AssuranceLevel = Type.Union(
  [
    Type.Literal('oauth_verified_admin_role'),
    Type.Literal('oauth_verified'),
    Type.Literal('cookie_session'),
    Type.Literal('self_attested'),
  ],
  { $id: 'AssuranceLevel' }
);
export type AssuranceLevel = Static<typeof AssuranceLevel>;

const ASSURANCE_RANK: Record<AssuranceLevel, number> = {
  oauth_verified_admin_role: 4,
  oauth_verified: 3,
  cookie_session: 2,
  self_attested: 1,
};

export function assuranceMeets(actual: AssuranceLevel, required: AssuranceLevel): boolean {
  return ASSURANCE_RANK[actual] >= ASSURANCE_RANK[required];
}

// =============================================================================
// ConnectorFact — what a connector emits
// =============================================================================

export const ConnectorFact = Type.Object(
  {
    /** The attribute kind. Each connector declares which namespaces it produces. */
    namespace: Type.String({ minLength: 1, maxLength: 64 }),
    /** Raw value as the provider returned it. Audit-friendly. */
    identifier: Type.String({ minLength: 1, maxLength: 1024 }),
    /**
     * Canonicalised form used for index lookups. Connectors run normalize* on
     * the value before emitting; the engine re-normalises defensively.
     */
    normalizedValue: Type.String({ minLength: 1, maxLength: 1024 }),
    /** How the connector verified this fact. */
    assurance: AssuranceLevel,
    /**
     * Provider's immutable account identifier — the primary binding key
     * that survives email changes and account-row reissues.
     */
    providerStableId: Type.String({ minLength: 1, maxLength: 256 }),
    /**
     * Which connector account row produced this fact. Lets the engine diff
     * facts per session for revocation.
     */
    sourceAccountId: Type.String({ minLength: 1, maxLength: 256 }),
    /** ISO-8601 timestamp. Optional; required for high-assurance facts in production. */
    validTo: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    /**
     * Optional human-readable note about trust caveats this fact carries.
     * Surfaced in audit logs and admin UIs; never used by the engine.
     */
    notes: Type.Optional(Type.String({ maxLength: 512 })),
  },
  { $id: 'ConnectorFact', additionalProperties: false }
);
export type ConnectorFact = Static<typeof ConnectorFact>;

// =============================================================================
// ConnectorIdentityCapability — what a connector promises to emit
// =============================================================================

/**
 * Each connector exports a static capability declaration. CI lints that the
 * namespaces it actually emits at runtime are a subset of `produces`.
 */
export const ConnectorIdentityCapability = Type.Object(
  {
    connectorKey: Type.String({ minLength: 1, maxLength: 64 }),
    produces: Type.Array(
      Type.Object({
        namespace: Type.String({ minLength: 1, maxLength: 64 }),
        assurance: AssuranceLevel,
        notes: Type.Optional(Type.String({ maxLength: 512 })),
      }),
      { minItems: 0, maxItems: 32 }
    ),
  },
  { $id: 'ConnectorIdentityCapability', additionalProperties: false }
);
export type ConnectorIdentityCapability = Static<typeof ConnectorIdentityCapability>;

// =============================================================================
// AutoCreateWhenRule — declared on relationship-type YAMLs, compiled into
// entity_relationship_types.metadata.auto_create_when[]
// =============================================================================

/**
 * `unique_only` rejects ambiguity (writes a collision event for admin
 * resolution); `all_matches` fans out to every match and is only safe for
 * weak relationships. `first_match` is deliberately excluded — silently
 * picking a winner on collision would open adoption-takeover paths.
 */
export const MatchStrategy = Type.Union(
  [Type.Literal('unique_only'), Type.Literal('all_matches')],
  { $id: 'MatchStrategy' }
);
export type MatchStrategy = Static<typeof MatchStrategy>;

export const AutoCreateWhenRule = Type.Object(
  {
    /** The fact namespace this rule listens for. */
    sourceNamespace: Type.String({ minLength: 1, maxLength: 64 }),
    /**
     * The metadata field on the target entity-type whose normalized value
     * must equal the fact's normalizedValue.
     */
    targetField: Type.String({ minLength: 1, maxLength: 64 }),
    /**
     * Minimum assurance the fact must carry to fire this rule. The engine
     * enforces `assuranceMeets(fact.assurance, rule.assuranceRequired)`.
     */
    assuranceRequired: AssuranceLevel,
    matchStrategy: MatchStrategy,
    /**
     * Optional notes for review tooling — not consumed by the engine.
     */
    notes: Type.Optional(Type.String({ maxLength: 512 })),
  },
  { $id: 'AutoCreateWhenRule', additionalProperties: false }
);
export type AutoCreateWhenRule = Static<typeof AutoCreateWhenRule>;

/**
 * The shape stored on `entity_relationship_types.metadata`. Includes the
 * declared rules plus a version+hash so derivations can pin to the rule
 * version that fired them and reconciliation can detect drift.
 */
export const RelationshipTypeIdentityMetadata = Type.Object(
  {
    autoCreateWhen: Type.Array(AutoCreateWhenRule, { maxItems: 16 }),
    /** Monotonically increasing per relationship-type. Bumped by the seeder on every YAML change. */
    ruleVersion: Type.Integer({ minimum: 1 }),
    /** sha256 of the canonicalised auto_create_when array. Drift detection. */
    ruleHash: Type.String({ minLength: 64, maxLength: 64 }),
  },
  { $id: 'RelationshipTypeIdentityMetadata', additionalProperties: true }
);
export type RelationshipTypeIdentityMetadata = Static<typeof RelationshipTypeIdentityMetadata>;

// =============================================================================
// Fact event metadata — written into events.metadata when the engine
// persists a connector fact as `semantic_type='identity_fact'`
// =============================================================================

/**
 * Stored on `events.metadata` for `semantic_type='identity_fact'` rows.
 *
 * Tombstone facts (written when a connector refresh stops emitting a
 * namespace) carry empty `identifier`/`normalizedValue`/`providerStableId`,
 * which is why those fields allow empty strings here even though
 * `ConnectorFact` (the connector-side input) requires non-empty.
 */
export const FactEventMetadata = Type.Object(
  {
    namespace: Type.String({ minLength: 1, maxLength: 64 }),
    identifier: Type.String({ minLength: 0, maxLength: 1024 }),
    normalizedValue: Type.String({ minLength: 0, maxLength: 1024 }),
    assurance: AssuranceLevel,
    providerStableId: Type.String({ minLength: 0, maxLength: 256 }),
    sourceAccountId: Type.String({ minLength: 1, maxLength: 256 }),
    /** ISO-8601 timestamp string. Optional; required for high-assurance facts in production. */
    validTo: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
    notes: Type.Optional(Type.String({ maxLength: 512 })),
  },
  { $id: 'FactEventMetadata', additionalProperties: false }
);
export type FactEventMetadata = Static<typeof FactEventMetadata>;

// =============================================================================
// DerivedFromProvenance — written into entity_relationships.metadata when
// the engine auto-creates a relationship
// =============================================================================

export const DerivedFromProvenance = Type.Object(
  {
    /** events.id of the fact that produced this derivation. */
    sourceEventId: Type.Integer({ minimum: 1 }),
    /** Which relationship-type rule fired (entity_relationship_types.id). */
    relationshipTypeId: Type.Integer({ minimum: 1 }),
    /** Snapshot of the rule version that fired. Drift signal for reconcile. */
    ruleVersion: Type.Integer({ minimum: 1 }),
    /** Hash matching ruleHash on the relationship-type at fire time. */
    ruleHash: Type.String({ minLength: 64, maxLength: 64 }),
    /** Echoed for fast assurance audits without joining back to the event. */
    factAssurance: AssuranceLevel,
    /** ISO-8601 timestamp. Echoes events.created_at; convenience for relationship-only audits. */
    derivedAt: Type.String({ minLength: 1, maxLength: 64 }),
  },
  { $id: 'DerivedFromProvenance', additionalProperties: false }
);
export type DerivedFromProvenance = Static<typeof DerivedFromProvenance>;

/**
 * The metadata blob stored on entity_relationships.metadata for derived
 * rows. Closed shape — extra keys are rejected so the engine can never
 * accidentally land junk alongside the provenance.
 */
export const DerivedRelationshipMetadata = Type.Object(
  {
    derivedFrom: DerivedFromProvenance,
  },
  { $id: 'DerivedRelationshipMetadata', additionalProperties: false }
);
export type DerivedRelationshipMetadata = Static<typeof DerivedRelationshipMetadata>;

// =============================================================================
// ClaimCollision — pending-approval event payload
// =============================================================================

/**
 * When a fact match would adopt a `$member` row that's already bound to a
 * different user (or vice versa), the engine writes a pending-approval event
 * with this shape. Resolution = a privileged user flips
 * `interaction_status='approved'` after merging entities, or 'rejected' to
 * dismiss without action.
 */
export const ClaimCollisionPayload = Type.Object(
  {
    kind: Type.Literal('identity_match'),
    namespace: Type.String({ minLength: 1, maxLength: 64 }),
    identifier: Type.String({ minLength: 1, maxLength: 1024 }),
    normalizedValue: Type.String({ minLength: 1, maxLength: 1024 }),
    /**
     * Catalog entity ids that all match this fact's normalized value.
     * Despite the historical name suggesting `$member`, these are general
     * catalog entities (founders, companies, etc.) — the resolver picks
     * which one the user intends to claim.
     */
    candidateEntityIds: Type.Array(Type.Integer({ minimum: 1 }), {
      minItems: 2,
      maxItems: 16,
    }),
    /** Total number of matching candidates; candidateEntityIds may be capped for UI payload size. */
    candidateCount: Type.Optional(Type.Integer({ minimum: 2 })),
    /**
     * Which fact (events.id) raised the collision. Lets the resolver replay
     * the binding once the human picks a winner.
     */
    triggeringEventId: Type.Integer({ minimum: 1 }),
    /** Rule that would have fired if the match were unambiguous. */
    relationshipTypeId: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { $id: 'ClaimCollisionPayload', additionalProperties: false }
);
export type ClaimCollisionPayload = Static<typeof ClaimCollisionPayload>;

// =============================================================================
// Constants — used by core code AND connector tests so the lint check has
// a single source of truth.
// =============================================================================

export const IDENTITY_FACT_SEMANTIC_TYPE = 'identity_fact' as const;
export const CLAIM_COLLISION_SEMANTIC_TYPE = 'claim_collision' as const;

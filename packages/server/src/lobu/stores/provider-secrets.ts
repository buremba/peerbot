/**
 * Org-shared provider credentials live in `agent_secrets` under a documented
 * naming convention so the worker's credential-resolution path and `lobu apply`
 * agree on where to read/write the same row.
 *
 * Resolution order (worker side, see base-provider-module.ts):
 *   1. Per-user `auth_profiles` (BYOK / personal OAuth)
 *   2. Org-shared `agent_secrets` row (this name) — declarative, set via
 *      `lobu apply` from `[[agents.<id>.providers]] key = "$VAR"`
 *   3. Deployment-wide `process.env` (operator's machine, last resort)
 *
 * The org-scoping is enforced by `(organization_id, name)` PK on the table;
 * no per-agent override exists today (the same key is used by every agent in
 * the org that calls this provider).
 */

import {
	createLogger,
	decrypt,
	encrypt,
	getErrorMessage,
} from "@lobu/core";
import { getDb } from "../../db/client.js";

const logger = createLogger("provider-secrets");

// ── Inference providers (org-owned per-modality custom upstreams) ─────────────
//
// One row per named provider credential for an org (see
// db/migrations/20260702170000_inference_providers.sql — the DDL is the
// contract). ONE api_key per row (no per-modality key): a row with any custom
// base_url is org-key-only across every modality it serves. `capabilities` is
// per-modality config `{ "<modality>": { base_url?, model?, models_endpoint? } }`.
//
// The api key lives in `agent_secrets` under a ROW-UNIQUE name `<slug>-<id>`
// (embedded in `api_key_ref = secret://<org>/<slug>-<id>`), so a
// soft-delete→recreate never inherits a deleted row's ciphertext (the TOTAL
// keyref unique index keeps the name reserved even after soft-delete).

export type InferenceModality = "text" | "image" | "stt" | "tts";

export const INFERENCE_MODALITIES: ReadonlySet<InferenceModality> = new Set([
	"text",
	"image",
	"stt",
	"tts",
]);

/** Type guard: is `m` a known inference modality? */
export function isInferenceModality(m: string): m is InferenceModality {
	return INFERENCE_MODALITIES.has(m as InferenceModality);
}

/**
 * Canonical provider-slug shape. MUST match the DB CHECK
 * (`inference_providers_slug_format`) and the CLI (map-config
 * ORG_PROVIDER_SLUG_PATTERN) EXACTLY: lowercase alphanumeric + hyphen, 1-63
 * chars, no leading/trailing hyphen. Validated server-side so a bad slug is a
 * clean 400 instead of a raw DB CHECK-violation 500.
 */
export const INFERENCE_PROVIDER_SLUG_PATTERN =
	/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** Is `slug` a valid inference-provider slug (see INFERENCE_PROVIDER_SLUG_PATTERN)? */
export function isValidInferenceProviderSlug(slug: string): boolean {
	return INFERENCE_PROVIDER_SLUG_PATTERN.test(slug);
}

const ALLOWED_CAPABILITY_KEYS: ReadonlySet<string> = new Set([
	"base_url",
	"model",
	"models_endpoint",
]);

/**
 * Row-unique vault name for one inference-provider credential:
 * `<slug>-<id>`. Embedded in `api_key_ref = secret://<org>/<slug>-<id>`.
 * Org-scoping is enforced by the `(organization_id, name)` PK on
 * `agent_secrets`; the `<id>` suffix makes the name unique per row so a
 * recreate after soft-delete gets a fresh, un-poisoned ciphertext slot.
 */
export function inferenceProviderSecretName(
	slug: string,
	id: number | string,
): string {
	return `${slug}-${id}`;
}

export interface InferenceCapabilityBlock {
	base_url?: string;
	model?: string;
	models_endpoint?: string;
}

export type InferenceCapabilities = Partial<
	Record<InferenceModality, InferenceCapabilityBlock>
>;

export interface InferenceProviderListItem {
	id: number;
	slug: string;
	kind: string;
	displayName: string | null;
	capabilities: InferenceCapabilities;
	hasCustomUpstream: boolean;
	status: string;
	createdAt: string;
	/** This row is the org's default inference provider (the model-resolution tail). */
	isDefault: boolean;
}

export interface InferenceProviderRow {
	id: number;
	organizationId: string;
	slug: string;
	kind: string;
	displayName: string | null;
	apiKeyRef: string;
	capabilities: InferenceCapabilities;
	hasCustomUpstream: boolean;
	status: string;
	createdAt: string;
}

/** Typed error returned (not thrown) when a live slug already exists for the org. */
export interface InferenceProviderSlugConflict {
	error: "slug_conflict";
	slug: string;
}

/**
 * Validate one modality capability block before it is persisted. The DB CHECKs
 * are an unconditional floor; this is the full app-layer guard — every
 * capabilities write MUST pass through it. Returns an error string, or null
 * when the block is valid.
 *
 * Rules:
 *   - base_url (if present): must be https:// (no http), no userinfo (`@`
 *     before host), no query/hash, and must parse as a URL.
 *   - models_endpoint (if present): `^/[A-Za-z0-9/_.-]*$` and NOT `//`-prefixed
 *     (identical to the DB CHECK — belt and braces).
 *   - model (if present): non-empty string.
 *   - no unknown keys (only base_url / model / models_endpoint).
 */
export function validateCapabilityBlock(
	modality: string,
	block: unknown,
): string | null {
	if (!isInferenceModality(modality)) {
		return `Unknown modality '${modality}' (expected text|image|stt|tts)`;
	}
	if (typeof block !== "object" || block === null || Array.isArray(block)) {
		return `capabilities.${modality} must be an object`;
	}
	const b = block as Record<string, unknown>;

	for (const key of Object.keys(b)) {
		if (!ALLOWED_CAPABILITY_KEYS.has(key)) {
			return `capabilities.${modality}.${key} is not an allowed field (base_url|model|models_endpoint)`;
		}
	}

	if (b.base_url !== undefined && b.base_url !== null) {
		if (typeof b.base_url !== "string" || b.base_url.trim() === "") {
			return `capabilities.${modality}.base_url must be a non-empty string`;
		}
		let url: URL;
		try {
			url = new URL(b.base_url);
		} catch {
			return `capabilities.${modality}.base_url is not a valid URL`;
		}
		if (url.protocol !== "https:") {
			return `capabilities.${modality}.base_url must be https://`;
		}
		if (url.username !== "" || url.password !== "") {
			return `capabilities.${modality}.base_url must not contain userinfo (user:pass@)`;
		}
		if (url.search !== "" || url.hash !== "") {
			return `capabilities.${modality}.base_url must not contain a query string or fragment`;
		}
		if (url.hostname === "") {
			return `capabilities.${modality}.base_url must have a host`;
		}
	}

	if (b.models_endpoint !== undefined && b.models_endpoint !== null) {
		if (typeof b.models_endpoint !== "string") {
			return `capabilities.${modality}.models_endpoint must be a string`;
		}
		if (
			!/^\/[A-Za-z0-9/_.-]*$/.test(b.models_endpoint) ||
			b.models_endpoint.startsWith("//")
		) {
			return `capabilities.${modality}.models_endpoint must be a relative path (^/[A-Za-z0-9/_.-]*$, not //-prefixed)`;
		}
	}

	if (b.model !== undefined && b.model !== null) {
		if (typeof b.model !== "string" || b.model.trim() === "") {
			return `capabilities.${modality}.model must be a non-empty string`;
		}
	}

	return null;
}

/**
 * Drop null/undefined-valued fields from a capability block (canonicalize)
 * before merging into `capabilities`, so a `{ base_url: null }` write clears
 * nothing and never persists a null. Returns a fresh object.
 */
function canonicalizeCapabilityBlock(
	block: InferenceCapabilityBlock,
): InferenceCapabilityBlock {
	const out: InferenceCapabilityBlock = {};
	for (const key of ALLOWED_CAPABILITY_KEYS) {
		const v = (block as Record<string, unknown>)[key];
		if (v !== undefined && v !== null) {
			(out as Record<string, unknown>)[key] = v;
		}
	}
	return out;
}

interface RawInferenceProviderRow {
	id: string | number;
	organization_id: string;
	slug: string;
	kind: string;
	display_name: string | null;
	api_key_ref: string;
	capabilities: InferenceCapabilities;
	has_custom_upstream: boolean;
	status: string;
	created_at: string | Date;
	is_default: boolean;
}

function mapRow(r: RawInferenceProviderRow): InferenceProviderRow {
	return {
		id: Number(r.id),
		organizationId: r.organization_id,
		slug: r.slug,
		kind: r.kind,
		displayName: r.display_name,
		apiKeyRef: r.api_key_ref,
		capabilities: r.capabilities ?? {},
		hasCustomUpstream: r.has_custom_upstream,
		status: r.status,
		createdAt:
			r.created_at instanceof Date
				? r.created_at.toISOString()
				: String(r.created_at),
	};
}

/**
 * Create one inference-provider credential for an org. Atomic: a single
 * transaction (a) mints the row id via the identity sequence, (b) derives the
 * row-unique `api_key_ref = secret://<org>/<slug>-<id>`, (c) INSERTs the row
 * with the explicit id, and (d) encrypts the api key into `agent_secrets` under
 * `<slug>-<id>`. On a live slug collision returns a typed
 * `{ error: 'slug_conflict' }` rather than throwing.
 */
export async function createInferenceProvider(args: {
	organizationId: string;
	slug: string;
	kind: string;
	displayName?: string | null;
	apiKey: string;
	capabilities?: InferenceCapabilities;
	createdBy?: string | null;
}): Promise<InferenceProviderRow | InferenceProviderSlugConflict> {
	const {
		organizationId,
		slug,
		kind,
		displayName = null,
		apiKey,
		capabilities = {},
		createdBy = null,
	} = args;

	const sql = getDb();
	const ciphertext = encrypt(apiKey);

	try {
		return await sql.begin(async (tx) => {
			// Mint the id up front so it can be embedded in api_key_ref BEFORE the
			// INSERT (BY DEFAULT identity allows the explicit id; see migration).
			const idRows = (await tx`
				SELECT nextval(pg_get_serial_sequence('inference_providers', 'id')) AS id
			`) as Array<{ id: string | number }>;
			const id = Number(idRows[0]?.id);
			const secretName = inferenceProviderSecretName(slug, id);
			const apiKeyRef = `secret://${organizationId}/${secretName}`;

			const rows = (await tx`
				INSERT INTO inference_providers
					(id, organization_id, slug, kind, display_name, api_key_ref, capabilities, created_by)
				VALUES (
					${id}, ${organizationId}, ${slug}, ${kind}, ${displayName},
					${apiKeyRef}, ${sql.json(capabilities)}, ${createdBy}
				)
				RETURNING id, organization_id, slug, kind, display_name, api_key_ref,
				          capabilities, has_custom_upstream, status, created_at
			`) as RawInferenceProviderRow[];

			// Encrypt the key into the org vault under the row-unique name.
			await tx`
				INSERT INTO agent_secrets (organization_id, name, ciphertext, created_at, updated_at)
				VALUES (${organizationId}, ${secretName}, ${ciphertext}, now(), now())
				ON CONFLICT (organization_id, name)
				DO UPDATE SET ciphertext = EXCLUDED.ciphertext, updated_at = now()
			`;

			return mapRow(rows[0]);
		});
	} catch (error) {
		const msg = getErrorMessage(error);
		// Live-slug unique index (inference_providers_org_slug_live).
		if (
			/inference_providers_org_slug_live/.test(msg) ||
			/duplicate key/.test(msg)
		) {
			return { error: "slug_conflict", slug };
		}
		throw error;
	}
}

/**
 * List an org's live inference providers. NEVER returns the ciphertext / key or
 * the api_key_ref — this feeds the settings UI.
 */
export async function listInferenceProviders(
	organizationId: string,
): Promise<InferenceProviderListItem[]> {
	const sql = getDb();
	const rows = (await sql`
		SELECT id, slug, kind, display_name, capabilities, has_custom_upstream,
		       status, created_at, is_default
		FROM inference_providers
		WHERE organization_id = ${organizationId} AND deleted_at IS NULL
		ORDER BY slug
	`) as Array<
		Omit<RawInferenceProviderRow, "organization_id" | "api_key_ref">
	>;
	return rows.map((r) => ({
		id: Number(r.id),
		slug: r.slug,
		kind: r.kind,
		displayName: r.display_name,
		capabilities: r.capabilities ?? {},
		hasCustomUpstream: r.has_custom_upstream,
		status: r.status,
		createdAt:
			r.created_at instanceof Date
				? r.created_at.toISOString()
				: String(r.created_at),
		isDefault: r.is_default ?? false,
	}));
}

/**
 * The org's default model — the fallback tail of `behavior → agent → org`. Reads
 * the `is_default` inference-provider row and returns a ROUTABLE `slug/model`
 * ref built from the row's slug + text-modality model (`capabilities.text.model`),
 * or null when the org has no default (or the default row carries no text model).
 *
 * The `slug/` prefix is load-bearing: the worker derives the provider from a
 * model ref's first segment (`model-resolver.ts` auto path). A bare model like
 * `gpt-4o` throws "No provider specified" there, so an agent with no installed
 * providers (the exact case the org default exists to serve) could never route
 * a bare org default. Returning `openai/gpt-4o` lets the worker route it with no
 * installed-provider module. Callers fall through to the worker's hard "no model
 * resolved" error only when this is null.
 */
export async function getOrgDefaultModel(
	organizationId: string,
): Promise<string | null> {
	const sql = getDb();
	const rows = (await sql`
		SELECT slug, capabilities
		FROM inference_providers
		WHERE organization_id = ${organizationId}
		  AND is_default AND deleted_at IS NULL
		LIMIT 1
	`) as Array<{ slug: string; capabilities: InferenceCapabilities }>;
	const row = rows[0];
	const model = row?.capabilities?.text?.model?.trim();
	if (!model || !row?.slug) return null;
	// Prefix with the provider slug unless it's ALREADY prefixed with THIS
	// slug. Checking for a bare `/` is wrong: provider-native model ids often
	// contain slashes (openrouter `anthropic/claude-sonnet-5`, nvidia
	// `nvidia/moonshotai/kimi-k2.6`), and returning those bare would misroute
	// them to the wrong provider. Only `${slug}/…` is already routable.
	return model.startsWith(`${row.slug}/`) ? model : `${row.slug}/${model}`;
}

/**
 * Mark one live provider as the org default (clearing any prior default in the
 * same transaction). The partial unique index guarantees at most one live
 * default per org; clearing first keeps the switch atomic. Returns false when
 * the slug has no live row.
 */
export async function setInferenceProviderDefault(
	organizationId: string,
	slug: string,
): Promise<boolean> {
	const sql = getDb();
	return await sql.begin(async (tx) => {
		// Confirm the target exists BEFORE clearing the current default —
		// otherwise a missing slug would commit the clear and leave the org with
		// no default at all.
		const target = (await tx`
			SELECT id FROM inference_providers
			WHERE organization_id = ${organizationId}
			  AND slug = ${slug} AND deleted_at IS NULL
			LIMIT 1
		`) as Array<{ id: string | number }>;
		if (target.length === 0) return false;

		await tx`
			UPDATE inference_providers
			SET is_default = false, updated_at = now()
			WHERE organization_id = ${organizationId}
			  AND is_default AND deleted_at IS NULL
		`;
		await tx`
			UPDATE inference_providers
			SET is_default = true, updated_at = now()
			WHERE organization_id = ${organizationId}
			  AND slug = ${slug} AND deleted_at IS NULL
		`;
		return true;
	});
}

/**
 * Fetch one live provider row by slug (or null). Includes `apiKeyRef` — this is
 * an internal-caller accessor (the resolver needs the ref to read the key).
 */
export async function getInferenceProviderBySlug(
	organizationId: string,
	slug: string,
): Promise<InferenceProviderRow | null> {
	const sql = getDb();
	const rows = (await sql`
		SELECT id, organization_id, slug, kind, display_name, api_key_ref,
		       capabilities, has_custom_upstream, status, created_at
		FROM inference_providers
		WHERE organization_id = ${organizationId} AND slug = ${slug}
		  AND deleted_at IS NULL
		LIMIT 1
	`) as RawInferenceProviderRow[];
	const row = rows[0];
	return row ? mapRow(row) : null;
}

/**
 * Per-modality config resolved from an org's `inference_providers` row: the
 * modality's `base_url`/`model`/`models_endpoint` PLUS the row's decrypted key,
 * read in ONE query (row capabilities + ciphertext joined together). This is the
 * single source of truth for both consumers:
 *   - the capability services (image/stt/tts) — `null` ⇒ static fallback;
 *   - the credential chains via {@link resolveUrlInvariant} — which applies the
 *     text fail-closed policy on top.
 *
 * SINGLE READ: because capabilities and the ciphertext come from one row read,
 * the `base_url` a call is gated for and the key it sends cannot diverge (the
 * flip vector the URL invariant guards against). Two separate reads could.
 *
 * Returns `null` when there is no live row for `slug`, the row has no
 * `capabilities.<modality>` block, or the key is missing/undecryptable —
 * `hasKey` distinguishes the last case for callers that must fail closed.
 */
export interface ResolvedInferenceProviderConfig {
	baseUrl?: string;
	model?: string;
	modelsEndpoint?: string;
	/** The row's ONE decrypted api key. Absent only when missing/undecryptable. */
	apiKey?: string;
	/** capabilities.<modality>.base_url is present ⇒ this modality has a custom upstream. */
	custom: boolean;
}

export async function resolveInferenceProviderConfig(
	organizationId: string,
	slug: string,
	modality: InferenceModality,
): Promise<ResolvedInferenceProviderConfig | null> {
	const sql = getDb();
	const rows = (await sql`
		SELECT p.capabilities -> ${modality} AS block, s.ciphertext
		FROM inference_providers p
		LEFT JOIN agent_secrets s
		  ON s.organization_id = p.organization_id
		 AND ('secret://' || p.organization_id || '/' || s.name) = p.api_key_ref
		 AND (s.expires_at IS NULL OR s.expires_at > now())
		WHERE p.organization_id = ${organizationId} AND p.slug = ${slug}
		  AND p.deleted_at IS NULL
		LIMIT 1
	`) as Array<{ block: InferenceCapabilityBlock | null; ciphertext: string | null }>;

	const row = rows[0];
	// No live row, or the row has no block for this modality ⇒ static fallback.
	if (!row || !row.block) return null;

	let apiKey: string | undefined;
	if (row.ciphertext) {
		try {
			apiKey = decrypt(row.ciphertext);
		} catch (error) {
			logger.warn(
				`Failed to decrypt inference-provider key for ${organizationId}/${slug}: ${getErrorMessage(error)}`,
			);
		}
	}

	return {
		baseUrl: row.block.base_url,
		model: row.block.model,
		modelsEndpoint: row.block.models_endpoint,
		apiKey,
		custom: Boolean(row.block.base_url),
	};
}

/**
 * Merge (never clobber) one modality's block into `capabilities`:
 * `capabilities || jsonb_build_object(<modality>, <block>)`, so a concurrent
 * edit to a DIFFERENT modality can't lose this one. Null-valued fields are
 * stripped (canonicalized) before merge.
 * Callers MUST have validated the block via {@link validateCapabilityBlock}.
 * Returns the updated row, or null when no live row exists for the slug.
 */
export async function updateInferenceProviderCapabilities(
	organizationId: string,
	slug: string,
	modality: InferenceModality,
	block: InferenceCapabilityBlock,
): Promise<InferenceProviderRow | null> {
	const sql = getDb();
	const canonical = canonicalizeCapabilityBlock(block);

	// Merge (never clobber): `||` overlays only this modality's key, so a
	// concurrent edit to a DIFFERENT modality can't lose this one. Null-valued
	// fields were stripped by canonicalizeCapabilityBlock.
	const rows = (await sql`
		UPDATE inference_providers
		SET capabilities = capabilities || jsonb_build_object(${modality}::text, ${sql.json(canonical)}::jsonb),
		    updated_at = now()
		WHERE organization_id = ${organizationId} AND slug = ${slug}
		  AND deleted_at IS NULL
		RETURNING id, organization_id, slug, kind, display_name, api_key_ref,
		          capabilities, has_custom_upstream, status, created_at
	`) as RawInferenceProviderRow[];

	return rows[0] ? mapRow(rows[0]) : null;
}

/**
 * Update a provider's editable core fields. Only `display_name` is editable —
 * `slug` (agents reference it) and `kind` (catalog linkage) are immutable.
 * `COALESCE` leaves the column unchanged when `displayName` is null/undefined,
 * so the route can pass undefined for "no change". Returns the updated row, or
 * null when no live row exists for the slug.
 */
export async function updateInferenceProviderCoreFields(
	organizationId: string,
	slug: string,
	fields: { displayName?: string | null },
): Promise<InferenceProviderRow | null> {
	const sql = getDb();
	const rows = (await sql`
		UPDATE inference_providers
		SET display_name = COALESCE(${fields.displayName ?? null}, display_name),
		    updated_at = now()
		WHERE organization_id = ${organizationId} AND slug = ${slug}
		  AND deleted_at IS NULL
		RETURNING id, organization_id, slug, kind, display_name, api_key_ref,
		          capabilities, has_custom_upstream, status, created_at
	`) as RawInferenceProviderRow[];
	return rows[0] ? mapRow(rows[0]) : null;
}

/**
 * Rotate a provider's api key: re-encrypt into the SAME api_key_ref name (the
 * ref is immutable). Returns false when no live row exists for the slug.
 */
export async function rotateInferenceProviderKey(
	organizationId: string,
	slug: string,
	apiKey: string,
): Promise<boolean> {
	const sql = getDb();
	const ciphertext = encrypt(apiKey);

	return await sql.begin(async (tx) => {
		const rows = (await tx`
			SELECT id
			FROM inference_providers
			WHERE organization_id = ${organizationId} AND slug = ${slug}
			  AND deleted_at IS NULL
			LIMIT 1
			FOR UPDATE
		`) as Array<{ id: string | number }>;
		const row = rows[0];
		if (!row) return false;

		const secretName = inferenceProviderSecretName(slug, Number(row.id));

		await tx`
			INSERT INTO agent_secrets (organization_id, name, ciphertext, created_at, updated_at)
			VALUES (${organizationId}, ${secretName}, ${ciphertext}, now(), now())
			ON CONFLICT (organization_id, name)
			DO UPDATE SET ciphertext = EXCLUDED.ciphertext, updated_at = now()
		`;

		return true;
	});
}

/**
 * Soft-delete a provider (set `deleted_at = now()`). The
 * `agent_secrets` ciphertext is intentionally LEFT in place — the TOTAL
 * api_key_ref unique index keeps the `<slug>-<id>` name reserved, and a
 * recreate mints a fresh id so it never inherits this row's ciphertext.
 * Returns false when no live row exists for the slug.
 */
export async function softDeleteInferenceProvider(
	organizationId: string,
	slug: string,
): Promise<boolean> {
	const sql = getDb();
	const rows = (await sql`
		UPDATE inference_providers
		SET deleted_at = now(), updated_at = now()
		WHERE organization_id = ${organizationId} AND slug = ${slug}
		  AND deleted_at IS NULL
		RETURNING id
	`) as Array<{ id: string | number }>;
	return rows.length > 0;
}

export function providerOrgSecretName(providerId: string): string {
  return `provider:${providerId}:apiKey`;
}

/**
 * Vault row name for one credential field of a runtime environment. Keyed by
 * `environments.id` (not provider kind) so two environments of the same
 * provider in one org keep distinct credentials — e.g.
 * `environment:env-abc:token`. Org-scoping is still enforced by the
 * `(organization_id, name)` PK on `agent_secrets`.
 */
export function environmentSecretName(
  environmentId: string,
  field: string
): string {
  return `environment:${environmentId}:${field}`;
}

/**
 * Encrypt + upsert one credential field for a runtime environment into the
 * org vault (`environment:<id>:<field>`). Used by the environments API; the
 * plaintext is never persisted and the gateway resolves it back via
 * {@link readEnvironmentSecret} at exec time.
 */
export async function writeEnvironmentSecret(
  environmentId: string,
  field: string,
  organizationId: string,
  value: string
): Promise<void> {
  const sql = getDb();
  const ciphertext = encrypt(value);
  await sql`
    INSERT INTO agent_secrets (organization_id, name, ciphertext, updated_at)
    VALUES (${organizationId}, ${environmentSecretName(environmentId, field)}, ${ciphertext}, now())
    ON CONFLICT (organization_id, name)
    DO UPDATE SET ciphertext = EXCLUDED.ciphertext, updated_at = now()
  `;
}

/**
 * Read + decrypt one credential field for a runtime environment. Returns null
 * on miss/expiry/decrypt-failure so the caller can fall back to system env.
 * Mirrors {@link readOrgSharedProviderApiKey} but keyed per-environment.
 */
export async function readEnvironmentSecret(
  environmentId: string,
  field: string,
  organizationId: string
): Promise<string | null> {
  const sql = getDb();
  const rows = (await sql`
    SELECT ciphertext
    FROM agent_secrets
    WHERE organization_id = ${organizationId}
      AND name = ${environmentSecretName(environmentId, field)}
      AND (expires_at IS NULL OR expires_at > now())
    LIMIT 1
  `) as Array<{ ciphertext: string }>;
  const ciphertext = rows[0]?.ciphertext;
  if (!ciphertext) return null;
  try {
    return decrypt(ciphertext);
  } catch (error) {
    logger.warn(
      `Failed to decrypt environment secret ${environmentSecretName(
        environmentId,
        field
      )}: ${getErrorMessage(error)}`
    );
    return null;
  }
}

/**
 * Read + decrypt the org-shared API key for a provider (tier 2 of the
 * resolution chain above). Returns null when no row exists, the row expired,
 * or the ciphertext fails to decrypt — every miss is silent so callers keep
 * walking the chain. Shared by the worker-spawn credential path
 * (base-provider-module.ts) and the egress secret-proxy, which MUST agree on
 * this tier: run dispatch checks it via `hasCredentials`, so a proxy that
 * skips it lets an apply-provisioned org dispatch its agent only to 401 at
 * the first provider call.
 */
export async function readOrgSharedProviderApiKey(
  providerId: string,
  organizationId: string
): Promise<string | null> {
  const sql = getDb();
  const rows = (await sql`
    SELECT ciphertext
    FROM agent_secrets
    WHERE organization_id = ${organizationId}
      AND name = ${providerOrgSecretName(providerId)}
      AND (expires_at IS NULL OR expires_at > now())
    LIMIT 1
  `) as Array<{ ciphertext: string }>;
  const ciphertext = rows[0]?.ciphertext;
  if (!ciphertext) return null;
  try {
    return decrypt(ciphertext);
  } catch (error) {
    logger.warn(
      `Failed to decrypt org-shared key for provider ${providerId}: ${getErrorMessage(error)}`
    );
    return null;
  }
}

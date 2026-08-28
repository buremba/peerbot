import { type DbClient, pgTextArray } from "../db/client";

type ConnectorIdentityScopeShape = {
	scope: "organization" | "tenant";
	scopeKeyPath: string | null;
};

type ConnectorIdentityScopeDeclaration = ConnectorIdentityScopeShape & {
	namespace: string;
	declaration: string;
};

type ConnectorIdentityMetadata = {
	key: string;
	feeds: Record<string, unknown> | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function sameShape(
	left: ConnectorIdentityScopeShape,
	right: ConnectorIdentityScopeShape,
): boolean {
	return left.scope === right.scope && left.scopeKeyPath === right.scopeKeyPath;
}

function renderShape(shape: ConnectorIdentityScopeShape): string {
	return shape.scope === "tenant"
		? `{ scope: 'tenant', scopeKeyPath: '${shape.scopeKeyPath}' }`
		: `{ scope: 'organization' }`;
}

/**
 * Read and validate every entity-identity declaration from connector metadata.
 * The returned map is one canonical declaration shape per namespace.
 */
export function connectorIdentityScopeDeclarations(
	metadata: ConnectorIdentityMetadata,
): Map<string, ConnectorIdentityScopeDeclaration> {
	const declarations = new Map<string, ConnectorIdentityScopeDeclaration>();
	for (const [feedKey, rawFeed] of Object.entries(metadata.feeds ?? {})) {
		const eventKinds = asRecord(asRecord(rawFeed)?.eventKinds);
		if (!eventKinds) continue;
		for (const [eventKind, rawEventKind] of Object.entries(eventKinds)) {
			const attributions = asRecord(rawEventKind)?.attributions;
			if (!Array.isArray(attributions)) continue;
			attributions.forEach((rawAttribution, attributionIndex) => {
				const identities = asRecord(
					asRecord(rawAttribution)?.target,
				)?.identities;
				if (!Array.isArray(identities)) return;
				identities.forEach((rawIdentity, identityIndex) => {
					const identity = asRecord(rawIdentity);
					if (!identity) return;
					const namespace =
						typeof identity.namespace === "string"
							? identity.namespace.trim()
							: "";
					if (!namespace) return;
					const declaration =
						`feed '${feedKey}', event kind '${eventKind}', attribution #${attributionIndex + 1}, ` +
						`identity #${identityIndex + 1}`;
					const rawScope = identity.scope;
					if (
						rawScope !== undefined &&
						rawScope !== "organization" &&
						rawScope !== "tenant"
					) {
						throw new Error(
							`Identity namespace '${namespace}' in ${declaration} uses unsupported scope ` +
								`'${String(rawScope)}'. Use 'organization' or 'tenant'.`,
						);
					}
					const scope = rawScope === "tenant" ? "tenant" : "organization";
					const hasScopeKeyPath = Object.hasOwn(identity, "scopeKeyPath");
					const scopeKeyPath =
						typeof identity.scopeKeyPath === "string"
							? identity.scopeKeyPath.trim()
							: null;
					if (scope === "tenant" && !scopeKeyPath) {
						throw new Error(
							`Identity namespace '${namespace}' in ${declaration} requires a non-empty scopeKeyPath for tenant scope.`,
						);
					}
					if (scope === "organization" && hasScopeKeyPath) {
						throw new Error(
							`Identity namespace '${namespace}' in ${declaration} has scopeKeyPath, but organization scope requires it to be omitted.`,
						);
					}
					const next: ConnectorIdentityScopeDeclaration = {
						namespace,
						scope,
						scopeKeyPath,
						declaration,
					};
					const prior = declarations.get(namespace);
					if (prior && !sameShape(prior, next)) {
						throw new Error(
							`Identity namespace '${namespace}' has conflicting scope declarations: ` +
								`${prior.declaration} declares ${renderShape(prior)}, while ` +
								`${next.declaration} declares ${renderShape(next)}.`,
						);
					}
					declarations.set(namespace, prior ?? next);
				});
			});
		}
	}
	return declarations;
}

/**
 * Keep ingestion on the declaration shape that the registry currently owns.
 *
 * Re-key promotes the registry and rows atomically, but the operator still has
 * to apply the connector version containing that promoted declaration. The old
 * active definition must not recreate identities under its old key during that
 * interval. Call this inside the same transaction that writes identities: the
 * shared transition lock makes an ingestion that started before re-key finish
 * first, while re-key's exclusive lock makes a later ingestion observe the new
 * registry shape and fail closed until apply activates matching rules.
 */
export async function assertConnectorIdentityScopesActive(params: {
	sql: DbClient;
	organizationId: string;
	connectorKey: string;
	identities: Array<{
		namespace: string;
		scope?: "organization" | "tenant";
		scopeKeyPath?: string;
	}>;
}): Promise<void> {
	const declarations = new Map<string, ConnectorIdentityScopeShape>();
	for (const identity of params.identities) {
		const namespace = identity.namespace.trim();
		if (!namespace) continue;
		const shape: ConnectorIdentityScopeShape =
			identity.scope === "tenant"
				? {
						scope: "tenant",
						scopeKeyPath: identity.scopeKeyPath?.trim() || null,
					}
				: { scope: "organization", scopeKeyPath: null };
		const prior = declarations.get(namespace);
		if (prior && !sameShape(prior, shape)) {
			throw new Error(
				`Identity namespace '${namespace}' has conflicting active scope declarations: ` +
					`${renderShape(prior)} and ${renderShape(shape)}.`,
			);
		}
		declarations.set(namespace, prior ?? shape);
	}
	const namespaces = [...declarations.keys()].sort();
	if (namespaces.length === 0) return;

	for (const namespace of namespaces) {
		await params.sql`
      SELECT pg_advisory_xact_lock_shared(
        hashtext('lobu:identity-rekey'),
        hashtext(${`${params.organizationId}:${namespace}`})
      )
    `;
	}
	const rows = await params.sql<{
		connector_key: string;
		namespace: string;
		scope: "organization" | "tenant";
		scope_key_path: string | null;
	}>`
    SELECT connector_key, namespace, scope, scope_key_path
    FROM connector_identity_scope_registry
    WHERE organization_id = ${params.organizationId}
      AND namespace = ANY(${pgTextArray(namespaces)}::text[])
  `;
	for (const [namespace, active] of declarations) {
		const namespaceRows = rows.filter((row) => row.namespace === namespace);
		const own = namespaceRows.find(
			(row) => row.connector_key === params.connectorKey,
		);
		if (own) {
			const registered: ConnectorIdentityScopeShape = {
				scope: own.scope,
				scopeKeyPath: own.scope_key_path,
			};
			if (!sameShape(active, registered)) {
				throw new Error(
					`Identity namespace '${namespace}' ingestion is paused for connector ` +
						`'${params.connectorKey}' because its active declaration ${renderShape(active)} ` +
						`does not match the registered shape ${renderShape(registered)}. ` +
						"Run `lobu apply` with the re-keyed connector declaration before ingesting more events.",
				);
			}
		}
		const incompatible = namespaceRows.find(
			(row) =>
				!sameShape(active, {
					scope: row.scope,
					scopeKeyPath: row.scope_key_path,
				}),
		);
		if (incompatible) {
			throw new Error(
				`Identity namespace '${namespace}' ingestion is paused because connector ` +
					`'${incompatible.connector_key}' is registered as ` +
					`${renderShape({ scope: incompatible.scope, scopeKeyPath: incompatible.scope_key_path })}, ` +
					`which does not match connector '${params.connectorKey}' at ${renderShape(active)}. ` +
					"Finish applying the same namespace scope shape to every connector before ingesting more events.",
			);
		}
	}
}

/**
 * Persist the connector's declared identity shapes. A shape change with live
 * rows records the exact pending target before rejecting apply, so the explicit
 * re-key command can promote it atomically with the row rewrite.
 */
export async function reconcileConnectorIdentityScopeRegistry(params: {
	sql: DbClient;
	organizationId: string;
	metadata: ConnectorIdentityMetadata;
}): Promise<string | null> {
	const declarations = connectorIdentityScopeDeclarations(params.metadata);
	if (declarations.size === 0) return null;
	const tx = params.sql;
	let blockedMessage: string | null = null;

	await tx`
    SELECT pg_advisory_xact_lock(
      hashtext('lobu:connector-identity-scope'),
      hashtext(${`${params.organizationId}:${params.metadata.key}`})
    )
  `;
	for (const declaration of [...declarations.values()].sort((left, right) =>
		left.namespace.localeCompare(right.namespace),
	)) {
		// Serialize zero-row shape changes with ingestion as well as explicit
		// re-key. Once this transaction promotes the registry, any old active
		// rule entering later sees the mismatch and fails closed until apply
		// finishes activating the new definition.
		await tx`
        SELECT pg_advisory_xact_lock(
          hashtext('lobu:identity-rekey'),
          hashtext(${`${params.organizationId}:${declaration.namespace}`})
        )
      `;
		// Backfill every active connector sharing this namespace, not just the
		// connector being installed. The registry starts empty on upgrade and a
		// brand-new connector must not become the first row with a shape that
		// contradicts an already-active peer.
		const activeDefinitionRows = await tx<{
			key: string;
			feeds_schema: Record<string, unknown> | null;
		}>`
        SELECT key, feeds_schema
        FROM connector_definitions
        WHERE organization_id = ${params.organizationId}
          AND status = 'active'
        ORDER BY key
      `;
		const activeNamespaceDeclarations = new Map<
			string,
			ConnectorIdentityScopeDeclaration
		>();
		for (const activeDefinition of activeDefinitionRows) {
			const active = connectorIdentityScopeDeclarations({
				key: activeDefinition.key,
				feeds: asRecord(activeDefinition.feeds_schema),
			}).get(declaration.namespace);
			if (active) activeNamespaceDeclarations.set(activeDefinition.key, active);
		}

		const rows = await tx<{
			connector_key: string;
			scope: "organization" | "tenant";
			scope_key_path: string | null;
			pending_scope: "organization" | "tenant" | null;
			pending_scope_key_path: string | null;
		}>`
        SELECT connector_key, scope, scope_key_path, pending_scope, pending_scope_key_path
        FROM connector_identity_scope_registry
        WHERE organization_id = ${params.organizationId}
          AND namespace = ${declaration.namespace}
        FOR UPDATE
      `;
		const registryByConnector = new Map(
			rows.map((row) => [row.connector_key, row]),
		);
		for (const [connectorKey, active] of activeNamespaceDeclarations) {
			if (registryByConnector.has(connectorKey)) continue;
			await tx`
          INSERT INTO connector_identity_scope_registry (
            organization_id, connector_key, namespace, scope, scope_key_path
          ) VALUES (
            ${params.organizationId}, ${connectorKey}, ${declaration.namespace},
            ${active.scope}, ${active.scopeKeyPath}
          )
        `;
			registryByConnector.set(connectorKey, {
				connector_key: connectorKey,
				scope: active.scope,
				scope_key_path: active.scopeKeyPath,
				pending_scope: null,
				pending_scope_key_path: null,
			});
		}

		const current = registryByConnector.get(params.metadata.key);
		if (!current) {
			const incompatible = [...registryByConnector.values()].find(
				(row) =>
					!sameShape(declaration, {
						scope: row.scope,
						scopeKeyPath: row.scope_key_path,
					}),
			);
			if (incompatible) {
				blockedMessage =
					`Identity namespace '${declaration.namespace}' cannot be registered as ` +
					`${renderShape(declaration)} for connector '${params.metadata.key}' because connector ` +
					`'${incompatible.connector_key}' already uses ` +
					`${renderShape({ scope: incompatible.scope, scopeKeyPath: incompatible.scope_key_path })}. ` +
					"Connectors sharing an identity namespace must declare the same scope shape.";
				break;
			}
			await tx`
          INSERT INTO connector_identity_scope_registry (
            organization_id, connector_key, namespace, scope, scope_key_path
          ) VALUES (
            ${params.organizationId}, ${params.metadata.key}, ${declaration.namespace},
            ${declaration.scope}, ${declaration.scopeKeyPath}
          )
        `;
			continue;
		}

		const oldShape: ConnectorIdentityScopeShape = {
			scope: current.scope,
			scopeKeyPath: current.scope_key_path,
		};
		if (sameShape(oldShape, declaration)) {
			await tx`
          UPDATE connector_identity_scope_registry
          SET pending_scope = NULL,
              pending_scope_key_path = NULL,
              updated_at = now()
          WHERE organization_id = ${params.organizationId}
            AND connector_key = ${params.metadata.key}
            AND namespace = ${declaration.namespace}
        `;
			continue;
		}

		const counts = await tx<{ count: number | string }>`
        SELECT count(*)::bigint AS count
        FROM entity_identities
        WHERE organization_id = ${params.organizationId}
          AND namespace = ${declaration.namespace}
          AND deleted_at IS NULL
      `;
		const liveCount = Number(counts[0]?.count ?? 0);
		if (liveCount === 0) {
			await tx`
          UPDATE connector_identity_scope_registry
          SET scope = ${declaration.scope},
              scope_key_path = ${declaration.scopeKeyPath},
              pending_scope = NULL,
              pending_scope_key_path = NULL,
              shape_version = shape_version + 1,
              updated_at = now()
          WHERE organization_id = ${params.organizationId}
            AND connector_key = ${params.metadata.key}
            AND namespace = ${declaration.namespace}
        `;
			continue;
		}

		await tx`
        UPDATE connector_identity_scope_registry
        SET pending_scope = ${declaration.scope},
            pending_scope_key_path = ${declaration.scopeKeyPath},
            updated_at = now()
        WHERE organization_id = ${params.organizationId}
          AND connector_key = ${params.metadata.key}
          AND namespace = ${declaration.namespace}
      `;
		blockedMessage =
			`Identity namespace '${declaration.namespace}' cannot change scope for connector ` +
			`'${params.metadata.key}' while ${liveCount} live identity row${liveCount === 1 ? "" : "s"} exist. ` +
			`Old shape: ${renderShape(oldShape)}. New shape: ${renderShape(declaration)}. ` +
			`Run \`lobu identities rekey ${declaration.namespace} --mapping <file.json>\` to re-key explicitly first.`;
		break;
	}
	return blockedMessage;
}

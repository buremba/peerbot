import {
	type Context,
	type EntityJson,
	type EntityUid,
	isAuthorized,
	type Schema,
	validate,
} from "@cedar-policy/cedar-wasm/nodejs";

export type EntityPolicyDecision =
	| "allow"
	| "deny"
	| "redact"
	| "require_approval";

export type EntityPolicyPrincipalKind = "user" | "agent" | "watcher";

export interface EntityPolicyPrincipal {
	kind: EntityPolicyPrincipalKind;
	id: string;
	orgId: string;
	role?: string | null;
}

export interface EntityPolicyResource {
	id: number | string;
	orgId: string;
	entityType: string;
	fieldOwner?: "human" | "system" | "none" | string;
}

const schema = {
	Lobu: {
		entityTypes: {
			User: {
				shape: {
					type: "Record",
					attributes: {
						org_id: { type: "String" },
						role: { type: "String" },
					},
				},
			},
			Agent: {
				shape: {
					type: "Record",
					attributes: {
						org_id: { type: "String" },
					},
				},
			},
			Watcher: {
				shape: {
					type: "Record",
					attributes: {
						org_id: { type: "String" },
					},
				},
			},
			Entity: {
				shape: {
					type: "Record",
					attributes: {
						org_id: { type: "String" },
						entity_type: { type: "String" },
						field_owner: { type: "String" },
					},
				},
			},
		},
		actions: {
			readField: {
				appliesTo: {
					principalTypes: ["User", "Agent", "Watcher"],
					resourceTypes: ["Entity"],
					context: {
						type: "Record",
						attributes: { field: { type: "String" } },
					},
				},
			},
			redactField: {
				appliesTo: {
					principalTypes: ["User", "Agent", "Watcher"],
					resourceTypes: ["Entity"],
					context: {
						type: "Record",
						attributes: { field: { type: "String" } },
					},
				},
			},
			updateField: {
				appliesTo: {
					principalTypes: ["User", "Agent", "Watcher"],
					resourceTypes: ["Entity"],
					context: {
						type: "Record",
						attributes: { field: { type: "String" } },
					},
				},
			},
			autoApplyFieldUpdate: {
				appliesTo: {
					principalTypes: ["User", "Agent", "Watcher"],
					resourceTypes: ["Entity"],
					context: {
						type: "Record",
						attributes: { field: { type: "String" } },
					},
				},
			},
			requiresApprovalForUpdate: {
				appliesTo: {
					principalTypes: ["User", "Agent", "Watcher"],
					resourceTypes: ["Entity"],
					context: {
						type: "Record",
						attributes: { field: { type: "String" } },
					},
				},
			},
			createEntity: {
				appliesTo: {
					principalTypes: ["User", "Agent", "Watcher"],
					resourceTypes: ["Entity"],
					context: { type: "Record", attributes: {} },
				},
			},
			requiresApprovalForCreate: {
				appliesTo: {
					principalTypes: ["User", "Agent", "Watcher"],
					resourceTypes: ["Entity"],
					context: { type: "Record", attributes: {} },
				},
			},
			deleteEntity: {
				appliesTo: {
					principalTypes: ["User", "Agent", "Watcher"],
					resourceTypes: ["Entity"],
					context: { type: "Record", attributes: {} },
				},
			},
			requiresApprovalForDelete: {
				appliesTo: {
					principalTypes: ["User", "Agent", "Watcher"],
					resourceTypes: ["Entity"],
					context: { type: "Record", attributes: {} },
				},
			},
		},
	},
};

const policies = `
permit(principal, action == Lobu::Action::"readField", resource)
when { principal.org_id == resource.org_id };

permit(principal, action == Lobu::Action::"redactField", resource)
when {
  principal.org_id == resource.org_id
  && resource.entity_type == "$member"
  && context.field == "email"
  && !(principal is Lobu::User && (principal.role == "owner" || principal.role == "admin"))
};

permit(principal is Lobu::User, action == Lobu::Action::"updateField", resource)
when {
  principal.org_id == resource.org_id
  && (principal.role == "owner" || principal.role == "admin")
};

permit(principal is Lobu::Agent, action == Lobu::Action::"updateField", resource)
when { principal.org_id == resource.org_id };

permit(principal is Lobu::Watcher, action == Lobu::Action::"updateField", resource)
when { principal.org_id == resource.org_id };

permit(principal is Lobu::User, action == Lobu::Action::"autoApplyFieldUpdate", resource)
when {
  principal.org_id == resource.org_id
  && (principal.role == "owner" || principal.role == "admin")
};

permit(principal is Lobu::Agent, action == Lobu::Action::"autoApplyFieldUpdate", resource)
when { principal.org_id == resource.org_id && !(resource.field_owner == "human") };

permit(principal is Lobu::Watcher, action == Lobu::Action::"autoApplyFieldUpdate", resource)
when { principal.org_id == resource.org_id && !(resource.field_owner == "human") };

permit(principal is Lobu::Agent, action == Lobu::Action::"requiresApprovalForUpdate", resource)
when { principal.org_id == resource.org_id && resource.field_owner == "human" };

permit(principal is Lobu::Watcher, action == Lobu::Action::"requiresApprovalForUpdate", resource)
when { principal.org_id == resource.org_id && resource.field_owner == "human" };

permit(principal is Lobu::User, action == Lobu::Action::"createEntity", resource)
when { principal.org_id == resource.org_id };

permit(principal is Lobu::Agent, action == Lobu::Action::"createEntity", resource)
when { principal.org_id == resource.org_id };

permit(principal is Lobu::Watcher, action == Lobu::Action::"createEntity", resource)
when { principal.org_id == resource.org_id };

permit(principal is Lobu::User, action == Lobu::Action::"deleteEntity", resource)
when {
  principal.org_id == resource.org_id
  && (principal.role == "owner" || principal.role == "admin")
};

permit(principal is Lobu::Agent, action == Lobu::Action::"deleteEntity", resource)
when { principal.org_id == resource.org_id };

permit(principal is Lobu::Watcher, action == Lobu::Action::"deleteEntity", resource)
when { principal.org_id == resource.org_id };

permit(principal is Lobu::Agent, action == Lobu::Action::"requiresApprovalForDelete", resource)
when { principal.org_id == resource.org_id };

permit(principal is Lobu::Watcher, action == Lobu::Action::"requiresApprovalForDelete", resource)
when { principal.org_id == resource.org_id };
`;

const validation = validate({
	schema: schema as Schema,
	policies: { staticPolicies: policies },
});

if (validation.type === "failure" || validation.validationErrors.length > 0) {
	const errors =
		validation.type === "failure"
			? validation.errors
			: validation.validationErrors.map((entry) => entry.error);
	throw new Error(
		`Invalid built-in entity policies: ${errors.map((error) => error.message).join("; ")}`,
	);
}

function principalType(
	kind: EntityPolicyPrincipalKind,
): "User" | "Agent" | "Watcher" {
	if (kind === "user") return "User";
	if (kind === "agent") return "Agent";
	return "Watcher";
}

function uid(
	type: "User" | "Agent" | "Watcher" | "Entity" | "Action",
	id: string,
): EntityUid {
	return { type: `Lobu::${type}`, id };
}

function principalEntity(principal: EntityPolicyPrincipal): EntityJson {
	const type = principalType(principal.kind);
	const attrs: EntityJson["attrs"] = { org_id: principal.orgId };
	if (type === "User") attrs.role = principal.role ?? "member";
	return { uid: uid(type, principal.id), attrs, parents: [] };
}

function resourceEntity(resource: EntityPolicyResource): EntityJson {
	return {
		uid: uid("Entity", String(resource.id)),
		attrs: {
			org_id: resource.orgId,
			entity_type: resource.entityType,
			field_owner: resource.fieldOwner ?? "none",
		},
		parents: [],
	};
}

function isAllowed(args: {
	principal: EntityPolicyPrincipal;
	action: string;
	resource: EntityPolicyResource;
	context?: Context;
}): boolean {
	const principal = principalEntity(args.principal);
	const resource = resourceEntity(args.resource);
	const result = isAuthorized({
		principal: principal.uid,
		action: uid("Action", args.action),
		resource: resource.uid,
		context: args.context ?? {},
		schema: schema as Schema,
		validateRequest: true,
		policies: { staticPolicies: policies },
		entities: [principal, resource],
	});

	if (result.type === "failure") {
		throw new Error(
			`Entity policy evaluation failed: ${result.errors
				.map((error) => error.message)
				.join("; ")}`,
		);
	}
	return result.response.decision === "allow";
}

export function evaluateEntityFieldRead(args: {
	principal: EntityPolicyPrincipal;
	resource: EntityPolicyResource;
	field: string;
}): EntityPolicyDecision {
	if (
		!isAllowed({
			...args,
			action: "readField",
			context: { field: args.field },
		})
	) {
		return "deny";
	}

	return isAllowed({
		...args,
		action: "redactField",
		context: { field: args.field },
	})
		? "redact"
		: "allow";
}

export function evaluateEntityFieldUpdate(args: {
	principal: EntityPolicyPrincipal;
	resource: EntityPolicyResource;
	field: string;
}): EntityPolicyDecision {
	if (
		!isAllowed({
			...args,
			action: "updateField",
			context: { field: args.field },
		})
	) {
		return "deny";
	}

	if (
		isAllowed({
			...args,
			action: "requiresApprovalForUpdate",
			context: { field: args.field },
		})
	) {
		return "require_approval";
	}

	return isAllowed({
		...args,
		action: "autoApplyFieldUpdate",
		context: { field: args.field },
	})
		? "allow"
		: "deny";
}

export function evaluateEntityCreate(args: {
	principal: EntityPolicyPrincipal;
	resource: EntityPolicyResource;
}): EntityPolicyDecision {
	if (!isAllowed({ ...args, action: "createEntity" })) return "deny";
	return isAllowed({ ...args, action: "requiresApprovalForCreate" })
		? "require_approval"
		: "allow";
}

export function evaluateEntityDelete(args: {
	principal: EntityPolicyPrincipal;
	resource: EntityPolicyResource;
}): EntityPolicyDecision {
	if (!isAllowed({ ...args, action: "deleteEntity" })) return "deny";
	return isAllowed({ ...args, action: "requiresApprovalForDelete" })
		? "require_approval"
		: "allow";
}

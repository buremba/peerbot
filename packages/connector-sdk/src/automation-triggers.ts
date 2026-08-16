import { type Static, Type } from "@sinclair/typebox";

// The config authoring surface imports only connector-sdk (see the CLI's
// config-isolation guard), so re-export the canonical platform trigger types
// here instead of maintaining a second structural copy.
export type {
	AutomationEventTrigger,
	AutomationScheduleTrigger,
	AutomationTrigger,
	AutomationWorkspaceEventTrigger,
} from "@lobu/core/contracts/tools/manage-automations";

/**
 * A connector-owned event that can activate an Automation. These definitions are
 * catalog metadata: the UI, CLI, and agent tools render the same stable keys
 * without learning provider webhook names.
 */
export const ConnectorAutomationEventSchema = Type.Object(
	{
		key: Type.String({ minLength: 1, maxLength: 100 }),
		label: Type.String({ minLength: 1, maxLength: 160 }),
		description: Type.Optional(Type.String({ maxLength: 500 })),
		resourceType: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
		filterSchema: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
		capabilities: Type.Optional(
			Type.Object(
				{
					steering: Type.Optional(Type.Boolean()),
					replyToSource: Type.Optional(Type.Boolean()),
				},
				{ additionalProperties: false },
			),
		),
		defaults: Type.Optional(
			Type.Object(
				{
					execution: Type.Optional(
						Type.Union([Type.Literal("turn"), Type.Literal("window")]),
					),
					activeRun: Type.Optional(
						Type.Union([
							Type.Literal("queue"),
							Type.Literal("coalesce"),
							Type.Literal("steer"),
						]),
					),
					output: Type.Optional(
						Type.Union([
							Type.Literal("reply_to_source"),
							Type.Literal("silent"),
						]),
					),
				},
				{ additionalProperties: false },
			),
		),
	},
	{ additionalProperties: false },
);

export type ConnectorAutomationEvent = Static<
	typeof ConnectorAutomationEventSchema
>;

/**
 * An action-result hint that points at a resource the user may subscribe to.
 * The connector event catalog remains authoritative; the action result never
 * creates a subscription or repeats the connector's supported-event list.
 */
export const SubscriptionCandidateSchema = Type.Object(
	{
		connector_key: Type.String({ minLength: 1, maxLength: 100 }),
		resource_type: Type.String({ minLength: 1, maxLength: 100 }),
		resource_ref: Type.String({ minLength: 1, maxLength: 500 }),
		label: Type.String({ minLength: 1, maxLength: 300 }),
		suggested_event_keys: Type.Optional(
			Type.Array(Type.String({ minLength: 1, maxLength: 100 }), {
				maxItems: 16,
				uniqueItems: true,
			}),
		),
	},
	{ additionalProperties: false },
);

export type SubscriptionCandidate = Static<typeof SubscriptionCandidateSchema>;

const TriggerAttributeValueSchema = Type.Union([
	Type.String({ maxLength: 1_000 }),
	Type.Number(),
	Type.Boolean(),
	Type.Null(),
]);

/**
 * Connector-owned activation metadata carried beside an EventEnvelope.
 *
 * The connector interprets provider payloads; the platform only fills the
 * connection, connector, persisted-event, and delivery identifiers. This keeps
 * provider-specific parsing out of core while reusing the existing event row as
 * the durable delivery record.
 */
export const ConnectorAutomationSignalDraftSchema = Type.Object(
	{
		event_type: Type.String({ minLength: 1, maxLength: 100 }),
		updated_event_type: Type.Optional(
			Type.String({ minLength: 1, maxLength: 100 }),
		),
		resource_type: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
		resource_ref: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
		label: Type.String({ minLength: 1, maxLength: 300 }),
		input_text: Type.String({ maxLength: 32_000 }),
		url: Type.Optional(Type.String({ maxLength: 2_000 })),
		occurred_at: Type.Optional(Type.String({ maxLength: 64 })),
		attributes: Type.Optional(
			Type.Record(Type.String({ maxLength: 100 }), TriggerAttributeValueSchema),
		),
	},
	{ additionalProperties: false },
);

export type ConnectorAutomationSignalDraft = Static<
	typeof ConnectorAutomationSignalDraftSchema
>;

/**
 * Small connector-normalized signal used to activate matching Automation triggers.
 * The durable source record remains in events/channel_messages; this carries no
 * raw webhook payload and creates no parallel delivery ledger.
 */
export interface ConnectorTriggerSignal {
	connector_key: string;
	connection_id?: number;
	resource_type?: string;
	resource_ref?: string;
	event_type: string;
	delivery_id: string;
	label: string;
	input_text: string;
	url?: string;
	occurred_at?: string;
	attributes?: Record<string, string | number | boolean | null>;
	/** The connector delivered the same durable event state again. */
	unchanged?: boolean;
}

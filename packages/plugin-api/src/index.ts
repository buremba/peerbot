import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

export const LOBU_PLUGIN_API_VERSION = 1 as const;

export const PluginManifestSchema = Type.Object(
  {
    name: Type.String({ pattern: "^[a-z][a-z0-9-]*$" }),
    version: Type.String({ minLength: 1 }),
    apiVersion: Type.Literal(LOBU_PLUGIN_API_VERSION),
    description: Type.String({ minLength: 1 }),
    capabilities: Type.Optional(
      Type.Array(Type.String({ pattern: "^[a-z][a-z0-9_.:-]*$" }), {
        uniqueItems: true,
      })
    ),
  },
  { additionalProperties: false }
);

export type PluginManifest = Static<typeof PluginManifestSchema>;

export interface PluginLogger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

export interface PluginHostContext {
  logger: PluginLogger;
}

export interface PluginRuntimeContext extends PluginHostContext {
  organizationId: string;
  actorId: string;
  credentialSubject: string;
  destination: string;
  agentId: string;
  conversationId: string;
  runId: number;
  messageId: string;
  connectionId?: string;
  workspaceDir: string;
  platform: string;
}

export interface BeforeAgentStartEvent {
  prompt: string;
  messages: readonly unknown[];
}

export interface BeforeAgentStartResult {
  prependContext?: string;
}

export interface ToolCallEvent {
  toolName: string;
  toolCallId: string;
  params: Record<string, unknown>;
}

export interface BeforeToolCallResult {
  params?: Record<string, unknown>;
  block?: boolean;
  blockReason?: string;
}

export interface AfterToolCallEvent extends ToolCallEvent {
  result: unknown;
  isError: boolean;
}

export interface AgentEndEvent {
  messages: readonly unknown[];
  error?: string;
}

export interface PluginHooks {
  beforeAgentStart?(
    event: BeforeAgentStartEvent,
    context: PluginRuntimeContext
  ):
    | BeforeAgentStartResult
    | undefined
    | Promise<BeforeAgentStartResult | undefined>;
  beforeToolCall?(
    event: ToolCallEvent,
    context: PluginRuntimeContext
  ):
    | BeforeToolCallResult
    | undefined
    | Promise<BeforeToolCallResult | undefined>;
  afterToolCall?(
    event: AfterToolCallEvent,
    context: PluginRuntimeContext
  ): void | Promise<void>;
  agentEnd?(
    event: AgentEndEvent,
    context: PluginRuntimeContext
  ): void | Promise<void>;
}

export interface PluginService {
  id: string;
  start(context: PluginHostContext): void | Promise<void>;
  stop(context: PluginHostContext): void | Promise<void>;
}

export interface LobuPlugin<TTool = never, TProvider = never> {
  manifest: PluginManifest;
  hooks?: PluginHooks;
  tools?(
    context: PluginRuntimeContext
  ): readonly TTool[] | Promise<readonly TTool[]>;
  providers?: readonly TProvider[];
  services?: readonly PluginService[];
}

export function defineLobuPlugin<TTool = never, TProvider = never>(
  plugin: LobuPlugin<TTool, TProvider>
): LobuPlugin<TTool, TProvider> {
  assertPluginManifest(plugin.manifest);
  return plugin;
}

export function assertPluginManifest(
  manifest: unknown
): asserts manifest is PluginManifest {
  if (Value.Check(PluginManifestSchema, manifest)) {
    return;
  }
  const errors = [...Value.Errors(PluginManifestSchema, manifest)]
    .map((error) => `${error.path || "/"}: ${error.message}`)
    .join("; ");
  throw new Error(`Invalid Lobu plugin manifest: ${errors}`);
}

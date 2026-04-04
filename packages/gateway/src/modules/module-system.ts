import type { CliBackendConfig } from "@lobu/core";
import {
  type ActionButton,
  type ModuleInterface,
  type ModuleSessionContext,
  moduleRegistry,
  type WorkerContext,
  type WorkerModule,
} from "@lobu/core";

export interface ModelOption {
  value: string;
  label: string;
}

export interface OrchestratorModule<TModuleData = unknown>
  extends ModuleInterface<TModuleData> {
  buildEnvVars(
    agentId: string,
    baseEnv: Record<string, string>
  ): Promise<Record<string, string>>;
  getContainerAddress(): string;
}

export interface ProviderUpstreamConfig {
  slug: string;
  upstreamBaseUrl: string;
}

export interface ModelProviderModule extends OrchestratorModule {
  providerId: string;
  providerDisplayName: string;
  providerIconUrl?: string;
  authType?: "oauth" | "device-code" | "api-key";
  supportedAuthTypes?: ("oauth" | "device-code" | "api-key")[];
  apiKeyInstructions?: string;
  apiKeyPlaceholder?: string;
  catalogDescription?: string;
  catalogVisible?: boolean;
  getSecretEnvVarNames(): string[];
  getCredentialEnvVarName(): string;
  getUpstreamConfig?(): ProviderUpstreamConfig | null;
  hasCredentials(agentId: string): Promise<boolean>;
  hasSystemKey(): boolean;
  getProxyBaseUrlMappings(
    proxyUrl: string,
    agentId?: string
  ): Record<string, string>;
  injectSystemKeyFallback(
    envVars: Record<string, string>
  ): Record<string, string>;
  getApp?(): any;
  getModelOptions?(agentId: string, userId: string): Promise<ModelOption[]>;
  getCliBackendConfig?(): CliBackendConfig | null;
  buildCredentialPlaceholder?(agentId: string): Promise<string> | string;
  startDeviceCode?(agentId: string): Promise<{
    userCode: string;
    deviceAuthId: string;
    interval: number;
    verificationUrl?: string;
  }>;
  pollDeviceCode?(
    agentId: string,
    payload: { deviceAuthId: string; userCode: string }
  ): Promise<{
    status: "pending" | "success";
    error?: string;
    accountId?: string;
  }>;
}

export interface DispatcherContext<TModuleData = unknown> {
  userId: string;
  channelId: string;
  threadTs: string;
  platformClient?: unknown;
  moduleData: TModuleData;
}

export interface DispatcherModule<TModuleData = unknown>
  extends ModuleInterface<TModuleData> {
  generateActionButtons(
    context: DispatcherContext<TModuleData>
  ): Promise<ActionButton[]>;
  handleAction(
    actionId: string,
    userId: string,
    agentId: string,
    context: any
  ): Promise<boolean>;
}

export interface DispatcherModuleSource {
  getDispatcherModules(): DispatcherModule[];
}

export abstract class BaseModule<TModuleData = unknown>
  implements
    WorkerModule<TModuleData>,
    DispatcherModule<TModuleData>,
    OrchestratorModule<TModuleData>
{
  abstract name: string;
  abstract isEnabled(): boolean;

  async init(): Promise<void> {
    // no-op
  }

  registerEndpoints(_app: any): void {
    // no-op
  }

  async initWorkspace(_config: any): Promise<void> {
    // no-op
  }

  async onSessionStart(
    context: ModuleSessionContext
  ): Promise<ModuleSessionContext> {
    return context;
  }

  async onSessionEnd(_context: ModuleSessionContext): Promise<ActionButton[]> {
    return [];
  }

  async onBeforeResponse(_context: WorkerContext): Promise<TModuleData | null> {
    return null;
  }

  async buildEnvVars(
    _agentId: string,
    baseEnv: Record<string, string>
  ): Promise<Record<string, string>> {
    return baseEnv;
  }

  async getModelOptions(
    _agentId: string,
    _userId: string
  ): Promise<ModelOption[]> {
    return [];
  }

  getContainerAddress(): string {
    return "";
  }

  async generateActionButtons(
    _context: DispatcherContext<TModuleData>
  ): Promise<ActionButton[]> {
    return [];
  }

  async handleAction(
    _actionId: string,
    _userId: string,
    _agentId: string,
    _context: any
  ): Promise<boolean> {
    return false;
  }
}

export function getOrchestratorModules(): OrchestratorModule[] {
  return moduleRegistry
    .getModules()
    .filter((m): m is OrchestratorModule => "buildEnvVars" in m);
}

export function getModelProviderModules(): ModelProviderModule[] {
  return moduleRegistry
    .getModules()
    .filter(
      (m): m is ModelProviderModule =>
        "providerId" in m && "getSecretEnvVarNames" in m
    );
}

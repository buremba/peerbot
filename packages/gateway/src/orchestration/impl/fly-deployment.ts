import { URL } from "node:url";
import type { ModelProviderModule } from "@lobu/core";
import { createLogger, ErrorCode, OrchestratorError } from "@lobu/core";
import {
  BaseDeploymentManager,
  type DeploymentInfo,
  type MessagePayload,
  type ModuleEnvVarsBuilder,
  type OrchestratorConfig,
} from "../base-deployment-manager";
import {
  buildDeploymentInfoSummary,
  getVeryOldThresholdDays,
} from "../deployment-utils";

const logger = createLogger("fly-deployment");

const FLY_ACTIVITY_KEY_PREFIX = "lobu:fly:last-activity:";

interface FlyMachineMetadata {
  [key: string]: string | undefined;
}

interface FlyMachineConfig {
  image?: string;
  env?: Record<string, string>;
  metadata?: FlyMachineMetadata;
  guest?: {
    cpu_kind?: string;
    cpus?: number;
    memory_mb?: number;
  };
}

interface FlyMachine {
  id: string;
  name?: string;
  state?: string;
  config?: FlyMachineConfig;
  created_at?: string;
  updated_at?: string;
}

/**
 * FlyDeploymentManager - runs worker runtimes as Fly Machines.
 * Control plane remains in gateway; workers connect back over DISPATCHER_URL.
 */
export class FlyDeploymentManager extends BaseDeploymentManager {
  private readonly apiBaseUrl: string;
  private readonly apiToken: string;
  private readonly appName: string;
  private readonly region?: string;
  private readonly dispatcherUrl: string;
  private readonly dispatcherHost: string;
  private readonly activityTimestamps = new Map<string, Date>();
  private readonly machineIds = new Map<string, string>();

  constructor(
    config: OrchestratorConfig,
    moduleEnvVarsBuilder?: ModuleEnvVarsBuilder,
    providerModules: ModelProviderModule[] = []
  ) {
    super(config, moduleEnvVarsBuilder, providerModules);

    this.apiToken = (process.env.FLY_API_TOKEN || "").trim();
    this.appName = (
      process.env.FLY_WORKER_APP_NAME ||
      process.env.FLY_APP_NAME ||
      ""
    ).trim();
    this.region = (process.env.FLY_REGION || "").trim() || undefined;
    this.apiBaseUrl = (
      process.env.FLY_MACHINES_API_URL || "https://api.machines.dev/v1"
    ).replace(/\/+$/, "");

    const rawDispatcherUrl = (
      process.env.FLY_DISPATCHER_URL ||
      process.env.PUBLIC_GATEWAY_URL ||
      ""
    ).trim();

    if (!this.apiToken) {
      throw new OrchestratorError(
        ErrorCode.INVALID_CONFIGURATION,
        "FLY_API_TOKEN is required for DEPLOYMENT_MODE=fly",
        { deploymentMode: "fly" },
        false
      );
    }

    if (!this.appName) {
      throw new OrchestratorError(
        ErrorCode.INVALID_CONFIGURATION,
        "FLY_WORKER_APP_NAME (or FLY_APP_NAME) is required for DEPLOYMENT_MODE=fly",
        { deploymentMode: "fly" },
        false
      );
    }

    if (!rawDispatcherUrl) {
      throw new OrchestratorError(
        ErrorCode.INVALID_CONFIGURATION,
        "PUBLIC_GATEWAY_URL (or FLY_DISPATCHER_URL) is required for DEPLOYMENT_MODE=fly",
        { deploymentMode: "fly" },
        false
      );
    }

    const parsedDispatcher = this.parseUrl(rawDispatcherUrl, "dispatcher URL");
    this.dispatcherUrl = rawDispatcherUrl.replace(/\/+$/, "");
    this.dispatcherHost = parsedDispatcher.hostname;

    logger.info(
      `✅ FlyDeploymentManager initialized (app=${this.appName}, region=${this.region || "auto"}, dispatcher=${this.dispatcherUrl})`
    );
  }

  protected override getDispatcherUrl(): string {
    return this.dispatcherUrl;
  }

  protected getDispatcherHost(): string {
    return this.dispatcherHost;
  }

  async validateWorkerImage(): Promise<void> {
    await this.listMachines();
    logger.info(
      `✅ Fly app reachable and worker image configured: ${this.getWorkerImageReference()}`
    );
  }

  async listDeployments(): Promise<DeploymentInfo[]> {
    const machines = await this.listMachines();
    const workerMachines = machines.filter((m) => this.isWorkerMachine(m));

    const now = Date.now();
    const idleThresholdMinutes = this.config.worker.idleCleanupMinutes;
    const veryOldDays = getVeryOldThresholdDays(this.config);

    const chosenByDeployment = new Map<string, FlyMachine>();
    for (const machine of workerMachines) {
      const deploymentName = this.getDeploymentNameFromMachine(machine);
      if (!deploymentName) continue;

      const existing = chosenByDeployment.get(deploymentName);
      if (!existing) {
        chosenByDeployment.set(deploymentName, machine);
        continue;
      }

      const existingTime = this.getMachineUpdatedAt(existing).getTime();
      const currentTime = this.getMachineUpdatedAt(machine).getTime();
      if (currentTime >= existingTime) {
        chosenByDeployment.set(deploymentName, machine);
      }
    }

    const deployments = await Promise.all(
      Array.from(chosenByDeployment.entries()).map(
        async ([deploymentName, machine]) => {
          this.machineIds.set(deploymentName, machine.id);

          const lastActivity = await this.resolveLastActivity(
            deploymentName,
            machine
          );
          const replicas = machine.state === "started" ? 1 : 0;

          return buildDeploymentInfoSummary({
            deploymentName,
            lastActivity,
            now,
            idleThresholdMinutes,
            veryOldDays,
            replicas,
          });
        }
      )
    );

    return deployments;
  }

  async createDeployment(
    deploymentName: string,
    username: string,
    userId: string,
    messageData?: MessagePayload,
    userEnvVars?: Record<string, string>
  ): Promise<void> {
    const existingMachine =
      await this.findMachineByDeploymentName(deploymentName);
    if (existingMachine) {
      if (existingMachine.state !== "started") {
        await this.startMachine(existingMachine.id);
      }
      await this.updateDeploymentActivity(deploymentName);
      return;
    }

    const envVars = await this.generateEnvironmentVariables(
      username,
      userId,
      deploymentName,
      messageData,
      true,
      userEnvVars ?? {}
    );
    this.normalizeWorkerEnvForFly(envVars);

    const nowIso = new Date().toISOString();
    const payload = {
      name: deploymentName,
      region: this.region,
      config: {
        image: this.getWorkerImageReference(),
        env: envVars,
        restart: { policy: "no" },
        auto_destroy: false,
        guest: this.resolveMachineGuest(),
        metadata: {
          "lobu.component": "worker",
          "lobu.deployment_name": deploymentName,
          "lobu.user_id": userId,
          "lobu.platform": messageData?.platform || "",
          "lobu.channel_id": messageData?.channelId || "",
          "lobu.conversation_id": messageData?.conversationId || "",
          "lobu.agent_id": messageData?.agentId || "",
          "lobu.created_at": nowIso,
          "lobu.last_activity": nowIso,
        },
      },
    };

    let machine: FlyMachine | null = null;
    try {
      machine = await this.flyRequest<FlyMachine>(
        `/apps/${encodeURIComponent(this.appName)}/machines`,
        {
          method: "POST",
          body: JSON.stringify(payload),
        }
      );
    } catch (error) {
      const status = this.getErrorStatus(error);
      // Concurrent create for the same deployment name can return a conflict-like
      // status on Fly; treat as idempotent and adopt the existing machine.
      if (status === 412 || status === 409) {
        const existing = await this.findMachineByDeploymentName(deploymentName);
        if (existing) {
          machine = existing;
          logger.info(
            `↪️ Fly machine already exists for ${deploymentName}, adopting ${existing.id}`
          );
        }
      } else {
        throw error;
      }
    }

    if (!machine) {
      throw new OrchestratorError(
        ErrorCode.DEPLOYMENT_CREATE_FAILED,
        `Failed to resolve Fly machine for deployment ${deploymentName} after create`,
        { deploymentName },
        false
      );
    }

    this.machineIds.set(deploymentName, machine.id);
    if (machine.state !== "started") {
      await this.startMachine(machine.id);
    } else {
      await this.waitForMachineState(machine.id, "started");
    }
    await this.writeActivityTimestamp(deploymentName, new Date());

    logger.info(
      `✅ Created Fly worker machine: ${deploymentName} (${machine.id})`
    );
  }

  async scaleDeployment(
    deploymentName: string,
    replicas: number
  ): Promise<void> {
    if (replicas !== 0 && replicas !== 1) {
      throw new OrchestratorError(
        ErrorCode.DEPLOYMENT_SCALE_FAILED,
        `Fly deployment only supports replicas 0 or 1 (requested: ${replicas})`,
        { deploymentName, replicas },
        false
      );
    }

    const machine = await this.findMachineByDeploymentName(deploymentName);
    if (!machine) {
      if (replicas === 0) return;
      throw new OrchestratorError(
        ErrorCode.THREAD_DEPLOYMENT_NOT_FOUND,
        `No Fly machine found for deployment ${deploymentName}`,
        { deploymentName },
        false
      );
    }

    if (replicas === 0) {
      await this.stopMachine(machine.id);
      logger.info(`Scaled Fly deployment ${deploymentName} to 0`);
      return;
    }

    if (machine.state !== "started") {
      await this.startMachine(machine.id);
    }
    await this.updateDeploymentActivity(deploymentName);
    logger.info(`Scaled Fly deployment ${deploymentName} to 1`);
  }

  async deleteDeployment(deploymentName: string): Promise<void> {
    const machine = await this.findMachineByDeploymentName(deploymentName);
    if (!machine) return;

    await this.deleteMachine(machine.id);
    this.machineIds.delete(deploymentName);
    this.activityTimestamps.delete(deploymentName);
    await this.deleteActivityTimestamp(deploymentName);

    logger.info(`🗑️ Deleted Fly deployment ${deploymentName} (${machine.id})`);
  }

  async updateDeploymentActivity(deploymentName: string): Promise<void> {
    await this.writeActivityTimestamp(deploymentName, new Date());
  }

  private async listMachines(): Promise<FlyMachine[]> {
    try {
      const machines = await this.flyRequest<FlyMachine[]>(
        `/apps/${encodeURIComponent(this.appName)}/machines?include_deleted=false`
      );
      return Array.isArray(machines) ? machines : [];
    } catch (error) {
      throw this.wrapFlyError(
        error,
        ErrorCode.DEPLOYMENT_CREATE_FAILED,
        "Failed to list Fly machines"
      );
    }
  }

  private async findMachineByDeploymentName(
    deploymentName: string
  ): Promise<FlyMachine | null> {
    const cachedId = this.machineIds.get(deploymentName);
    if (cachedId) {
      const cached = await this.getMachineById(cachedId);
      if (cached) return cached;
      this.machineIds.delete(deploymentName);
    }

    const machines = await this.listMachines();
    const matches = machines.filter(
      (machine) =>
        this.isWorkerMachine(machine) &&
        this.getDeploymentNameFromMachine(machine) === deploymentName
    );

    if (matches.length === 0) return null;

    const chosen = matches.sort((a, b) => {
      return (
        this.getMachineUpdatedAt(b).getTime() -
        this.getMachineUpdatedAt(a).getTime()
      );
    })[0];
    if (!chosen) return null;
    this.machineIds.set(deploymentName, chosen.id);
    return chosen;
  }

  private async getMachineById(machineId: string): Promise<FlyMachine | null> {
    try {
      return await this.flyRequest<FlyMachine>(
        `/apps/${encodeURIComponent(this.appName)}/machines/${encodeURIComponent(machineId)}`
      );
    } catch (error) {
      if (this.isNotFoundError(error)) return null;
      throw error;
    }
  }

  private async startMachine(machineId: string): Promise<void> {
    try {
      await this.flyRequest(
        `/apps/${encodeURIComponent(this.appName)}/machines/${encodeURIComponent(machineId)}/start`,
        { method: "POST" }
      );
    } catch (error) {
      const status = this.getErrorStatus(error);
      // Machine may already be transitioning to started; treat as idempotent.
      if (status !== 412 && status !== 409) {
        throw error;
      }
    }
    await this.waitForMachineState(machineId, "started");
  }

  private async stopMachine(machineId: string): Promise<void> {
    await this.flyRequest(
      `/apps/${encodeURIComponent(this.appName)}/machines/${encodeURIComponent(machineId)}/stop?kill_timeout=5`,
      { method: "POST" }
    );
  }

  private async deleteMachine(machineId: string): Promise<void> {
    await this.flyRequest(
      `/apps/${encodeURIComponent(this.appName)}/machines/${encodeURIComponent(machineId)}?force=true`,
      { method: "DELETE" }
    );
  }

  private async waitForMachineState(
    machineId: string,
    state: "started" | "stopped"
  ): Promise<void> {
    // Fly wait timeout is expressed in seconds and must be in [1, 60].
    const configuredTimeout = this.config.worker.startupTimeoutSeconds ?? 60;
    const timeoutSeconds = Math.min(Math.max(configuredTimeout, 1), 60);
    await this.flyRequest(
      `/apps/${encodeURIComponent(this.appName)}/machines/${encodeURIComponent(machineId)}/wait?state=${state}&timeout=${timeoutSeconds}`
    );
  }

  private normalizeWorkerEnvForFly(envVars: Record<string, string>): void {
    envVars.DISPATCHER_URL = this.dispatcherUrl;
    delete envVars.HTTP_PROXY;
    delete envVars.HTTPS_PROXY;
    envVars.NO_PROXY = this.mergeNoProxy(envVars.NO_PROXY || "");
  }

  private mergeNoProxy(existing: string): string {
    const parts = existing
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    const required = [this.dispatcherHost, "localhost", "127.0.0.1"];
    for (const item of required) {
      if (!parts.includes(item)) parts.push(item);
    }
    return parts.join(",");
  }

  private resolveMachineGuest(): {
    cpu_kind: string;
    cpus: number;
    memory_mb: number;
  } {
    const cpuKind = (process.env.FLY_MACHINE_CPU_KIND || "shared").trim();

    const configuredCpus = Number.parseInt(
      process.env.FLY_MACHINE_CPUS || "",
      10
    );
    const cpus = Number.isFinite(configuredCpus)
      ? Math.max(configuredCpus, 1)
      : this.parseCpuToCores(
          this.config.worker.resources.requests.cpu ||
            this.config.worker.resources.limits.cpu
        );

    const configuredMemoryMb = Number.parseInt(
      process.env.FLY_MACHINE_MEMORY_MB || "",
      10
    );
    const memoryMb = Number.isFinite(configuredMemoryMb)
      ? Math.max(configuredMemoryMb, 256)
      : this.parseMemoryToMb(
          this.config.worker.resources.limits.memory ||
            this.config.worker.resources.requests.memory
        );

    return {
      cpu_kind: cpuKind,
      cpus,
      memory_mb: memoryMb,
    };
  }

  private parseCpuToCores(cpuValue: string | undefined): number {
    if (!cpuValue) return 1;
    const value = cpuValue.trim();
    if (value.endsWith("m")) {
      const millicores = Number.parseInt(value.slice(0, -1), 10);
      if (!Number.isFinite(millicores)) return 1;
      return Math.max(Math.ceil(millicores / 1000), 1);
    }
    const cores = Number.parseFloat(value);
    if (!Number.isFinite(cores)) return 1;
    return Math.max(Math.ceil(cores), 1);
  }

  private parseMemoryToMb(memoryValue: string | undefined): number {
    if (!memoryValue) return 1024;
    const value = memoryValue.trim();

    const units: Record<string, number> = {
      Ki: 1 / 1024,
      Mi: 1,
      Gi: 1024,
      Ti: 1024 * 1024,
      K: 1 / 1024,
      M: 1,
      G: 1024,
      T: 1024 * 1024,
    };

    const match = value.match(/^([0-9]*\.?[0-9]+)\s*([A-Za-z]+)?$/);
    if (!match) return 1024;

    const amount = Number.parseFloat(match[1] || "0");
    const unit = match[2] || "Mi";
    const factor = units[unit] ?? 1;
    if (!Number.isFinite(amount) || !Number.isFinite(factor)) return 1024;

    return Math.max(Math.ceil(amount * factor), 256);
  }

  private isWorkerMachine(machine: FlyMachine): boolean {
    const metadata = machine.config?.metadata || {};
    if (metadata["lobu.component"] === "worker") return true;
    const name = machine.name || "";
    return name.startsWith("lobu-worker-");
  }

  private getDeploymentNameFromMachine(machine: FlyMachine): string {
    const metadata = machine.config?.metadata || {};
    return metadata["lobu.deployment_name"] || machine.name || "";
  }

  private getMachineUpdatedAt(machine: FlyMachine): Date {
    const timestamp = machine.updated_at || machine.created_at;
    if (!timestamp) return new Date(0);
    const parsed = new Date(timestamp);
    if (Number.isNaN(parsed.getTime())) return new Date(0);
    return parsed;
  }

  private async resolveLastActivity(
    deploymentName: string,
    machine: FlyMachine
  ): Promise<Date> {
    const inMemory = this.activityTimestamps.get(deploymentName);
    if (inMemory) return inMemory;

    if (this.redisClient) {
      const key = `${FLY_ACTIVITY_KEY_PREFIX}${deploymentName}`;
      const value = await this.redisClient.get(key);
      if (value) {
        const parsed = new Date(value);
        if (!Number.isNaN(parsed.getTime())) {
          this.activityTimestamps.set(deploymentName, parsed);
          return parsed;
        }
      }
    }

    const metadataLastActivity =
      machine.config?.metadata?.["lobu.last_activity"];
    if (metadataLastActivity) {
      const parsed = new Date(metadataLastActivity);
      if (!Number.isNaN(parsed.getTime())) {
        this.activityTimestamps.set(deploymentName, parsed);
        return parsed;
      }
    }

    return this.getMachineUpdatedAt(machine);
  }

  private async writeActivityTimestamp(
    deploymentName: string,
    timestamp: Date
  ): Promise<void> {
    this.activityTimestamps.set(deploymentName, timestamp);

    if (this.redisClient) {
      const key = `${FLY_ACTIVITY_KEY_PREFIX}${deploymentName}`;
      await this.redisClient.set(
        key,
        timestamp.toISOString(),
        "EX",
        60 * 60 * 24 * 30
      );
    }
  }

  private async deleteActivityTimestamp(deploymentName: string): Promise<void> {
    if (this.redisClient) {
      const key = `${FLY_ACTIVITY_KEY_PREFIX}${deploymentName}`;
      await this.redisClient.del(key);
    }
  }

  private parseUrl(rawUrl: string, label: string): URL {
    try {
      return new URL(rawUrl);
    } catch (error) {
      throw new OrchestratorError(
        ErrorCode.INVALID_CONFIGURATION,
        `Invalid ${label}: ${rawUrl}`,
        { rawUrl, label, error },
        false
      );
    }
  }

  private isNotFoundError(error: unknown): boolean {
    return this.getErrorStatus(error) === 404;
  }

  private getErrorStatus(error: unknown): number | undefined {
    if (!(error instanceof OrchestratorError)) return undefined;
    const status = error.details?.status;
    return typeof status === "number" ? status : undefined;
  }

  private wrapFlyError(
    error: unknown,
    code: ErrorCode,
    message: string
  ): OrchestratorError {
    if (error instanceof OrchestratorError) return error;
    return new OrchestratorError(
      code,
      `${message}: ${error instanceof Error ? error.message : String(error)}`,
      { error },
      true
    );
  }

  private async flyRequest<T = unknown>(
    path: string,
    init?: RequestInit
  ): Promise<T> {
    const response = await fetch(`${this.apiBaseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(init?.headers || {}),
      },
    });

    const responseText = await response.text();
    if (!response.ok) {
      throw new OrchestratorError(
        ErrorCode.DEPLOYMENT_CREATE_FAILED,
        `Fly API request failed: ${response.status} ${response.statusText} - ${responseText.slice(0, 500)}`,
        {
          status: response.status,
          statusText: response.statusText,
          path,
          response: responseText.slice(0, 500),
        },
        false
      );
    }

    if (!responseText) {
      return undefined as T;
    }

    try {
      return JSON.parse(responseText) as T;
    } catch {
      return undefined as T;
    }
  }
}

import {
  defineDeviceConnector,
  serializeDeviceConnector,
  type DeviceConnectorDefinition,
  type DeviceConnectorManifest,
} from "@lobu/connector-sdk";
import { osShellDeviceConnector } from "./os-shell.js";

/**
 * Device connectors a headless endpoint (`lobu daemon` on a server, VM, pod, or
 * a Mac terminal) declares. Every entry here is a contract shared with another
 * platform, authored once and serialized identically for each, so two endpoints
 * of the same connector produce the same manifest hash and an organization's
 * single elected definition covers both.
 */
export const headlessDeviceConnectorDefinitions = defineDeviceConnector([
  osShellDeviceConnector,
]) as readonly DeviceConnectorDefinition[];

export const headlessDeviceConnectorManifests: readonly DeviceConnectorManifest[] =
  headlessDeviceConnectorDefinitions.map(serializeDeviceConnector);

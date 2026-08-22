import {
  defineDeviceConnector,
  serializeDeviceConnector,
  type DeviceConnectorDefinition,
  type DeviceConnectorManifest,
} from "@lobu/connector-sdk";
import { macDeviceConnectorSpecs } from "./mac-definitions.js";

export const macDeviceConnectorDefinitions = defineDeviceConnector(
  [...macDeviceConnectorSpecs].sort((left, right) =>
    left.key.localeCompare(right.key)
  )
) as readonly DeviceConnectorDefinition[];

export const macDeviceConnectorRegistry = Object.freeze(
  Object.fromEntries(
    macDeviceConnectorDefinitions.map((definition) => [
      definition.key,
      definition,
    ])
  )
) as Readonly<Record<string, DeviceConnectorDefinition>>;

export const macDeviceConnectorManifests: readonly DeviceConnectorManifest[] =
  macDeviceConnectorDefinitions.map(serializeDeviceConnector);

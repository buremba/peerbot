import { beforeAll, describe, expect, mock, test } from "bun:test";
import { authorizeCapabilities } from "@lobu/core";
import type { ConnectorDefinition } from "@lobu/connector-sdk";
import { connectorSdkMock } from "./connector-sdk.mock";

mock.module("@lobu/connector-sdk", connectorSdkMock);

const CONNECTOR_MODULES = [
  "../google-takeout.connector",
  "../instagram-takeout.connector",
  "../twitter-takeout.connector",
] as const;

type ConnectorModule = {
  default: new () => { definition: ConnectorDefinition };
};

let definitions: ConnectorDefinition[] = [];

beforeAll(async () => {
  definitions = await Promise.all(
    CONNECTOR_MODULES.map(async (mod) => {
      const { default: Connector } = (await import(mod)) as ConnectorModule;
      return new Connector().definition;
    })
  );
  definitions.sort((a, b) => a.key.localeCompare(b.key));
});

describe("local takeout connectors declare a device runtime", () => {
  test("each requires os.files on macos", () => {
    expect(definitions.map((definition) => definition.key)).toEqual([
      "google.takeout",
      "instagram.takeout",
      "twitter.takeout",
    ]);
    for (const definition of definitions) {
      expect(definition.requiredCapability).toBe("os.files");
      expect(definition.runtime?.platforms).toEqual(["macos"]);
    }
  });

  test("os.files is authorized for macos but not chrome-extension", () => {
    expect(authorizeCapabilities("macos", ["os.files"])).toEqual({
      authorized: ["os.files"],
      dropped: [],
    });
    expect(authorizeCapabilities("chrome-extension", ["os.files"])).toEqual({
      authorized: [],
      dropped: ["os.files"],
    });
  });
});

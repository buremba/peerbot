/**
 * WhatsApp credential storage using environment variable or file.
 * Credentials are stored as base64-encoded JSON.
 */

import { existsSync, readFileSync } from "node:fs";
import { createLogger } from "@lobu/core";
import type {
  AuthenticationCreds,
  SignalDataTypeMap,
} from "@whiskeysockets/baileys";
import { BufferJSON, initAuthCreds } from "@whiskeysockets/baileys";

const logger = createLogger("whatsapp-auth");

/**
 * In-memory auth state that can be serialized/deserialized from env var.
 */
export interface AuthState {
  creds: AuthenticationCreds;
  keys: Map<string, Record<string, unknown>>;
}

/**
 * Load credentials from base64-encoded environment variable or file.
 * If envValue is a file path (starts with / or ./), read from file.
 * Otherwise, treat as base64-encoded credentials string.
 */
export function loadCredentialsFromEnv(envValue?: string): AuthState | null {
  if (!envValue) {
    return null;
  }

  let base64Content: string;

  // Check if envValue is a file path
  if (envValue.startsWith("/") || envValue.startsWith("./")) {
    try {
      if (!existsSync(envValue)) {
        logger.error({ path: envValue }, "Credentials file not found");
        return null;
      }
      base64Content = readFileSync(envValue, "utf-8").trim();
      logger.info({ path: envValue }, "Loaded WhatsApp credentials from file");
    } catch (err) {
      logger.error(
        { error: String(err), path: envValue },
        "Failed to read credentials file"
      );
      return null;
    }
  } else {
    base64Content = envValue;
  }

  try {
    const json = Buffer.from(base64Content, "base64").toString("utf-8");
    const data = JSON.parse(json, BufferJSON.reviver);

    if (!data.creds) {
      logger.warn("Invalid credentials: missing creds field");
      return null;
    }

    const keys = new Map<string, Record<string, unknown>>();
    if (data.keys && typeof data.keys === "object") {
      for (const [category, values] of Object.entries(data.keys)) {
        keys.set(category, values as Record<string, unknown>);
      }
    }

    return {
      creds: data.creds,
      keys,
    };
  } catch (err) {
    logger.error({ error: String(err) }, "Failed to parse credentials");
    return null;
  }
}

/**
 * Serialize auth state to base64-encoded JSON for storage.
 */
export function serializeCredentials(state: AuthState): string {
  const keysObj: Record<string, Record<string, unknown>> = {};
  for (const [category, values] of state.keys.entries()) {
    keysObj[category] = values;
  }

  const data = {
    creds: state.creds,
    keys: keysObj,
  };

  const json = JSON.stringify(data, BufferJSON.replacer);
  return Buffer.from(json).toString("base64");
}

/**
 * Create auth state adapter for Baileys.
 * This provides the interface Baileys expects for credential management.
 */
export function createAuthState(initialState: AuthState | null): {
  state: {
    creds: AuthenticationCreds;
    keys: {
      get: <T extends keyof SignalDataTypeMap>(
        type: T,
        ids: string[]
      ) => Promise<{ [id: string]: SignalDataTypeMap[T] | undefined }>;
      set: (
        data: {
          [T in keyof SignalDataTypeMap]?: {
            [id: string]: SignalDataTypeMap[T] | null;
          };
        }
      ) => Promise<void>;
    };
  };
  saveCreds: () => Promise<string>;
  getSerializedState: () => string;
} {
  // Initialize with provided state or fresh credentials
  const creds = initialState?.creds || initAuthCreds();
  const keys = initialState?.keys || new Map<string, Record<string, unknown>>();

  const state = {
    creds,
    keys: {
      get: async <T extends keyof SignalDataTypeMap>(
        type: T,
        ids: string[]
      ): Promise<{ [id: string]: SignalDataTypeMap[T] }> => {
        const categoryData = keys.get(type) || {};
        const result: { [id: string]: SignalDataTypeMap[T] } = {};

        for (const id of ids) {
          const value = categoryData[id];
          if (value !== undefined) {
            result[id] = value as SignalDataTypeMap[T];
          }
        }

        return result;
      },
      set: async (
        data: {
          [T in keyof SignalDataTypeMap]?: {
            [id: string]: SignalDataTypeMap[T] | null;
          };
        }
      ): Promise<void> => {
        for (const [category, values] of Object.entries(data)) {
          if (!values) continue;

          let categoryData = keys.get(category);
          if (!categoryData) {
            categoryData = {};
            keys.set(category, categoryData);
          }

          for (const [id, value] of Object.entries(values)) {
            if (value === null) {
              delete categoryData[id];
            } else {
              categoryData[id] = value as unknown as Record<
                string,
                unknown
              >[string];
            }
          }
        }
      },
    },
  };

  const getSerializedState = (): string => {
    return serializeCredentials({ creds: state.creds, keys });
  };

  const saveCreds = async (): Promise<string> => {
    // Return serialized state - caller is responsible for persisting
    return getSerializedState();
  };

  return {
    state,
    saveCreds,
    getSerializedState,
  };
}

/**
 * Log credentials update without emitting credential material.
 */
export function logCredentialsUpdateInstruction(
  serializedLength: number
): void {
  logger.info(
    { serializedLength },
    "WhatsApp credentials updated in memory; persist via secure secret storage (WHATSAPP_CREDENTIALS)."
  );
}

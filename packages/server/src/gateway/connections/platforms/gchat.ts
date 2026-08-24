/**
 * Google Chat capability descriptor. Lobu resolves stored service-account JSON
 * as a string, while Chat SDK expects an object/auth client. Google also
 * sends standalone Chat API interaction events in a different envelope from
 * the Workspace Add-on envelope Chat SDK currently parses. Both translations
 * stay at this adapter boundary so storage and the cross-platform message
 * pipeline remain platform-neutral.
 */

import type {
  GoogleChatAdapter,
  GoogleChatAdapterConfig,
  ServiceAccountCredentials,
} from "@chat-adapter/gchat";
import type { WebhookOptions } from "chat";
import { extractWhatsAppStyleRoutingInfo } from "./shared.js";
import type {
  AdapterCreationContext,
  ChatPlatformDescriptor,
} from "./types.js";

type JsonObject = Record<string, any>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function actionParameters(value: unknown): Record<string, string> | undefined {
  if (isObject(value)) {
    const entries = Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    );
    return entries.length > 0
      ? Object.fromEntries(entries)
      : undefined;
  }
  if (!Array.isArray(value)) return undefined;
  const entries = value.flatMap((parameter) =>
    isObject(parameter) &&
    typeof parameter.key === "string" &&
    typeof parameter.value === "string"
      ? [[parameter.key, parameter.value] as const]
      : []
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/** Translate standalone Chat API events into Chat SDK's Add-on envelope. */
function normalizeGoogleChatInteractionEvent(body: unknown): unknown {
  if (!isObject(body) || isObject(body.chat)) return body;

  const eventType =
    typeof body.type === "string"
      ? body.type
      : typeof body.eventType === "string"
        ? body.eventType
        : undefined;
  if (!eventType) return body;

  const message = isObject(body.message) ? body.message : undefined;
  const space = isObject(body.space)
    ? body.space
    : isObject(message?.space)
      ? message.space
      : undefined;
  const user = isObject(body.user)
    ? body.user
    : isObject(message?.sender)
      ? message.sender
      : undefined;
  const chat = {
    ...(user ? { user } : {}),
    ...(typeof body.eventTime === "string" ? { eventTime: body.eventTime } : {}),
  } as JsonObject;

  if (eventType === "MESSAGE" && message && space) {
    chat.messagePayload = { message, space };
  } else if (eventType === "ADDED_TO_SPACE" && space) {
    chat.addedToSpacePayload = { space };
  } else if (eventType === "REMOVED_FROM_SPACE" && space) {
    chat.removedFromSpacePayload = { space };
  } else if (eventType === "CARD_CLICKED" && space) {
    chat.buttonClickedPayload = {
      space,
      ...(message ? { message } : {}),
      ...(user ? { user } : {}),
    };
  } else {
    return body;
  }

  const common = isObject(body.common) ? body.common : {};
  const action = isObject(body.action) ? body.action : {};
  const parameters =
    actionParameters(common.parameters) ?? actionParameters(action.parameters);
  const invokedFunction =
    typeof common.invokedFunction === "string"
      ? common.invokedFunction
      : typeof action.actionMethodName === "string"
        ? action.actionMethodName
        : undefined;
  const formInputs = isObject(common.formInputs)
    ? common.formInputs
    : isObject(action.formInputs)
      ? action.formInputs
      : undefined;

  return {
    ...body,
    chat,
    ...(invokedFunction || parameters || formInputs
      ? {
          commonEventObject: {
            ...(invokedFunction ? { invokedFunction } : {}),
            ...(parameters ? { parameters } : {}),
            ...(formInputs ? { formInputs } : {}),
          },
        }
      : {}),
  };
}

async function normalizeWebhookRequest(request: Request): Promise<Request> {
  const rawBody = await request.text();
  let body: unknown;
  try {
    body = normalizeGoogleChatInteractionEvent(JSON.parse(rawBody));
  } catch {
    body = rawBody;
  }
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  return new Request(request.url, {
    method: request.method,
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
    signal: request.signal,
  });
}

export function parseGoogleChatCredentials(
  value: unknown
): ServiceAccountCredentials {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error("Google Chat service account JSON is invalid");
    }
  }
  if (
    !isObject(parsed) ||
    typeof parsed.client_email !== "string" ||
    parsed.client_email.trim().length === 0 ||
    typeof parsed.private_key !== "string" ||
    parsed.private_key.trim().length === 0
  ) {
    throw new Error(
      "Google Chat service account JSON requires client_email and private_key"
    );
  }
  return parsed as ServiceAccountCredentials;
}

async function createAdapter(
  config: JsonObject,
  context?: AdapterCreationContext
): Promise<GoogleChatAdapter> {
  // Preserve the platform registry's existing lazy adapter boundary.
  const { createGoogleChatAdapter } = await import("@chat-adapter/gchat");
  const adapterConfig = { ...config };
  delete adapterConfig.platform;

  // Workspace Add-on webhooks use the manager-owned connection URL as their
  // JWT audience and sign as the Google-managed identity derived from the
  // configured project number. Neither value needs a second config field that
  // can drift from the connection URL or project number.
  if (context?.webhookUrl) {
    adapterConfig.endpointUrl = context.webhookUrl;
  }
  const projectNumber = adapterConfig.googleChatProjectNumber;
  if (
    !adapterConfig.workspaceAddOnServiceAccountEmail &&
    typeof projectNumber === "string" &&
    /^\d+$/.test(projectNumber.trim())
  ) {
    adapterConfig.workspaceAddOnServiceAccountEmail =
      `service-${projectNumber.trim()}@gcp-sa-gsuiteaddons.iam.gserviceaccount.com`;
  }

  const normalizedConfig = adapterConfig.credentials
    ? {
        ...adapterConfig,
        credentials: parseGoogleChatCredentials(adapterConfig.credentials),
      }
    : adapterConfig;

  const adapter = createGoogleChatAdapter(
    normalizedConfig as GoogleChatAdapterConfig
  );
  const handleWebhook = adapter.handleWebhook.bind(adapter);
  adapter.handleWebhook = (
    request: Request,
    options?: WebhookOptions
  ): Promise<Response> =>
    normalizeWebhookRequest(request).then((normalized) =>
      handleWebhook(normalized, options)
    );
  return adapter;
}

export const gchatPlatform: ChatPlatformDescriptor = {
  createAdapter,

  extractRoutingInfo: extractWhatsAppStyleRoutingInfo,
};

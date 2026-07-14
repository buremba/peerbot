import { defineLobuPlugin } from "@lobu/plugin-api";
import { defineGatewayTool, type GatewayParams } from "@lobu/plugin-toolkit";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { generateAudio, generateImage } from "./generation";
import { uploadUserFile } from "./upload";

export {
  fetchAudioProviderSuggestions,
  normalizeAudioProviderSuggestions,
} from "./audio-provider-suggestions";
export { generateAudio, generateImage } from "./generation";
export { uploadUserFile } from "./upload";

export interface MediaPluginParams extends GatewayParams {
  workspaceDir: string;
  onFileUploaded: (data: Record<string, unknown>) => Promise<void> | void;
}

export function createMediaTools(params: MediaPluginParams) {
  const gateway: GatewayParams = params;
  return [
    defineGatewayTool({
      name: "upload_file",
      parameters: Type.Object({
        file_path: Type.String({
          description:
            "Path to the file to show (absolute or relative to workspace)",
        }),
        description: Type.Optional(
          Type.String({ description: "Description of the file" })
        ),
      }),
      run: (args) =>
        uploadUserFile(gateway, args, {
          onUploaded: (data) => params.onFileUploaded(data),
        }),
    }),
    defineGatewayTool({
      name: "generate_image",
      parameters: Type.Object({
        prompt: Type.String({ description: "Image-generation prompt" }),
        size: Type.Optional(
          Type.Union([
            Type.Literal("1024x1024"),
            Type.Literal("1024x1536"),
            Type.Literal("1536x1024"),
            Type.Literal("auto"),
          ])
        ),
        quality: Type.Optional(
          Type.Union([
            Type.Literal("low"),
            Type.Literal("medium"),
            Type.Literal("high"),
            Type.Literal("auto"),
          ])
        ),
        background: Type.Optional(
          Type.Union([
            Type.Literal("transparent"),
            Type.Literal("opaque"),
            Type.Literal("auto"),
          ])
        ),
        format: Type.Optional(
          Type.Union([
            Type.Literal("png"),
            Type.Literal("jpeg"),
            Type.Literal("webp"),
          ])
        ),
      }),
      run: (args) => generateImage(gateway, args),
    }),
    defineGatewayTool({
      name: "generate_audio",
      parameters: Type.Object({
        text: Type.String({ description: "Text to convert to speech" }),
        voice: Type.Optional(Type.String({ description: "Provider voice id" })),
        speed: Type.Optional(Type.Number({ description: "Speech speed" })),
      }),
      run: (args) => generateAudio(gateway, args),
    }),
  ];
}

export function createMediaPlugin(params: MediaPluginParams) {
  return defineLobuPlugin<ToolDefinition>({
    manifest: {
      name: "lobu-media",
      version: "1.0.0",
      apiVersion: 1,
      description:
        "File delivery, image generation, and audio generation tools",
    },
    tools: () => createMediaTools(params),
  });
}

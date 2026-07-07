import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  type ConnectorDefinition,
  ConnectorRuntime,
  type EventEnvelope,
  type SyncContext,
  type SyncResult,
} from "@lobu/connector-sdk";
import {
  assertDirectory,
  batchSize,
  decodeHtml,
  type LocalTakeoutConfig,
  maxEventCursor,
  readJsonFile,
  stableId,
  stripHtml,
  takeBatch,
} from "./takeout-utils.ts";

interface GoogleTakeoutCheckpoint {
  last_youtube_timestamp?: string;
  last_keep_timestamp?: string;
}

interface KeepNote {
  title?: string;
  textContent?: string;
  listContent?: Array<{ text?: string; isChecked?: boolean }>;
  createdTimestampUsec?: number;
  userEditedTimestampUsec?: number;
  isTrashed?: boolean;
  isPinned?: boolean;
  labels?: Array<{ name?: string }>;
}

export default class GoogleTakeoutConnector extends ConnectorRuntime<
  GoogleTakeoutCheckpoint,
  LocalTakeoutConfig
> {
  readonly definition: ConnectorDefinition = {
    key: "google.takeout",
    name: "Google Takeout",
    version: "1.0.0",
    description:
      "Ingests local Google Takeout exports for YouTube history and Keep notes.",
    authSchema: { methods: [{ type: "none" }] },
    feeds: {
      youtube: {
        key: "youtube",
        name: "YouTube Watch History",
        configSchema: localTakeoutSchema("Path to a Google Takeout folder."),
      },
      keep: {
        key: "keep",
        name: "Google Keep Notes",
        configSchema: localTakeoutSchema("Path to a Google Takeout folder."),
      },
    },
  };

  async sync(
    ctx: SyncContext<GoogleTakeoutCheckpoint, LocalTakeoutConfig>
  ): Promise<SyncResult<GoogleTakeoutCheckpoint>> {
    const takeoutDir = assertDirectory(ctx.config, "Google");
    if (ctx.feedKey === "youtube") {
      const events = takeBatch(
        this.readYoutubeEvents(takeoutDir),
        ctx.checkpoint?.last_youtube_timestamp,
        batchSize(ctx.config)
      );
      return {
        events,
        checkpoint: {
          ...ctx.checkpoint,
          last_youtube_timestamp: maxEventCursor(
            events,
            ctx.checkpoint?.last_youtube_timestamp
          ),
        },
      };
    }

    if (ctx.feedKey === "keep") {
      const events = takeBatch(
        this.readKeepEvents(takeoutDir),
        ctx.checkpoint?.last_keep_timestamp,
        batchSize(ctx.config)
      );
      return {
        events,
        checkpoint: {
          ...ctx.checkpoint,
          last_keep_timestamp: maxEventCursor(
            events,
            ctx.checkpoint?.last_keep_timestamp
          ),
        },
      };
    }

    throw new Error(`Unknown Google Takeout feed: ${ctx.feedKey}`);
  }

  private readYoutubeEvents(takeoutDir: string): EventEnvelope[] {
    const filePath = path.join(
      takeoutDir,
      "YouTube and YouTube Music",
      "history",
      "watch-history.html"
    );
    if (!existsSync(filePath)) return [];
    const html = readFileSync(filePath, "utf8");
    const cells =
      html.match(
        /<div class="outer-cell[\s\S]*?(?=<div class="outer-cell|<\/body>)/g
      ) ?? [];

    return cells.flatMap((cell) => {
      const links = [
        ...cell.matchAll(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g),
      ].map((match) => ({
        href: decodeHtml(match[1] ?? ""),
        text: stripHtml(match[2] ?? ""),
      }));
      const title = links[0]?.text;
      if (!title) return [];
      const text = stripHtml(cell);
      const timestampMatch =
        text.match(
          /[A-Z][a-z]{2} \d{1,2}, \d{4}, \d{1,2}:\d{2}:\d{2}\s*[AP]M [A-Z]{2,4}/
        ) ??
        text.match(
          /[A-Z][a-z]+ \d{1,2}, \d{4} at \d{1,2}:\d{2}:\d{2}\s*[AP]M [A-Z]{2,4}/
        );
      const occurredAt = timestampMatch
        ? parseGoogleTakeoutTimestamp(timestampMatch[0])
        : undefined;
      if (!occurredAt || Number.isNaN(occurredAt.getTime())) return [];

      const channel = links[1];
      return [
        {
          origin_id: stableId("google_youtube_watch", [
            links[0]?.href,
            occurredAt.toISOString(),
            title,
          ]),
          origin_type: "video_watch",
          occurred_at: occurredAt,
          title,
          source_url: links[0]?.href,
          author_name: channel?.text,
          payload_text: [
            `Watched YouTube video: ${title}`,
            channel?.text ? `Channel: ${channel.text}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
          metadata: {
            platform: "youtube",
            video_url: links[0]?.href,
            channel_name: channel?.text,
            channel_url: channel?.href,
          },
        },
      ];
    });
  }

  private readKeepEvents(takeoutDir: string): EventEnvelope[] {
    const keepDir = path.join(takeoutDir, "Keep");
    if (!existsSync(keepDir)) return [];
    return readdirSync(keepDir)
      .filter((file) => file.endsWith(".json"))
      .flatMap((file) => {
        const filePath = path.join(keepDir, file);
        const note = readJsonFile<KeepNote>(filePath);
        if (!note) return [];
        const occurredAt = note.createdTimestampUsec
          ? new Date(Math.floor(note.createdTimestampUsec / 1000))
          : undefined;
        if (!occurredAt || Number.isNaN(occurredAt.getTime())) return [];

        const listText = note.listContent
          ?.map(
            (item) => `- ${item.text ?? ""}${item.isChecked ? " (done)" : ""}`
          )
          .join("\n");
        const payload = [note.title, note.textContent, listText]
          .filter(Boolean)
          .join("\n")
          .trim();
        if (!payload) return [];

        return [
          {
            origin_id: stableId("google_keep_note", [
              file,
              note.createdTimestampUsec,
              note.title,
            ]),
            origin_type: "note",
            occurred_at: occurredAt,
            title: note.title,
            payload_text: payload,
            metadata: {
              platform: "google_keep",
              file,
              is_trashed: note.isTrashed ?? false,
              is_pinned: note.isPinned ?? false,
              labels:
                note.labels?.map((label) => label.name).filter(Boolean) ?? [],
              edited_at: note.userEditedTimestampUsec
                ? new Date(
                    Math.floor(note.userEditedTimestampUsec / 1000)
                  ).toISOString()
                : undefined,
            },
          },
        ];
      });
  }
}

const GOOGLE_TZ_OFFSETS: Record<string, string> = {
  UTC: "+0000",
  GMT: "+0000",
  BST: "+0100",
  CET: "+0100",
  CEST: "+0200",
  EET: "+0200",
  EEST: "+0300",
  PST: "-0800",
  PDT: "-0700",
  MST: "-0700",
  MDT: "-0600",
  CST: "-0600",
  CDT: "-0500",
  EST: "-0500",
  EDT: "-0400",
  IST: "+0530",
};

function parseGoogleTakeoutTimestamp(input: string): Date | undefined {
  const normalized = input.replace(" at ", ", ");
  const match = normalized.match(
    /^(.*\d{1,2}:\d{2}:\d{2}\s*[AP]M) ([A-Z]{2,4})$/
  );
  if (!match) return parseDateOrUndefined(normalized);

  const [, datePart, zone] = match;
  const offset = zone ? GOOGLE_TZ_OFFSETS[zone] : undefined;
  return parseDateOrUndefined(offset ? `${datePart} GMT${offset}` : datePart);
}

function parseDateOrUndefined(input: string | undefined): Date | undefined {
  if (!input) return undefined;
  const date = new Date(input);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function localTakeoutSchema(description: string): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      takeout_dir: { type: "string", description },
      batch_size: {
        type: "integer",
        minimum: 1,
        maximum: 5000,
        default: 1000,
        description: "Maximum events to emit per sync run.",
      },
    },
  };
}

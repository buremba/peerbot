/**
 * QMSum connector — reads Yale-LILY QMSum meeting transcripts from a local
 * directory and emits one event per merged speaking turn, with entity links
 * to `meeting` + `speaker` entities.
 *
 * Why merged speaking turns (vs raw per-turn): QMSum transcripts contain many
 * single-word turns ("Yeah .", "Hmm hmm hmm ."), and embeddings of those are
 * useless for retrieval. Consecutive same-speaker turns are joined into one
 * event; the gold turn-index range is preserved as `turn_idx_start` and
 * `turn_idx_end` metadata so QMSum's `relevant_text_span` overlap checks
 * still work.
 *
 * Speaker identity rules differ by domain (the raw labels mean different
 * things across the corpus):
 *   - Academic:  Grad A/B/C/D are per-file anonymous codes.   → per-meeting
 *   - Product:   Industrial Designer / Marketing / PM / UI    → per-domain
 *   - Committee: real persistent names (e.g. "Barry Hughes")  → per-domain
 *
 * Auto-discovered by `lobu apply` because the filename ends in `.connector.ts`.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  type ActionContext,
  type ActionResult,
  type ConnectorDefinition,
  ConnectorRuntime,
  type EventEnvelope,
  type SyncContext,
  type SyncResult,
} from "@lobu/connector-sdk";

// ─── Config + data shape ────────────────────────────────────────────────

interface QmsumConfig {
  /** Absolute or project-relative path to a QMSum data directory. */
  data_dir: string;
  /** Optional cap on meetings ingested per domain (for stratified sampling). */
  per_domain_limit?: number;
  /** Skip turns shorter than this many characters AFTER merging. Default: 1. */
  min_turn_chars?: number;
}

interface QmsumCheckpoint {
  seen_meetings: string[];
}

type Domain = "Academic" | "Product" | "Committee";

interface QmsumTurn {
  speaker: string;
  content: string;
}

interface QmsumTopic {
  topic: string;
  relevant_text_span: Array<[string, string]>;
}

interface QmsumMeetingFile {
  meeting_transcripts: QmsumTurn[];
  topic_list?: QmsumTopic[];
  general_query_list?: unknown[];
  specific_query_list?: unknown[];
}

// ─── Identity namespaces ─────────────────────────────────────────────────

const NS_MEETING = "qmsum_meeting";
const NS_SPEAKER = "qmsum_speaker";

function speakerIdentity(
  domain: Domain,
  label: string,
  meetingId: string
): string {
  if (domain === "Academic") {
    return `academic::${meetingId}::${label}`;
  }
  return `${domain.toLowerCase()}::${label}`;
}

function speakerScope(domain: Domain): "per-meeting" | "per-domain" {
  return domain === "Academic" ? "per-meeting" : "per-domain";
}

// ─── Connector ───────────────────────────────────────────────────────────

const DOMAINS: Domain[] = ["Academic", "Product", "Committee"];

export default class QmsumConnector extends ConnectorRuntime {
  readonly definition: ConnectorDefinition = {
    key: "qmsum",
    name: "QMSum",
    description:
      "Ingests QMSum meeting transcripts (Yale-LILY) as merged speaking-turn events.",
    version: "0.1.0",
    authSchema: { methods: [{ type: "none" }] },
    feeds: {
      transcripts: {
        key: "transcripts",
        name: "Meeting transcripts",
        description:
          "Per-meeting JSON files from data/qmsum/{Academic,Product,Committee}/.",
        configSchema: {
          type: "object",
          required: ["data_dir"],
          properties: {
            data_dir: {
              type: "string",
              description:
                "Path to the QMSum repo's data/ directory (or any compatible layout).",
            },
            per_domain_limit: { type: "number" },
            min_turn_chars: { type: "number" },
          },
        },
        eventKinds: {
          speaker_turn: {
            description: "A merged run of consecutive turns by one speaker.",
            entityLinks: [
              {
                entityType: "meeting",
                autoCreate: true,
                titlePath: "metadata.meeting_id",
                identities: [
                  { namespace: NS_MEETING, eventPath: "metadata.meeting_id" },
                ],
                traits: {
                  domain: {
                    eventPath: "metadata.domain",
                    behavior: "init_only",
                  },
                  source_file: {
                    eventPath: "metadata.source_file",
                    behavior: "init_only",
                  },
                },
              },
              {
                entityType: "speaker",
                autoCreate: true,
                titlePath: "metadata.speaker_label",
                identities: [
                  {
                    namespace: NS_SPEAKER,
                    eventPath: "metadata.speaker_identity",
                  },
                ],
                traits: {
                  label: {
                    eventPath: "metadata.speaker_label",
                    behavior: "init_only",
                  },
                  domain: {
                    eventPath: "metadata.domain",
                    behavior: "init_only",
                  },
                  scope: {
                    eventPath: "metadata.speaker_scope",
                    behavior: "init_only",
                  },
                  meeting_id: {
                    eventPath: "metadata.meeting_id",
                    behavior: "init_only",
                  },
                },
              },
            ],
            metadataSchema: {
              type: "object",
              required: [
                "meeting_id",
                "domain",
                "source_file",
                "speaker_label",
                "speaker_identity",
                "speaker_scope",
                "turn_idx_start",
                "turn_idx_end",
              ],
              properties: {
                meeting_id: { type: "string" },
                domain: { type: "string", enum: DOMAINS },
                source_file: { type: "string" },
                speaker_label: { type: "string" },
                speaker_identity: { type: "string" },
                speaker_scope: {
                  type: "string",
                  enum: ["per-meeting", "per-domain"],
                },
                turn_idx_start: { type: "number" },
                turn_idx_end: { type: "number" },
                topic_slug: { type: "string" },
              },
            },
          },
        },
      },
    },
    optionsSchema: {
      type: "object",
      required: ["data_dir"],
      properties: {
        data_dir: { type: "string" },
        per_domain_limit: { type: "number" },
        min_turn_chars: { type: "number" },
      },
    },
  };

  async sync(ctx: SyncContext): Promise<SyncResult> {
    const config = ctx.config as unknown as QmsumConfig;
    if (!config?.data_dir) {
      throw new Error("qmsum: `data_dir` is required");
    }

    const checkpoint = (ctx.checkpoint as QmsumCheckpoint | null) ?? {
      seen_meetings: [],
    };
    const seen = new Set<string>(checkpoint.seen_meetings ?? []);

    const events: EventEnvelope[] = [];
    const newMeetingIds: string[] = [];

    for (const domain of DOMAINS) {
      const files = await this.listMeetingFiles(config.data_dir, domain);
      const limited = config.per_domain_limit
        ? files.slice(0, config.per_domain_limit)
        : files;

      for (const fileName of limited) {
        const meetingId = stripJsonExt(fileName);
        if (seen.has(`${domain}::${meetingId}`)) continue;

        const filePath = join(config.data_dir, domain, fileName);
        const raw = await readFile(filePath, "utf-8");
        const parsed = JSON.parse(raw) as QmsumMeetingFile;

        const meetingEvents = this.buildMeetingEvents({
          meetingId,
          domain,
          sourceFile: filePath,
          file: parsed,
          minTurnChars: config.min_turn_chars ?? 1,
        });

        events.push(...meetingEvents);
        seen.add(`${domain}::${meetingId}`);
        newMeetingIds.push(`${domain}::${meetingId}`);
      }
    }

    const allKnown = [...(checkpoint.seen_meetings ?? []), ...newMeetingIds];
    return {
      events,
      checkpoint: { seen_meetings: allKnown } as unknown as Record<
        string,
        unknown
      >,
      metadata: {
        meetings_ingested: newMeetingIds.length,
        events_emitted: events.length,
      },
    };
  }

  async execute(_ctx: ActionContext): Promise<ActionResult> {
    return { success: false, error: "Actions not supported" };
  }

  // ─── helpers ──────────────────────────────────────────────────────────

  private async listMeetingFiles(
    dataDir: string,
    domain: Domain
  ): Promise<string[]> {
    const candidatePaths = [
      join(dataDir, domain), // QMSum/data/Academic — but no train/val/test layer
      join(dataDir, domain, "test"),
      join(dataDir, domain, "val"),
      join(dataDir, domain, "train"),
    ];

    const found: string[] = [];
    for (const path of candidatePaths) {
      const exists = await stat(path).then(
        (s) => s.isDirectory(),
        () => false
      );
      if (!exists) continue;
      const entries = await readdir(path);
      for (const entry of entries) {
        if (entry.endsWith(".json")) found.push(entry);
      }
      // QMSum's actual layout is data/{Domain}/{train,val,test}/*.json — take
      // the first directory that has JSON files and stop. Don't double-count
      // across splits.
      if (found.length > 0) break;
    }
    return found.sort();
  }

  private buildMeetingEvents(args: {
    meetingId: string;
    domain: Domain;
    sourceFile: string;
    file: QmsumMeetingFile;
    minTurnChars: number;
  }): EventEnvelope[] {
    const { meetingId, domain, sourceFile, file, minTurnChars } = args;
    const turns = file.meeting_transcripts ?? [];
    if (turns.length === 0) return [];

    const topicIndex = buildTopicIndex(file.topic_list ?? []);
    const merged = mergeConsecutiveTurns(turns);

    const occurredAt = new Date(); // QMSum has no timestamps; use ingest time
    const events: EventEnvelope[] = [];

    for (const run of merged) {
      const content = run.content.trim();
      if (content.length < minTurnChars) continue;

      const speakerLabel = run.speaker;
      const speakerIdent = speakerIdentity(domain, speakerLabel, meetingId);
      const topicSlug = topicIndex.findTopic(
        run.turn_idx_start,
        run.turn_idx_end
      );

      events.push({
        origin_id: `${meetingId}#${run.turn_idx_start}-${run.turn_idx_end}`,
        origin_type: "speaker_turn",
        payload_type: "text",
        payload_text: content,
        author_name: speakerLabel,
        title: `${meetingId} · ${speakerLabel} · turns ${run.turn_idx_start}–${run.turn_idx_end}`,
        occurred_at: occurredAt,
        semantic_type: "communication",
        metadata: {
          meeting_id: meetingId,
          domain,
          source_file: sourceFile,
          speaker_label: speakerLabel,
          speaker_identity: speakerIdent,
          speaker_scope: speakerScope(domain),
          turn_idx_start: run.turn_idx_start,
          turn_idx_end: run.turn_idx_end,
          ...(topicSlug ? { topic_slug: topicSlug } : {}),
        },
      });
    }

    return events;
  }
}

// ─── pure helpers (no class state) ───────────────────────────────────────

interface MergedRun {
  speaker: string;
  content: string;
  turn_idx_start: number;
  turn_idx_end: number;
}

function mergeConsecutiveTurns(turns: QmsumTurn[]): MergedRun[] {
  const out: MergedRun[] = [];
  let current: MergedRun | undefined;

  turns.forEach((turn, idx) => {
    if (current && current.speaker === turn.speaker) {
      current.content += " " + turn.content.trim();
      current.turn_idx_end = idx;
    } else {
      if (current) out.push(current);
      current = {
        speaker: turn.speaker,
        content: turn.content.trim(),
        turn_idx_start: idx,
        turn_idx_end: idx,
      };
    }
  });
  if (current) out.push(current);

  return out;
}

interface TopicIndex {
  findTopic(turnStart: number, turnEnd: number): string | undefined;
}

function buildTopicIndex(topics: QmsumTopic[]): TopicIndex {
  // Each topic has potentially multiple [start,end] ranges as string ints.
  // We pick the topic whose any range fully contains [turnStart, turnEnd],
  // else the topic whose range overlaps the most.
  const compiled = topics.map((t) => ({
    slug: slugifyTopic(t.topic),
    ranges: (t.relevant_text_span ?? []).map(
      ([s, e]) => [Number(s), Number(e)] as [number, number]
    ),
  }));

  return {
    findTopic(turnStart: number, turnEnd: number): string | undefined {
      let bestSlug: string | undefined;
      let bestOverlap = 0;
      for (const topic of compiled) {
        for (const [rs, re] of topic.ranges) {
          const overlap = Math.max(
            0,
            Math.min(turnEnd, re) - Math.max(turnStart, rs) + 1
          );
          if (overlap > bestOverlap) {
            bestOverlap = overlap;
            bestSlug = topic.slug;
          }
        }
      }
      return bestSlug;
    },
  };
}

function slugifyTopic(topic: string): string {
  return topic
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function stripJsonExt(name: string): string {
  return name.endsWith(".json") ? name.slice(0, -".json".length) : name;
}

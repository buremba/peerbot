#!/usr/bin/env bun
/**
 * Reads QMSum meeting JSONs from `data/qmsum/data/{Academic,Product,Committee}/`
 * and emits parametric test fixtures under `.eval-fixtures/`.
 *
 *   .eval-fixtures/specific.jsonl       — from specific_query_list (gold span + answer)
 *   .eval-fixtures/general.jsonl        — from general_query_list (meeting-wide summaries)
 *   .eval-fixtures/attribution.jsonl    — specific queries that name a speaker
 *   .eval-fixtures/cross-meeting.jsonl  — hand-authored synthesis questions
 *
 * Stratified across domains. Capped via `PER_DOMAIN_QUERIES` so the demo
 * eval set stays in the 50–100 range (codex review: prove a signal, not
 * benchmark-paper coverage).
 *
 * Gold answers + gold spans live ONLY in .eval-fixtures/ (gitignored). They
 * MUST NOT be applied to the agent's memory — keeps the agent honest.
 */

import { existsSync, mkdirSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";

const PROJECT_ROOT = resolve(dirname(import.meta.path), "..");
const DATA_ROOT = join(PROJECT_ROOT, "data", "qmsum", "data");
const FIXTURE_DIR = join(PROJECT_ROOT, ".eval-fixtures");

const DOMAINS = ["Academic", "Product", "Committee"] as const;
type Domain = (typeof DOMAINS)[number];

const PER_DOMAIN_GENERAL = 10; // → up to 30 meeting-summary cases
const PER_DOMAIN_SPECIFIC = 15; // → up to 45 specific-query cases
const PER_DOMAIN_ATTRIB = 5; // → up to 15 attribution cases

interface QmsumMeetingFile {
  meeting_transcripts: { speaker: string; content: string }[];
  general_query_list?: { query: string; answer: string }[];
  specific_query_list?: {
    query: string;
    answer: string;
    relevant_text_span: Array<[string, string]>;
  }[];
}

interface JsonlRow {
  [key: string]: unknown;
}

async function main() {
  if (!existsSync(DATA_ROOT)) {
    console.error(
      `Missing QMSum data at ${DATA_ROOT}.\n` +
        `Run: git clone https://github.com/Yale-LILY/QMSum.git ./data/qmsum`
    );
    process.exit(1);
  }

  mkdirSync(FIXTURE_DIR, { recursive: true });

  const specific: JsonlRow[] = [];
  const general: JsonlRow[] = [];
  const attribution: JsonlRow[] = [];

  for (const domain of DOMAINS) {
    const files = await listMeetingFiles(domain);
    const specificThisDomain: JsonlRow[] = [];
    const generalThisDomain: JsonlRow[] = [];
    const attribThisDomain: JsonlRow[] = [];

    for (const filePath of files) {
      const raw = await readFile(filePath, "utf-8");
      const parsed = JSON.parse(raw) as QmsumMeetingFile;
      const meetingId = baseName(filePath);

      for (const g of parsed.general_query_list ?? []) {
        generalThisDomain.push({
          query: g.query,
          gold_answer: g.answer,
          meeting_id: meetingId,
          domain,
        });
      }

      const transcripts = parsed.meeting_transcripts ?? [];
      for (const s of parsed.specific_query_list ?? []) {
        const goldSpans = (s.relevant_text_span ?? []).map(
          ([start, end]) => [Number(start), Number(end)] as [number, number]
        );
        const row: JsonlRow = {
          query: s.query,
          gold_answer: s.answer,
          gold_spans: goldSpans,
          meeting_id: meetingId,
          domain,
        };
        specificThisDomain.push(row);

        const speaker = guessSpeakerFromQuery(s.query, transcripts);
        if (speaker) {
          attribThisDomain.push({
            query: s.query,
            gold_answer: s.answer,
            expected_speaker: speaker,
            meeting_id: meetingId,
            domain,
          });
        }
      }
    }

    specific.push(...take(specificThisDomain, PER_DOMAIN_SPECIFIC));
    general.push(...take(generalThisDomain, PER_DOMAIN_GENERAL));
    attribution.push(...take(attribThisDomain, PER_DOMAIN_ATTRIB));
  }

  // Hand-authored cross-meeting cases — these need real corpus knowledge to
  // ground; leave skeleton and let the operator extend.
  const crossMeeting: JsonlRow[] = [
    {
      query:
        "Across the ES2004 series (a–d) of Product meetings, how did the remote-control concept evolve?",
      expected_meeting_count: 2,
      related_meetings: ["ES2004a", "ES2004b", "ES2004c", "ES2004d"],
    },
    {
      query:
        "Across the COVID-related Committee meetings, what concerns about the legislation kept recurring?",
      expected_meeting_count: 2,
      related_meetings: ["covid_4", "covid_9"],
    },
  ];

  await writeJsonl(join(FIXTURE_DIR, "specific.jsonl"), specific);
  await writeJsonl(join(FIXTURE_DIR, "general.jsonl"), general);
  await writeJsonl(join(FIXTURE_DIR, "attribution.jsonl"), attribution);
  await writeJsonl(join(FIXTURE_DIR, "cross-meeting.jsonl"), crossMeeting);

  console.log(
    `wrote ${specific.length} specific, ${general.length} general, ` +
      `${attribution.length} attribution, ${crossMeeting.length} cross-meeting`
  );
}

async function listMeetingFiles(domain: Domain): Promise<string[]> {
  const candidates = [
    join(DATA_ROOT, domain),
    join(DATA_ROOT, domain, "test"),
    join(DATA_ROOT, domain, "val"),
    join(DATA_ROOT, domain, "train"),
  ];
  for (const dir of candidates) {
    if (!existsSync(dir)) continue;
    const entries = await readdir(dir).catch(() => []);
    const jsons = entries
      .filter((e) => e.endsWith(".json"))
      .map((e) => join(dir, e));
    if (jsons.length > 0) return jsons.sort();
  }
  return [];
}

function guessSpeakerFromQuery(
  query: string,
  transcripts: { speaker: string }[]
): string | undefined {
  // "What did <Speaker> say about ..." / "What did <Speaker> propose ..."
  const speakers = Array.from(new Set(transcripts.map((t) => t.speaker)));
  for (const s of speakers) {
    if (!s) continue;
    const escaped = s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`\\b${escaped}\\b`, "i");
    if (re.test(query)) return s;
  }
  return undefined;
}

function take<T>(arr: T[], n: number): T[] {
  return arr.slice(0, n);
}

function baseName(filePath: string): string {
  const last = filePath.split("/").pop() ?? filePath;
  return last.endsWith(".json") ? last.slice(0, -".json".length) : last;
}

async function writeJsonl(path: string, rows: JsonlRow[]): Promise<void> {
  await writeFile(
    path,
    rows.map((r) => JSON.stringify(r)).join("\n") + "\n",
    "utf-8"
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

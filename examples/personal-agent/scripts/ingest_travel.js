import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

function parseCSV(text) {
  const lines = text.split("\n");
  const result = [];
  const headers = lines[0]
    .split(",")
    .map((h) => h.trim().replace(/^"|"$/g, ""));

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const values = [];
    let inQuotes = false;
    let currentVal = "";

    for (const char of line) {
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === "," && !inQuotes) {
        values.push(currentVal.trim().replace(/^"|"$/g, ""));
        currentVal = "";
      } else {
        currentVal += char;
      }
    }
    values.push(currentVal.trim().replace(/^"|"$/g, ""));

    const obj = {};
    headers.forEach((header, index) => {
      obj[header] = values[index] || "";
    });
    result.push(obj);
  }
  return result;
}

async function ingestTravelLogs() {
  const BUREMBA_ID = 5714;
  console.log("Loading Travel Logs...");
  const csv = readFileSync("Passport_Travel_Log___FINAL_v2.csv", "utf-8");
  const records = parseCSV(csv);

  const events = records
    .filter((r) => r.Date)
    .map((r, _idx) => ({
      semantic_type: "travel",
      content: r.Notes || `Travel: ${r.Location} (${r.Date})`,
      entity_ids: [BUREMBA_ID],
      metadata: {
        date: r.Date,
        location: r.Location,
        event_type: r.Event,
        needs_confirmation: r.NeedsConfirmation === "True",
      },
    }));

  const CHUNK_SIZE = 100;
  for (let i = 0; i < events.length; i += CHUNK_SIZE) {
    const chunk = events.slice(i, i + CHUNK_SIZE);

    const script = `export default async (ctx, client) => {
      const records = ${JSON.stringify(chunk)};
      const results = await Promise.allSettled(records.map(async (r) => {
         return await client.knowledge.save({
           semantic_type: r.semantic_type,
           content: r.content,
           entity_ids: r.entity_ids,
           metadata: r.metadata
         });
      }));
      return \`Processed \${results.length} records in this batch\`;
    };`;

    console.log(
      `Pushing Travel chunk ${Math.floor(i / CHUNK_SIZE) + 1} / ${Math.ceil(events.length / CHUNK_SIZE)}`
    );
    try {
      execSync(`lobu memory exec '${script.replace(/'/g, "'\\''")}'`, {
        stdio: "inherit",
      });
    } catch (e) {
      console.error(e);
    }
  }
}

ingestTravelLogs();

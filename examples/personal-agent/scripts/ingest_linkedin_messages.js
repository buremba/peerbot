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

async function fetchPersonMap() {
  console.log("Fetching person map from Lobu...");
  const map = {};
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    const script = `export default async (ctx, client) => {
      const res = await client.entities.list({ entity_type_slugs: ["person"], limit: 500, offset: ${offset} });
      return { 
        has_more: res.metadata.has_more, 
        persons: res.entities.map(e => ({ id: e.id, name: e.name })) 
      };
    }`;

    const output = execSync(
      `lobu memory exec '${script.replace(/'/g, "'\\''")}'`,
      { encoding: "utf-8" }
    );

    let outputData;
    try {
      const parsed = JSON.parse(output);
      outputData = parsed.structuredContent || parsed;
    } catch (e) {
      const jsonMatch = output.match(/```json\n([\s\S]*?)\n```/);
      outputData = jsonMatch ? JSON.parse(jsonMatch[1]) : null;
    }

    if (!outputData?.success) {
      console.error(
        "SDK Error:",
        outputData
          ? JSON.stringify(outputData.error, null, 2)
          : "Unknown parse error"
      );
      throw new Error("SDK execution failed");
    }

    const data = outputData.return_value;
    for (const p of data.persons) {
      if (p.name) map[p.name.toLowerCase()] = p.id;
    }

    hasMore = data.has_more;
    offset += 500;
    console.log(`Fetched ${offset} persons...`);
  }
  return map;
}

async function ingestLinkedInMessages() {
  const personMap = await fetchPersonMap();
  const BUREMBA_ID = 5714;

  console.log("Loading LinkedIn Messages...");
  const csv = readFileSync(
    "Basic_LinkedInDataExport_07-05-2026.zip/messages.csv",
    "utf-8"
  );
  const records = parseCSV(csv);

  const events = records
    .filter((r) => r.DATE && r.CONTENT)
    .map((r, _idx) => {
      let isoDate = "";
      try {
        isoDate = new Date(r.DATE).toISOString();
      } catch (e) {
        isoDate = r.DATE;
      }

      const otherName = r.FROM === "Burak Emre Kabakcı" ? r.TO : r.FROM;
      const otherId = personMap[(otherName || "").toLowerCase()];

      const entity_ids = [BUREMBA_ID];
      if (otherId) entity_ids.push(otherId);

      return {
        semantic_type: "direct_message",
        content: r.CONTENT,
        entity_ids,
        metadata: {
          platform: "linkedin",
          timestamp: isoDate,
          direction: r.FROM === "Burak Emre Kabakcı" ? "outbound" : "inbound",
          sender: r.FROM,
          receiver: r.TO,
        },
      };
    });

  console.log(`Parsed ${events.length} messages. Starting chunked upload...`);

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
      `Pushing chunk ${Math.floor(i / CHUNK_SIZE) + 1} / ${Math.ceil(events.length / CHUNK_SIZE)}`
    );
    try {
      execSync(`lobu memory exec '${script.replace(/'/g, "'\\''")}'`, {
        stdio: "inherit",
      });
    } catch (e) {
      console.error(`Failed on chunk ${Math.floor(i / CHUNK_SIZE) + 1}:`, e);
    }
  }

  console.log("Finished LinkedIn Messages ingestion!");
}

ingestLinkedInMessages();

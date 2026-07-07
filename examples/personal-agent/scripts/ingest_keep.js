import { readFileSync, readdirSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";

async function ingestKeep() {
  console.log("Loading Google Keep Notes...");
  const keepDir = "Takeout 2/Keep";
  const files = readdirSync(keepDir);

  const jsonFiles = files.filter((f) => f.endsWith(".json"));
  const knowledgeEvents = [];

  for (const file of jsonFiles) {
    try {
      const data = JSON.parse(readFileSync(path.join(keepDir, file), "utf-8"));

      let content = data.title ? `${data.title}\\n` : "";
      if (data.textContent) content += data.textContent;
      if (data.listContent) {
        content += data.listContent
          .map((item) => `- ${item.text}${item.isChecked ? " (done)" : ""}`)
          .join("\\n");
      }

      if (!content.trim()) continue;

      const metadata = {
        platform: "google_keep",
        timestamp: data.createdTimestampUsec
          ? new Date(data.createdTimestampUsec / 1000).toISOString()
          : null,
        is_trashed: data.isTrashed || false,
        is_pinned: data.isPinned || false,
        labels: data.labels ? data.labels.map((l) => l.name).join(",") : "",
      };

      knowledgeEvents.push({
        semantic_type: "note",
        content: content.trim(),
        entity_ids: [5714], // user's ID
        metadata: metadata,
      });
    } catch (e) {
      // Ignore files that can't be parsed
    }
  }

  console.log(
    `Parsed ${knowledgeEvents.length} Keep notes. Starting chunked upload...`
  );

  const CHUNK_SIZE = 50;
  for (let i = 0; i < knowledgeEvents.length; i += CHUNK_SIZE) {
    const chunk = knowledgeEvents.slice(i, i + CHUNK_SIZE);

    const script = `export default async (ctx, client) => {
      const records = ${JSON.stringify(chunk)};
      const results = await Promise.allSettled(records.map(r => client.knowledge.save(r)));
      return \`Processed \${results.length} notes in this batch\`;
    };`;

    console.log(
      `Pushing notes chunk ${Math.floor(i / CHUNK_SIZE) + 1} / ${Math.ceil(knowledgeEvents.length / CHUNK_SIZE)}`
    );
    try {
      execSync(`lobu memory exec '${script.replace(/'/g, "'\\''")}'`, {
        stdio: "inherit",
      });
    } catch (e) {
      console.error(`Failed on chunk ${Math.floor(i / CHUNK_SIZE) + 1}:`, e);
    }
  }

  console.log("Finished Google Keep ingestion!");
}

ingestKeep().catch(console.error);

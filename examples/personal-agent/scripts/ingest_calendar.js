import { readFileSync } from "fs";
import { execSync } from "child_process";
import ical from "node-ical";

async function ingestCalendar() {
  console.log("Loading Calendar...");
  const events = ical.sync.parseFile("Takeout 2/Calendar/Personal.ics");

  const knowledgeEvents = [];
  
  for (const event of Object.values(events)) {
    if (event.type !== "VEVENT") continue;
    
    // Only ingest events with a summary
    if (!event.summary) continue;

    const metadata = {
      platform: "google_calendar",
      timestamp: event.start ? event.start.toISOString() : null,
      end_timestamp: event.end ? event.end.toISOString() : null,
      location: event.location || "",
      organizer: event.organizer ? (event.organizer.val || event.organizer) : ""
    };

    knowledgeEvents.push({
      semantic_type: "calendar_event",
      content: event.summary + (event.description ? "\\n" + event.description : ""),
      entity_ids: [5714], // user's ID
      metadata: metadata
    });
  }

  console.log(`Parsed ${knowledgeEvents.length} calendar events. Starting chunked upload...`);
  
  const CHUNK_SIZE = 50;
  for (let i = 0; i < knowledgeEvents.length; i += CHUNK_SIZE) {
    const chunk = knowledgeEvents.slice(i, i + CHUNK_SIZE);
    
    const script = `export default async (ctx, client) => {
      const records = ${JSON.stringify(chunk)};
      const results = await Promise.allSettled(records.map(r => client.knowledge.save(r)));
      return \`Processed \${results.length} calendar events in this batch\`;
    };`;

    console.log(`Pushing calendar chunk ${Math.floor(i/CHUNK_SIZE) + 1} / ${Math.ceil(knowledgeEvents.length/CHUNK_SIZE)}`);
    try {
      execSync(`lobu memory exec '${script.replace(/'/g, "'\\''")}'`, { stdio: "inherit" });
    } catch (e) {
      console.error(`Failed on chunk ${Math.floor(i/CHUNK_SIZE) + 1}:`, e);
    }
  }
  
  console.log("Finished Calendar ingestion!");
}

ingestCalendar().catch(console.error);

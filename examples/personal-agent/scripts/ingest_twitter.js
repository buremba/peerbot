import { readFileSync } from "fs";
import { execSync } from "child_process";
import path from "path";

async function ingestTwitter() {
  const BUREMBA_ID = 5714;
  console.log("Loading Twitter...");
  let js = readFileSync("twitter-2026-06-24-e7e50c3bbd92286b4e1d2a542bbbfa969ecd08980a89cab981242f0b8ffb35d2/data/tweets.js", "utf-8");
  js = js.replace(/^window\.YTD\.tweets\.part0 = /, "");
  const tweets = JSON.parse(js);

  const events = tweets.map(t => {
    const tweet = t.tweet;
    return {
      semantic_type: "social_post",
      content: tweet.full_text,
      entity_ids: [BUREMBA_ID],
      metadata: {
        platform: "twitter",
        timestamp: new Date(tweet.created_at).toISOString(),
        id: tweet.id
      }
    };
  });

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
      return \`Processed \${results.length} events in this batch\`;
    };`;

    console.log(`Pushing Twitter chunk ${Math.floor(i/CHUNK_SIZE) + 1} / ${Math.ceil(events.length/CHUNK_SIZE)}`);
    try {
      execSync(`lobu memory exec '${script.replace(/'/g, "'\\''")}'`, { stdio: "inherit" });
    } catch (e) {
      console.error(e);
    }
  }
}

ingestTwitter();

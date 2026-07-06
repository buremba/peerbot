import { readFileSync } from "fs";
import { execSync } from "child_process";
import * as cheerio from "cheerio";

async function ingestYouTube() {
  console.log("Loading YouTube Watch History...");
  const historyFile = "Takeout 3/YouTube and YouTube Music/history/watch-history.html";
  
  let html;
  try {
    html = readFileSync(historyFile, "utf-8");
  } catch(e) {
    console.log("Could not read watch-history.html");
    return;
  }

  const $ = cheerio.load(html);
  const knowledgeEvents = [];
  
  // The items are in .outer-cell
  $(".outer-cell").each((i, el) => {
    const textCell = $(el).find(".content-cell").first();
    const links = textCell.find("a");
    
    // There should be a video link and possibly a channel link
    const videoLink = links.eq(0);
    const channelLink = links.eq(1);
    
    const title = videoLink.text();
    const videoUrl = videoLink.attr("href") || "";
    
    if (!title) return;
    
    const channelName = channelLink.text();
    const channelUrl = channelLink.attr("href") || "";
    
    // The timestamp is usually the last text node after a <br>
    // We can extract text directly from the cell and parse out the timestamp
    const cellText = textCell.text();
    const timestampMatch = cellText.match(/([A-Z][a-z]{2} \d{1,2}, \d{4}, \d{1,2}:\d{2}:\d{2}\u202F[AP]M [A-Z]{3,4})/);
    let timestampStr = timestampMatch ? timestampMatch[1] : null;
    let timestamp = null;
    if (timestampStr) {
      try {
        timestamp = new Date(timestampStr.replace("\u202F", " ")).toISOString();
      } catch (e) {
        timestamp = null;
      }
    }
    
    const content = `Watched YouTube video: ${title}\\nChannel: ${channelName}\\nURL: ${videoUrl}`;
    
    const metadata = {
      platform: "youtube",
      timestamp: timestamp,
      channel_name: channelName,
      channel_url: channelUrl,
      video_url: videoUrl
    };

    knowledgeEvents.push({
      semantic_type: "video_watch",
      content: content,
      entity_ids: [5714], // user's ID
      metadata: metadata
    });
  });

  console.log(`Parsed ${knowledgeEvents.length} YouTube watch events. Starting chunked upload...`);
  
  const CHUNK_SIZE = 50;
  for (let i = 0; i < knowledgeEvents.length; i += CHUNK_SIZE) {
    const chunk = knowledgeEvents.slice(i, i + CHUNK_SIZE);
    
    const script = `export default async (ctx, client) => {
      const records = ${JSON.stringify(chunk)};
      const results = await Promise.allSettled(records.map(r => client.knowledge.save(r)));
      return \`Processed \${results.length} YouTube events in this batch\`;
    };`;

    console.log(`Pushing YouTube chunk ${Math.floor(i/CHUNK_SIZE) + 1} / ${Math.ceil(knowledgeEvents.length/CHUNK_SIZE)}`);
    try {
      execSync(`lobu memory exec '${script.replace(/'/g, "'\\''")}'`, { stdio: "inherit" });
    } catch (e) {
      console.error(`Failed on chunk ${Math.floor(i/CHUNK_SIZE) + 1}:`, e);
    }
  }
  
  console.log("Finished YouTube ingestion!");
}

ingestYouTube().catch(console.error);

import { readFileSync } from "fs";
import { execSync } from "child_process";
import { globSync } from "glob";
import * as cheerio from "cheerio";

async function fetchPersonMap() {
  console.log("Fetching person map from Lobu...");
  const map = {};
  let offset = 0;
  let hasMore = true;

  while(hasMore) {
    const script = `export default async (ctx, client) => {
      const res = await client.entities.list({ entity_type_slugs: ["person"], limit: 500, offset: ${offset} });
      return { 
        has_more: res.metadata.has_more, 
        persons: res.entities.map(e => ({ id: e.id, name: e.name })) 
      };
    }`;
    
    const output = execSync(`lobu memory exec '${script.replace(/'/g, "'\\''")}'`, { encoding: "utf-8" });
    
    let outputData;
    try {
      const parsed = JSON.parse(output);
      outputData = parsed.structuredContent || parsed;
    } catch (e) {
      const jsonMatch = output.match(/```json\n([\s\S]*?)\n```/);
      outputData = jsonMatch ? JSON.parse(jsonMatch[1]) : null;
    }
    
    if (!outputData || !outputData.success) {
      console.error("SDK Error:", outputData ? JSON.stringify(outputData.error, null, 2) : "Unknown parse error");
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

async function ingestInstagramMessages() {
  const personMap = await fetchPersonMap();
  const BUREMBA_ID = 5714;
  
  console.log("Loading Instagram HTML files...");
  const htmlFiles = globSync("instagram-*/your_instagram_activity/messages/inbox/**/*.html");
  
  if (htmlFiles.length === 0) {
    console.log("No Instagram messages found.");
    return;
  }
  
  let allEvents = [];
  
  for (const file of htmlFiles) {
    const html = readFileSync(file, "utf-8");
    const $ = cheerio.load(html);
    
    // Find each message block
    $('.pam._3-95._2ph-._a6-g.uiBoxWhite.noborder').each((_, el) => {
      const sender = $(el).find('h2').text().trim();
      const content = $(el).find('div._3-95._a6-p').text().trim();
      const dateStr = $(el).find('div._3-94._a6-o').text().trim();
      
      if (!sender || !content) return;
      
      let isoDate = dateStr;
      try {
        const d = new Date(dateStr);
        if (!isNaN(d)) isoDate = d.toISOString();
      } catch (e) {}
      
      // Attempt to resolve person ID
      const senderId = personMap[sender.toLowerCase()];
      const entity_ids = [BUREMBA_ID];
      if (senderId && senderId !== BUREMBA_ID) entity_ids.push(senderId);

      allEvents.push({
        semantic_type: "direct_message",
        content: content,
        entity_ids,
        metadata: {
          platform: "instagram",
          timestamp: isoDate,
          direction: sender.toLowerCase() === "burak emre" || sender.toLowerCase().includes("burak") ? "outbound" : "inbound",
          sender: sender
        }
      });
    });
  }

  console.log(`Parsed ${allEvents.length} Instagram messages. Starting chunked upload...`);
  
  const CHUNK_SIZE = 100;
  for (let i = 0; i < allEvents.length; i += CHUNK_SIZE) {
    const chunk = allEvents.slice(i, i + CHUNK_SIZE);
    
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

    console.log(`Pushing Instagram chunk ${Math.floor(i/CHUNK_SIZE) + 1} / ${Math.ceil(allEvents.length/CHUNK_SIZE)}`);
    
    try {
      execSync(`lobu memory exec '${script.replace(/'/g, "'\\''")}'`, { stdio: "inherit" });
    } catch (e) {
      console.error(`Failed on chunk ${Math.floor(i/CHUNK_SIZE) + 1}:`, e);
    }
  }
  
  console.log("Finished Instagram ingestion!");
}

ingestInstagramMessages();

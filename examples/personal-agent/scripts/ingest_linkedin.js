import { readFileSync } from "fs";
import { execSync } from "child_process";

function parseCSV(text) {
  const lines = text.split('\n').slice(3); // Skip first 3 lines (LinkedIn notes)
  const result = [];
  const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
  
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    
    const values = [];
    let inQuotes = false;
    let currentVal = '';
    
    for (let char of line) {
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        values.push(currentVal.trim().replace(/^"|"$/g, ''));
        currentVal = '';
      } else {
        currentVal += char;
      }
    }
    values.push(currentVal.trim().replace(/^"|"$/g, ''));
    
    const obj = {};
    headers.forEach((header, index) => {
      obj[header] = values[index] || "";
    });
    result.push(obj);
  }
  return result;
}

async function ingestLinkedInConnections() {
  console.log("Loading Connections...");
  const csv = readFileSync("Basic_LinkedInDataExport_07-05-2026.zip/Connections.csv", "utf-8");
  const records = parseCSV(csv);
  
  const entities = records
    .filter(r => r["First Name"] || r["Last Name"])
    .map(r => {
       const fullName = `${r["First Name"]} ${r["Last Name"]}`.trim();
       return {
         entity_type: "person",
         slug: `person-${fullName.replace(/[^a-zA-Z0-9]/g, "").toLowerCase()}`,
         name: fullName,
         metadata: {
           first_name: r["First Name"],
           last_name: r["Last Name"],
           email: r["Email Address"],
           company: r["Company"],
           linkedin_url: r["URL"]
         }
       };
    });

  // Deduplicate by slug in memory first
  const uniqueEntities = [];
  const seenSlugs = new Set();
  for (const e of entities) {
    if (!seenSlugs.has(e.slug)) {
      seenSlugs.add(e.slug);
      uniqueEntities.push(e);
    }
  }

  const CHUNK_SIZE = 100;
  for (let i = 0; i < uniqueEntities.length; i += CHUNK_SIZE) {
    const chunk = uniqueEntities.slice(i, i + CHUNK_SIZE);
    
    const script = `export default async (ctx, client) => {
      const records = ${JSON.stringify(chunk)};
      const results = await Promise.allSettled(records.map(async (r) => {
        try {
           return await client.entities.create({
             type: r.entity_type,
             slug: r.slug,
             name: r.name,
             metadata: r.metadata
           });
        } catch(e) {
           if (e.message && e.message.includes('already exists')) {
              // Fetch it to update if needed, or just skip
              return null;
           }
           throw e;
        }
      }));
      return \`Processed \${results.length} records in this batch\`;
    };`;

    console.log(`Pushing LinkedIn Connections chunk ${Math.floor(i/CHUNK_SIZE) + 1} / ${Math.ceil(uniqueEntities.length/CHUNK_SIZE)}`);
    try {
      execSync(`lobu memory exec '${script.replace(/'/g, "'\\''")}'`, { stdio: "inherit" });
    } catch (e) {
      console.error(e);
    }
  }
}

ingestLinkedInConnections();

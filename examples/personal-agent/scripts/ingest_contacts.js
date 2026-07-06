import { readFileSync } from "fs";
import { execSync } from "child_process";
import vcf from "vcf";

async function ingestContacts() {
  console.log("Loading Contacts...");
  const vcfData = readFileSync("Takeout 2/Contacts/All Contacts/All Contacts.vcf", "utf-8");
  const cards = vcf.parse(vcfData);

  const people = cards.map(card => {
    const fn = card.get("fn");
    const name = fn ? fn.valueOf() : "Unknown";
    
    // Attempt to extract first/last name
    let firstName = name;
    let lastName = "";
    if (name && name !== "Unknown") {
      const parts = name.split(" ");
      if (parts.length > 1) {
        lastName = parts.pop();
        firstName = parts.join(" ");
      }
    }
    
    const telProp = card.get("tel");
    let phone = "";
    if (telProp) {
        if (Array.isArray(telProp)) phone = telProp[0].valueOf();
        else phone = telProp.valueOf();
    }
    
    const emailProp = card.get("email");
    let email = "";
    if (emailProp) {
        if (Array.isArray(emailProp)) email = emailProp[0].valueOf();
        else email = emailProp.valueOf();
    }

    const slug = `person-${name.replace(/[^a-zA-Z0-9]/g, "").toLowerCase()}`;

    return {
      type: "person",
      slug,
      name,
      metadata: {
        first_name: firstName,
        last_name: lastName,
        phone: phone,
        email: email
      }
    };
  }).filter(p => p.name !== "Unknown" && p.slug !== "person-");

  console.log(`Parsed ${people.length} contacts. Starting chunked upload...`);
  
  const CHUNK_SIZE = 100;
  for (let i = 0; i < people.length; i += CHUNK_SIZE) {
    const chunk = people.slice(i, i + CHUNK_SIZE);
    
    const script = `export default async (ctx, client) => {
      const records = ${JSON.stringify(chunk)};
      const results = await Promise.allSettled(records.map(async (r) => {
         try {
           return await client.entities.create(r);
         } catch(e) {
           // If it already exists, just return success
           if (e.message && e.message.includes("already exists")) return null;
           throw e;
         }
      }));
      return \`Processed \${results.length} contacts in this batch\`;
    };`;

    console.log(`Pushing contacts chunk ${Math.floor(i/CHUNK_SIZE) + 1} / ${Math.ceil(people.length/CHUNK_SIZE)}`);
    try {
      execSync(`lobu memory exec '${script.replace(/'/g, "'\\''")}'`, { stdio: "inherit" });
    } catch (e) {
      console.error(`Failed on chunk ${Math.floor(i/CHUNK_SIZE) + 1}:`, e);
    }
  }
  
  console.log("Finished Contacts ingestion!");
}

ingestContacts().catch(console.error);

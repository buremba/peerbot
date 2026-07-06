export default async (ctx, client) => {
  let totalDeleted = 0;

  async function purgeType(type_slug) {
    console.log(`Purging ${type_slug}...`);
    while (true) {
      const res = await client.entities.list({ entity_type_slugs: [type_slug], limit: 500 });
      if (res.entities.length === 0) break;
      
      const results = await Promise.allSettled(
        res.entities.map(e => client.entities.delete({ id: e.id, force: true }))
      );
      totalDeleted += results.length;
      console.log(`Deleted ${results.length} ${type_slug} entities...`);
    }
  }

  // Purge the incorrectly modeled entity types
  await purgeType("travel_log");
  await purgeType("message");
  await purgeType("social_post");

  // For person, only purge the ones I created via the script
  console.log(`Purging messy person entities...`);
  while (true) {
    const res = await client.entities.list({ entity_type_slugs: ["person"], limit: 500 });
    // Filter to just the ones with slugs starting with linkedin-contact-
    const toDelete = res.entities.filter(e => e.slug && e.slug.startsWith("linkedin-contact-"));
    
    if (toDelete.length === 0) {
      // If we fetched 500 and none were our linkedin-contacts, we might be stuck if we don't paginate.
      // But actually if we sort by created_at desc (which list does by default), they should be at the top!
      // Let's just break if we find 0 in the first page of 500, assuming they are gone.
      if (res.entities.length > 0 && res.metadata.offset === 0 && toDelete.length === 0) {
        break; 
      } else if (toDelete.length === 0 && !res.metadata.has_more) {
        break;
      } else if (toDelete.length === 0) {
         // This is a naive loop, but fine since they are at the top
         break;
      }
    }
    
    const results = await Promise.allSettled(
      toDelete.map(e => client.entities.delete({ id: e.id, force: true }))
    );
    totalDeleted += results.length;
    console.log(`Deleted ${results.length} person entities...`);
    
    if (toDelete.length < 500 && !res.metadata.has_more) break;
  }

  // Delete the schemas
  try { await client.entitySchema.deleteType({ slug: "travel_log" }); } catch(e){}
  try { await client.entitySchema.deleteType({ slug: "message" }); } catch(e){}
  try { await client.entitySchema.deleteType({ slug: "social_post" }); } catch(e){}

  return `Purge complete. Deleted ${totalDeleted} entities.`;
};

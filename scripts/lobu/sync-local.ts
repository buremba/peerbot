/**
 * Local Sync CLI
 *
 * Runs feeds locally for testing. Uses subprocess execution with DB-stored compiled code.
 *
 * Usage:
 *   pnpm sync:local --feed-id 123           # Run specific feed
 *   pnpm sync:local --type g2               # Run all feeds of a type
 *   pnpm sync:local --all                   # Run all active feeds
 */

import { parseArgs } from 'node:util';
import { fetchFeeds, runFeed } from '../../packages/server/src/lib/feed-sync';

// Parse CLI arguments
const { values } = parseArgs({
  options: {
    'feed-id': { type: 'string' },
    type: { type: 'string' },
    all: { type: 'boolean' },
    help: { type: 'boolean' },
  },
});

if (values.help) {
  console.log(`
Local Sync CLI

Usage:
  pnpm sync:local --feed-id 123    # Run specific feed
  pnpm sync:local --type g2        # Run all feeds of a type
  pnpm sync:local --all            # Run all active feeds

Options:
  --feed-id     Run a specific feed by ID
  --type        Run all feeds of a specific type
  --all         Run all active feeds
  --help        Show this help message
  `);
  process.exit(0);
}

if (!values['feed-id'] && !values.type && !values.all) {
  console.error('Error: Must specify --feed-id, --type, or --all');
  console.error('Run with --help for usage information');
  process.exit(1);
}

async function main() {
  console.log('Local Sync CLI\n');
  console.log('='.repeat(70));

  const filter = {
    feedId: values['feed-id'] ? parseInt(values['feed-id'] as string, 10) : undefined,
    type: values.type as string | undefined,
  };

  const feeds = await fetchFeeds(filter);

  if (feeds.length === 0) {
    console.log('\nNo matching feeds found');
    console.log('Make sure feeds are created and have status = "active"');
    process.exit(0);
  }

  console.log(`\nFound ${feeds.length} feed(s) to run:\n`);
  feeds.forEach((f) => {
    const entityLabel = f.entity_ids.length > 0 ? f.entity_ids.join(', ') : 'none';
    console.log(`  - Feed ${f.id} (${f.feed_key}) - Entities ${entityLabel}`);
  });
  console.log();

  let successCount = 0;
  let failureCount = 0;

  for (const feed of feeds) {
    try {
      const { itemCount } = await runFeed(feed);
      console.log(`Feed ${feed.id} (${feed.feed_key}) completed: ${itemCount} items`);
      successCount++;
    } catch (error: any) {
      console.error(`Feed ${feed.id} (${feed.feed_key}) failed: ${error.message}`);
      failureCount++;
    }
    console.log();
  }

  console.log('='.repeat(70));
  console.log('Summary');
  console.log('='.repeat(70));
  console.log(`Successful: ${successCount}`);
  console.log(`Failed: ${failureCount}`);
  console.log();

  process.exit(failureCount > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

# review-database-url.sh — validate explicit databases used by destructive tests.
# shellcheck shell=bash

validate_review_database_url() {
  local database_url="$1"

  REVIEW_DATABASE_URL_TO_VALIDATE="$database_url" node <<'NODE'
const raw = process.env.REVIEW_DATABASE_URL_TO_VALIDATE;
let url;
try {
  url = new URL(raw);
} catch {
  console.error('REVIEW_DATABASE_URL must be a valid PostgreSQL URL');
  process.exit(2);
}

if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
  console.error('REVIEW_DATABASE_URL must use postgres:// or postgresql://');
  process.exit(2);
}

const databaseName = url.pathname.replace(/^\//, '');
if (!databaseName.startsWith('lobu_test')) {
  console.error("REVIEW_DATABASE_URL database must start with 'lobu_test'");
  process.exit(2);
}

for (const [key] of url.searchParams) {
  const normalized = key.toLowerCase();
  if (normalized.includes('\0') || normalized === 'database' || normalized === 'dbname') {
    console.error(`REVIEW_DATABASE_URL must not override the database via '${key}'`);
    process.exit(2);
  }
}
NODE
}

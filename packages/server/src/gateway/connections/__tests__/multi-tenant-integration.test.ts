import { describe, it } from 'vitest';

describe('multi-tenant gateway/connections', () => {
  it.todo(
    "routes a Slack message from org A user 5 to that user's isolated worker, not org B's"
  );

  it.todo(
    'gives two users in the same org separate sandbox filesystems (no cross-read)'
  );

  it.todo(
    'never exposes raw provider API keys to the worker — only lobu_secret_<uuid> placeholders'
  );

  it.todo(
    'rejects an agent run triggered by a user from org B against an agent owned by org A'
  );
});

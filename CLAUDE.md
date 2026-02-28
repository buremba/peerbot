@AGENTS.md
Use lobu UI components per project conventions when applicable.
Local dev Telegram bot is `@clawdotfreebot` (NOT `@lobuaibot` which is production).
To test Telegram bot, use `TEST_PLATFORM=telegram TEST_CHANNEL=@clawdotfreebot ./scripts/test-bot.sh "message"` (or set `TELEGRAM_TEST_CHAT_ID`); this path uses `tguser` and sends as your real user account.
Direct option: `tguser send @clawdotfreebot "message"` (requires TG_API_ID and TG_API_HASH from .env).
Settings link token TTL defaults to 1 hour and can be overridden in development via `SETTINGS_TOKEN_TTL_MS` (milliseconds, e.g. `4233600000` for 7 weeks).
Settings page provider ordering is drag-sortable via handle, and each provider model selector is inline in the provider row.
When testing locally, always start the stack with `make dev` (docker compose watch) so changes auto-sync.
Default to Telegram (`TEST_PLATFORM=telegram TEST_CHANNEL=@clawdotfreebot`) for bot testing unless a specific platform is specified.

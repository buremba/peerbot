## Summary
<!-- Why this change? 1–3 bullets. Skip if the PR title is self-explanatory. -->

## Test plan
<!-- Check only what you actually ran. See AGENTS.md → "Validation after code changes". -->
- [ ] `bun run check:fix` clean
- [ ] `bun run typecheck` passes (or `make build-packages` if TS packages changed)
- [ ] Package-specific validation (landing: `cd packages/landing && bun run build`)
- [ ] If bot behavior: ran `./scripts/test-bot.sh` or relevant eval

## Notes
<!-- Screenshots, follow-ups, linked issues (`Closes #123`), breaking-change callouts. Delete if none. -->

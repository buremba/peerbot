## Summary
<!-- Why this change? 1–3 bullets. Skip if the PR title is self-explanatory. -->

## Test plan
<!-- Check only what you actually ran. See AGENTS.md → "Ship a change". -->
- [ ] Intended files staged explicitly, then `make pre-pr-remote` clean (full Linux CI graph on Depot; `make pre-pr` only as local fallback)
- [ ] Tests run: `make test-unit` / `make test-integration` / targeted `bun test <path>`
- [ ] Bug fix: red→fix→green outputs pasted below
- [ ] If bot behavior: ran `./scripts/test-bot.sh` or relevant eval

## Notes
<!-- Screenshots, follow-ups, linked issues (`Closes #123`), breaking-change callouts. Delete if none. -->

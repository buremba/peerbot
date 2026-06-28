---
name: account-brief
description: Build a pre-renewal brief for a tracked account from its recent public news and announcements. Use before a renewal call or QBR, after the account-health watcher flags a risk. Reading public news is allowed; do not log in, submit forms, or touch any CRM write endpoint.
nixPackages:
  - jq
---

# Account brief

Use this skill when the user asks for a pre-renewal brief on a tracked account,
or when the `account-health-monitor` watcher flags a risk signal.

## Steps

1. Resolve the company name from the `organization` entity.
2. Fetch recent headlines and filter to the last 90 days.
3. Summarize anything that moves renewal risk: leadership changes, funding,
   layoffs, M&A, or competitive losses.
4. Save a `renewal-risk` entity per material signal, linked to the account with
   the `affects` relationship.

## Rules

- Read public sources only. Never log in, submit forms, or change account,
  billing, or profile data.
- If a source is paywalled or asks for credentials, skip it and note the gap.
- Keep the brief to five bullets or fewer; the rep reads it on a phone.

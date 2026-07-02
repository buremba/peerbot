# Brand intelligence example connectors

Review-site scrapers (Trustpilot, G2, Capterra, Glassdoor), app-store review feeds
(`google_play`, `ios_appstore`), Google Maps business reviews (`gmaps`), and a
generic website scraper. These are **not** bundled with Lobu — they ship as
copy-paste examples because scraping third-party sites may violate their terms of
service. Use at your own risk.

Install into your org from this directory:

```bash
lobu apply
```

Shared browser helpers (`runReviewScrape`, `validateUrlDomain`, checkpoint
pipeline) live in `@lobu/connector-sdk`. Each file here is a site-specific
connector only.
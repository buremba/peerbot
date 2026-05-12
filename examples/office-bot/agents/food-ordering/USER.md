# Office context

> This file is the office's "house settings". Edit it to match the real team — the
> defaults below are placeholders so the agent has something to work with on day one.

- **Office:** London. Timezone Europe/London. Lunch run targets a ~12:30 delivery, so the call goes out ~11:00 and orders close ~11:35.
- **Where the bot lives:** the team chat it was added to (Telegram for now; Slack later). It posts the lunch call there, in a thread, every workday.
- **Team (typical in-office crowd):** Burak, plus whoever's around — treat this as a hint for who to @-mention, not a fixed list. Always let people self-add or drop out.
- **Usual spots (fallback when nobody suggests anything):**
  - Franco Manca (pizza)
  - Wagamama (ramen / katsu)
  - Honest Burgers
  - Pret / Itsu (when people just want something fast)
- **Dietary notes:** at least one vegetarian; check for "veggie", "no pork", "gluten" type notes in replies and carry them into the order.
- **Budget guidance:** ~£12–15/head is normal; flag it in the summary if the basket is well over that.
- **Payment:** a human pays. The bot builds the basket / link and tags someone to check out — it never enters payment details or completes an order.
- **Deliveroo:** the office account is logged in via browser-auth cookies (`lobu memory browser-auth --connector deliveroo --auth-profile-slug office`). If those are missing or expired, the bot falls back to posting the order list for manual entry and says so.

## Memory the agent keeps

Each run is saved as a `lunch-run` entity (date, restaurant, who ordered what, basket link, status) so the next run knows the rotation, what people usually get, and which spots have been done to death lately.

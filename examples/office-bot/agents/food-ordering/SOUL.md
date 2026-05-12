# Instructions

The lunch run is a two-step flow driven by two watchers (`lunch-open` at ~11:00, `lunch-finalize` at ~11:35). You can also be triggered ad-hoc by someone messaging you ("do lunch", "start the lunch order") — in that case do step 1 immediately and tell people you'll post the options shortly.

## Step 1 — open the run (`lunch-open` watcher, or an ad-hoc ask)

1. **Guess who's in.** Look at recent chat activity, anyone who's mentioned lunch/the office today, and what you remember from past `lunch-run` entities about who's usually in. Presence is a hint, not a fact — don't treat it as a confirmed list.
2. **Check you're not double-running.** Search memory for a `lunch-run` entity dated today. If one exists and isn't `cancelled`, don't open another — reply in its thread instead.
3. **Post the call** — one message, friendly and short, e.g.:
   > 🍱 Lunch run! React 🍕 if you're in (or just say "+1"). Got a restaurant recommendation? Drop it here — I'll post the options around 11:35. Targeting ~12:30 delivery.
   @-mention the people you guessed are in (so they see it) but make clear anyone can join or skip.
4. **Open a thread** off that message. Everything else happens in the thread.
5. **Save a `lunch-run` entity**: `{date, channel, status: "collecting", thread_ref: <the thread/message reference>, restaurant: null, items: [], basket_url: null}`. Then `save_memory({content: "Opened lunch run for <date>", semantic_type: "lunch:opened", entity_ids: [<the lunch-run entity>]})`. The thread reference matters — `lunch-finalize` needs it to find the conversation.
6. End the run. Don't wait around — the `lunch-finalize` watcher picks it up.

## Step 2 — collect & hand off (`lunch-finalize` watcher)

1. **Find today's run.** Search memory for today's `lunch-run` entity (status `collecting`). If there isn't one, the open step didn't fire — open one now (step 1) and stop; a human can finalize later. If status is already `done` or `cancelled`, do nothing.
2. **Read the thread.** Pull the thread's messages and reactions. Work out:
   - **Who's in** — anyone who reacted 🍕 / said "+1" / "in" / put an order in. If nobody's in, post "Looks like nobody's in for lunch today — skipping. 👋", set the `lunch-run` to `cancelled`, `save_memory(... semantic_type: "lunch:cancelled" ...)`, done.
   - **Recommendations** — any restaurant anyone named in the thread.
3. **Pick the restaurant.** Use a thread recommendation if there's a clear one (most-mentioned / most 👍). Otherwise pick from the usual spots in `USER.md`, biased away from whatever the last couple of `lunch-run` entities used.
4. **Post the options.** If the Deliveroo browser skill is working, scrape that restaurant's menu and post a numbered shortlist of ~5–8 popular items (name + price), and say "reply with a number, or just type what you want". If scraping isn't available, just name the restaurant and ask people to reply with their order (a Deliveroo link to the restaurant page is a fine substitute). Always accept free-text orders.
5. **Collect orders.** Read replies + number reactions into `items: [{person, item, price?, notes}]`. Notes = anything like "no onions", "large", "extra sauce", "make it the veggie one". If a reply is ambiguous ("the usual", "whatever Burak's having"), resolve it from memory if you can, otherwise ask that person directly with a quick question — don't guess silently.
6. **Build the basket.** Use the `deliveroo-order` skill: log in with the stored cookies, open the restaurant, add each line item, and produce a shareable group-order / basket URL. Note the basket subtotal.
   - If the skill fails (cookies expired, restaurant not on Deliveroo, layout changed, anything): **fall back** — skip the basket, keep going to step 7 with `basket_url: null`, and say in the summary that someone needs to place it manually.
7. **Post the summary** in the thread:
   - Restaurant.
   - Per-person list: `@person — item (notes)`.
   - Subtotal and rough per-head; flag it if it's well over the `USER.md` budget guidance.
   - The basket/checkout link if you have one.
   - The next action: `@here someone hit checkout & pay: <link>` — or, with no link: `@here someone needs to place this on Deliveroo — order list above`.
8. **Update the `lunch-run` entity**: `status: "done"`, `restaurant`, `items`, `basket_url`. Then `save_memory({content: "<restaurant>, <N> people, £<subtotal> — <link or 'manual'>", semantic_type: "lunch:placed", entity_ids: [<the lunch-run entity>]})`.

## Standing rules

- **Never pay.** No checkout, no payment details, no address changes. The hand-off to a human is the end of your job.
- **One run a day.** Always check for an existing `lunch-run` for the date before opening one.
- **`events` is append-only.** To correct a run, `save_memory` a new event with `supersedes_event_id` — never delete.
- **Keep the channel quiet.** Everything after the opening call goes in the thread. One opening message, one options message, one summary message — don't spam.
- **A run with no Deliveroo automation is still a success** if the order list got collected and handed off cleanly.
- **End every run with the concrete next step** for whoever's reading — never a status with no action.

## Event semantic types you write (via save_memory)

- `lunch:opened` — content = "Opened lunch run for <date>"; entity_ids = [the `lunch-run` entity].
- `lunch:placed` — content = "<restaurant>, <N> people, £<subtotal> — <basket link | 'manual'>"; entity_ids = [the `lunch-run` entity].
- `lunch:cancelled` — content = "<date> — <reason: nobody in / called off>"; entity_ids = [the `lunch-run` entity].

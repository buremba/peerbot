export * from './apple_health.ts';
export * from './apple_photos.ts';
export * from './apple_screen_time.ts';
export * from './local_directory.ts';
export * from './browser-scraper-utils.ts';
export * from './capterra.ts';
// Chrome — paired Chrome profile via the Owletto for Chrome extension.
// One connector exposing feeds.open_tabs (auto-wired tab snapshot) +
// actions.{navigate, get_accessibility_tree, click_ref, type_ref,
// wait_for_selector, screenshot, evaluate} (one-shot tools the extension
// dispatcher executes via chrome.debugger + a custom DOM accessibility
// snapshot). Replaces the four prior standalone connectors
// (chrome.tabs / browser.evaluate / browser.page_text / browser.fill_form).
// chrome.history / chrome.bookmarks / chrome.downloads are opt-in
// ambient feeds that auto-wire when the user grants the corresponding
// optional permission in the extension's Permissions panel.
export * from './chrome.ts';
export * from './chrome_history.ts';
export * from './chrome_bookmarks.ts';
export * from './chrome_downloads.ts';
export * from './g2.ts';
export * from './github.ts';
export * from './glassdoor.ts';
export * from './gmaps.ts';
export * from './google_calendar.ts';
export * from './google_gmail.ts';
export * from './google_play.ts';
export * from './hackernews.ts';
export * from './ios_appstore.ts';
export * from './linkedin.ts';
export * from './microsoft_outlook.ts';
export * from './producthunt.ts';
export * from './reddit.ts';
export * from './revolut.ts';
export * from './rss.ts';
export * from './spotify.ts';
export * from './trustpilot.ts';
export * from './website.ts';
export * from './whatsapp.ts';
export * from './whatsapp_local.ts';
export * from './x.ts';
export * from './youtube.ts';

/**
 * `lobu.ai/slack` — front door for the hosted Slack preview bot.
 *
 * The Lobu CLI prints this URL when an agent enables `preview.slack` (see
 * `previewJoinUrl()` in packages/server/src/preview/slack.ts, which defaults to
 * `https://lobu.ai/slack`). Devs land here to join the community workspace where
 * the shared `@Lobu` preview bot lives, then redeem their `/lobu link <code>`.
 *
 * The invite target lives in the `SLACK_COMMUNITY_INVITE_URL` env var (set in
 * the Cloudflare Pages project) so the Slack shared-invite link, which expires,
 * can be rotated without a redeploy. When it is unset we serve a short HTML
 * page pointing at the docs rather than 404'ing, so this is never a dead end.
 */

type PagesFunction = (context: {
  request: Request;
  next: () => Promise<Response>;
  env: Record<string, unknown>;
  params: Record<string, string | string[]>;
}) => Promise<Response> | Response;

const DOCS_URL = "https://lobu.ai/platforms/slack/";

function fallbackPage(): Response {
  const body = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>Lobu on Slack</title>
    <style>
      body { font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; max-width: 32rem; margin: 4rem auto; padding: 0 1.25rem; line-height: 1.6; color: #1a1a1a; }
      a { color: #4338ca; }
      code { background: #f3f4f6; padding: 0.1rem 0.35rem; border-radius: 0.25rem; }
    </style>
  </head>
  <body>
    <h1>Lobu on Slack</h1>
    <p>The community Slack invite is being set up. In the meantime, see the
      <a href="${DOCS_URL}">Slack setup docs</a> to connect Lobu to your own workspace.</p>
    <p>If you ran <code>lobu run</code> and were sent here, the <code>/lobu link</code>
      code you received is still valid until it expires. Check back shortly.</p>
  </body>
</html>`;
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export const onRequest: PagesFunction = ({ env }) => {
  const invite =
    typeof env.SLACK_COMMUNITY_INVITE_URL === "string"
      ? env.SLACK_COMMUNITY_INVITE_URL.trim()
      : "";

  if (!invite) return fallbackPage();

  return new Response(null, {
    status: 302,
    headers: {
      location: invite,
      // Invite links rotate; never let a CDN pin a stale target.
      "cache-control": "no-store",
    },
  });
};

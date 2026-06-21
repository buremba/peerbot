/**
 * Real X (Twitter) embed. We load widgets.js and call
 * twttr.widgets.createTweet(id, host) to render the official embedded tweet by
 * ID. If the widget can't render (visitor blocks platform.twitter.com, offline,
 * X gating), a static card stays in place so the quote is never lost. The
 * static card is built from real tweet data with a vendored avatar.
 *
 * Needs a client directive in MDX (it hydrates to run the widget):
 *   <Tweet id="2063697162748260627" url="https://x.com/..." name="..."
 *     handle="@steipete" avatar="/blog/steipete.png" date="Jun 7, 2026"
 *     likes="19K" client:visible>
 *     Tweet text (fallback).
 *   </Tweet>
 */

import { useEffect, useRef } from "preact/hooks";

type Twttr = {
  widgets?: {
    createTweet?: (
      id: string,
      host: HTMLElement,
      opts?: Record<string, unknown>
    ) => Promise<HTMLElement | undefined>;
  };
};

const X_LOGO =
  "M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z";
const VERIFIED_BADGE =
  "M22.25 12c0-1.43-.88-2.67-2.19-3.34.46-1.39.2-2.9-.81-3.91s-2.52-1.27-3.91-.81c-.66-1.31-1.91-2.19-3.34-2.19s-2.68.88-3.34 2.19c-1.39-.46-2.9-.2-3.91.81s-1.27 2.52-.81 3.91c-1.31.66-2.19 1.91-2.19 3.34s.88 2.67 2.19 3.34c-.46 1.39-.2 2.9.81 3.91s2.52 1.27 3.91.81c.66 1.31 1.91 2.19 3.34 2.19s2.68-.88 3.34-2.19c1.39.46 2.9.2 3.91-.81s1.27-2.52.81-3.91c1.31-.66 2.19-1.91 2.19-3.34zm-11.71 4.2L6.8 12.46l1.41-1.42 2.26 2.26 4.8-5.23 1.47 1.36-6.2 6.77z";
const HEART =
  "M16.697 5.5c-1.222-.06-2.679.51-3.89 2.16l-.805 1.09-.806-1.09C9.984 6.01 8.526 5.44 7.304 5.5c-1.243.07-2.349.78-2.91 1.91-.552 1.12-.633 2.78.479 4.82 1.074 1.97 3.257 4.27 7.129 6.61 3.87-2.34 6.052-4.64 7.126-6.61 1.111-2.04 1.03-3.7.477-4.82-.561-1.13-1.666-1.84-2.91-1.91z";

export function Tweet({
  id,
  url,
  name,
  handle,
  avatar,
  date,
  likes,
  verified = true,
  text,
}: {
  id: string;
  url: string;
  name: string;
  handle: string;
  avatar: string;
  date: string;
  likes: string;
  verified?: boolean;
  text: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const fallbackRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;

    const render = () => {
      const w = window as unknown as { twttr?: Twttr };
      const create = w.twttr?.widgets?.createTweet;
      if (!create || !hostRef.current) return;
      create(id, hostRef.current, {
        theme: "dark",
        dnt: true,
        conversation: "none",
        align: "center",
        width: 480,
      })
        .then((el) => {
          if (!cancelled && el && fallbackRef.current) {
            fallbackRef.current.style.display = "none";
          }
        })
        .catch(() => {/* widget blocked or rate-limited: the static fallback stays */});
    };

    const w = window as unknown as { twttr?: Twttr };
    if (w.twttr?.widgets?.createTweet) {
      render();
      return;
    }

    if (!document.getElementById("twitter-wjs")) {
      const s = document.createElement("script");
      s.id = "twitter-wjs";
      s.async = true;
      s.src = "https://platform.twitter.com/widgets.js";
      document.body.appendChild(s);
    }
    const timer = window.setInterval(() => {
      const ww = window as unknown as { twttr?: Twttr };
      if (ww.twttr?.widgets?.createTweet) {
        window.clearInterval(timer);
        render();
      }
    }, 150);
    const stop = window.setTimeout(() => window.clearInterval(timer), 10000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.clearTimeout(stop);
    };
  }, [id]);

  return (
    <div class="not-prose my-6">
      {/* Real X embed renders here */}
      <div ref={hostRef} class="flex justify-center [&_iframe]:!my-0" />

      {/* Fallback: static card from real tweet data, hidden once the embed renders */}
      <div ref={fallbackRef}>
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          class="tweet-card block rounded-2xl border p-4 no-underline transition-colors"
          style={{
            borderColor: "var(--color-page-border)",
            backgroundImage:
              "linear-gradient(to bottom, var(--color-page-bg-elevated), var(--color-page-bg))",
          }}
        >
          <div class="flex items-start gap-3">
            <img
              src={avatar}
              alt={name}
              width="44"
              height="44"
              loading="lazy"
              class="h-11 w-11 shrink-0 rounded-full"
              style={{ backgroundColor: "var(--color-page-surface)" }}
            />
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-1">
                <span
                  class="truncate text-[14.5px] font-bold leading-tight"
                  style={{ color: "var(--color-page-text)" }}
                >
                  {name}
                </span>
                {verified ? (
                  <svg
                    role="img"
                    viewBox="0 0 24 24"
                    width="16"
                    height="16"
                    class="shrink-0"
                    style={{ fill: "#1d9bf0" }}
                  >
                    <title>Verified</title>
                    <path d={VERIFIED_BADGE} />
                  </svg>
                ) : null}
              </div>
              <div
                class="font-mono text-[12.5px] leading-tight"
                style={{ color: "var(--color-page-text-muted)" }}
              >
                {handle}
              </div>
            </div>
            <svg
              role="img"
              viewBox="0 0 24 24"
              width="18"
              height="18"
              class="mt-0.5 shrink-0"
              style={{ fill: "var(--color-page-text-muted)" }}
            >
              <title>X</title>
              <path d={X_LOGO} />
            </svg>
          </div>

          <p
            class="mt-2.5 whitespace-pre-line text-[15px] leading-relaxed"
            style={{ color: "var(--color-page-text)" }}
          >
            {text}
          </p>

          <div
            class="mt-3 flex items-center gap-2 border-t pt-2.5 font-mono text-[11.5px]"
            style={{
              borderColor: "var(--color-page-border)",
              color: "var(--color-page-text-muted)",
            }}
          >
            <svg
              role="img"
              viewBox="0 0 24 24"
              width="14"
              height="14"
              class="shrink-0"
              style={{ fill: "currentColor" }}
            >
              <title>Likes</title>
              <path d={HEART} />
            </svg>
            <span>{likes}</span>
            <span aria-hidden="true">·</span>
            <span>{date}</span>
            <span class="tweet-card-cta ml-auto">View on X ↗</span>
          </div>

          <style>{`
            .tweet-card:hover { border-color: var(--color-tg-accent) !important; }
            .tweet-card:hover .tweet-card-cta { color: var(--color-tg-accent); }
          `}</style>
        </a>
      </div>
    </div>
  );
}

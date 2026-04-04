import { ScheduleCallButton } from "./ScheduleDialog";

export function CTA() {
  return (
    <section class="py-14 px-8 text-center">
      <div class="max-w-2xl mx-auto">
        <h2
          class="text-2xl sm:text-3xl font-bold mb-3 tracking-tight"
          style={{ color: "var(--color-page-text)" }}
        >
          Ready to try it?
        </h2>
        <p
          class="text-sm mb-8"
          style={{ color: "var(--color-page-text-muted)" }}
        >
          Get started locally, then self-host or embed with TypeScript.
        </p>
        <div class="flex flex-wrap justify-center gap-3 mb-8">
          <button
            type="button"
            class="inline-flex items-center gap-2 font-mono text-[13px] font-semibold px-6 py-3 rounded-lg transition-all hover:opacity-90 cursor-pointer"
            style={{
              backgroundColor: "var(--color-page-text)",
              color: "var(--color-page-bg)",
            }}
            onClick={(e) => {
              const button = e.currentTarget as HTMLButtonElement;
              navigator.clipboard.writeText("npx @lobu/cli init").then(() => {
                const original = button.innerHTML;
                button.innerHTML =
                  '<span style="color: var(--color-tg-accent)">Copied!</span>';
                setTimeout(() => {
                  button.innerHTML = original;
                }, 2000);
              });
            }}
          >
            <span style={{ color: "var(--color-tg-accent)" }}>$</span> npx
            @lobu/cli init
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              style={{ opacity: 0.5 }}
              aria-hidden="true"
            >
              <rect x="9" y="9" width="13" height="13" rx="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
          </button>
          <ScheduleCallButton
            class="inline-flex items-center gap-2 text-sm font-medium px-6 py-3 rounded-lg transition-all hover:opacity-90"
            style={{
              backgroundColor: "var(--color-page-surface)",
              color: "var(--color-page-text)",
              border: "1px solid var(--color-page-border-active)",
            }}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <rect x="3" y="4" width="18" height="18" rx="2" />
              <path d="M16 2v4M8 2v4M3 10h18" />
            </svg>
            Talk to Founder
          </ScheduleCallButton>
        </div>

        {/* Quick links */}
        <div
          class="flex flex-wrap items-center gap-4 text-xs justify-center"
          style={{ color: "var(--color-page-text-muted)" }}
        >
          <a
            href="/skills"
            class="hover:underline underline-offset-2"
            style={{ color: "var(--color-tg-accent)" }}
          >
            Browse Skills
          </a>
          <span style={{ opacity: 0.3 }}>|</span>
          <a
            href="/deployment/docker/"
            class="hover:underline underline-offset-2"
            style={{ color: "var(--color-tg-accent)" }}
          >
            Self-host Docs
          </a>
          <span style={{ opacity: 0.3 }}>|</span>
          <a
            href="/platforms/rest-api/"
            class="hover:underline underline-offset-2"
            style={{ color: "var(--color-tg-accent)" }}
          >
            Embed
          </a>
          <span style={{ opacity: 0.3 }}>|</span>
          <a
            href="/getting-started/"
            class="hover:underline underline-offset-2"
            style={{ color: "var(--color-tg-accent)" }}
          >
            Docs
          </a>
        </div>
      </div>
    </section>
  );
}

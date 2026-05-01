import { getOwlettoBaseUrl } from "../use-case-showcases";

function HexCluster() {
  return (
    <svg
      width="320"
      height="180"
      viewBox="0 0 320 180"
      fill="none"
      aria-hidden="true"
      class="max-w-full"
    >
      {[0, 1, 2, 3, 4].map((i) => {
        const x = 30 + i * 60;
        return (
          <g key={i} transform={`translate(${x},90)`}>
            <polygon
              points="-30,0 -15,-26 15,-26 30,0 15,26 -15,26"
              fill="#ffffff"
              stroke="rgba(0,0,0,0.18)"
              stroke-width="1.2"
            />
            <line
              x1="-15"
              y1="-26"
              x2="15"
              y2="26"
              stroke="rgba(0,0,0,0.08)"
              stroke-width="1"
              stroke-dasharray="2 3"
            />
          </g>
        );
      })}
    </svg>
  );
}

export function CTA({ startUrl = getOwlettoBaseUrl() }: { startUrl?: string }) {
  return (
    <section class="px-4 sm:px-6 py-20">
      <div
        class="max-w-[72rem] mx-auto rounded-2xl overflow-hidden grid grid-cols-1 md:grid-cols-2 dotted-bg"
        style={{ border: "1px solid var(--color-page-border)" }}
      >
        <div class="p-10 sm:p-12 flex flex-col justify-center">
          <h2
            class="font-display text-[34px] sm:text-[40px] font-semibold leading-[1.05] mb-6"
            style={{
              color: "var(--color-page-text)",
              letterSpacing: "-0.025em",
            }}
          >
            Start with the
            <br />
            free open-source build.
          </h2>
          <div class="flex flex-wrap gap-3">
            <a
              href={startUrl}
              class="inline-flex items-center text-[14px] font-medium px-5 h-10 rounded-lg transition-opacity hover:opacity-90"
              style={{ background: "#0b0b0d", color: "#ffffff" }}
            >
              Start for free
            </a>
            <a
              href="/getting-started"
              class="inline-flex items-center text-[14px] font-medium px-5 h-10 rounded-lg transition-colors hover:bg-[color:var(--color-page-surface-dim)]"
              style={{
                color: "var(--color-page-text)",
                border: "1px solid var(--color-page-border)",
              }}
            >
              Read the docs
            </a>
          </div>
        </div>
        <div class="hidden md:flex items-center justify-center p-10">
          <HexCluster />
        </div>
      </div>
    </section>
  );
}

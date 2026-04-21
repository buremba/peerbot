import { useState } from "preact/hooks";
import { ModeCard, modes } from "./InstallSection";
import { ScheduleCallButton, ScheduleCallIcon } from "./ScheduleDialog";

const GITHUB_URL = "https://github.com/lobu-ai/lobu";

const resources = [
  {
    label: "vCPU",
    rate: "$0.000463",
    unit: "/ vCPU / minute",
    monthlyRate: "~$20",
    monthlyUnit: "/ vCPU / month",
  },
  {
    label: "Memory",
    rate: "$0.000231",
    unit: "/ GB / minute",
    monthlyRate: "~$10",
    monthlyUnit: "/ GB / month",
  },
  {
    label: "Storage",
    rate: "$0.15",
    unit: "/ GB / month",
    monthlyRate: "$0.15",
    monthlyUnit: "/ GB / month",
  },
];

const highlights = [
  {
    title: "Scale to zero",
    description:
      "Agents sleep when idle and wake instantly on message. No traffic, no cost.",
    link: "/guides/architecture",
    linkLabel: "Architecture",
  },
  {
    title: "Per-second billing",
    description:
      "Metered by the second while active. No minimums, no reserved instances.",
  },
  {
    title: "Sandboxed isolation",
    description:
      "Every agent runs in its own sandbox. Full isolation between users.",
    link: "/guides/security",
    linkLabel: "Security guide",
  },
  {
    title: "Same open-source code",
    description:
      "Identical to self-hosted Lobu. Migrate off anytime — no lock-in.",
    link: "/getting-started",
    linkLabel: "Getting started",
  },
];

const docsLinks = [
  { label: "Getting Started", href: "/getting-started" },
  { label: "Architecture", href: "/guides/architecture" },
  { label: "Security", href: "/guides/security" },
  { label: "Kubernetes Deploy", href: "/deployment/kubernetes" },
  { label: "Docker Deploy", href: "/deployment/docker" },
  { label: "MCP Proxy", href: "/guides/mcp-proxy/" },
];

export function ServerlessSection() {
  const [isManaged, setIsManaged] = useState(true);
  const [monthly, setMonthly] = useState(false);
  return (
    <section class="pt-28 pb-16 px-8">
      <div class="max-w-3xl mx-auto">
        {/* Toggle between Managed and Open Source */}
        <div class="flex justify-center mb-10">
          <div
            class="inline-flex p-1 rounded-xl border"
            style={{
              backgroundColor: "rgba(255, 255, 255, 0.03)",
              borderColor: "var(--color-page-border)",
            }}
          >
            <button
              type="button"
              onClick={() => setIsManaged(true)}
              class={`px-6 py-1.5 text-xs font-semibold rounded-lg transition-all ${
                isManaged ? "shadow-sm" : "opacity-60 hover:opacity-100"
              }`}
              style={{
                backgroundColor: isManaged
                  ? "var(--color-page-text)"
                  : "transparent",
                color: isManaged
                  ? "var(--color-page-bg)"
                  : "var(--color-page-text)",
              }}
            >
              Managed
            </button>
            <button
              type="button"
              onClick={() => setIsManaged(false)}
              class={`px-6 py-1.5 text-xs font-semibold rounded-lg transition-all ${
                !isManaged ? "shadow-sm" : "opacity-60 hover:opacity-100"
              }`}
              style={{
                backgroundColor: !isManaged
                  ? "var(--color-page-text)"
                  : "transparent",
                color: !isManaged
                  ? "var(--color-page-bg)"
                  : "var(--color-page-text)",
              }}
            >
              Open Source
            </button>
          </div>
        </div>

        {/* Header */}
        <div class="text-center mb-16">
          {/* Telegram try button intentionally hidden */}
          <h1
            class="text-4xl sm:text-5xl font-bold tracking-tight leading-[1.1] mb-5"
            style={{ color: "var(--color-page-text)" }}
          >
            {isManaged ? (
              <>
                Serverless{" "}
                <span style={{ color: "var(--color-tg-accent)" }}>
                  OpenClaw
                </span>
              </>
            ) : (
              <>
                Lobu{" "}
                <span style={{ color: "var(--color-tg-accent)" }}>
                  Open Source
                </span>
              </>
            )}
          </h1>
          <p
            class="text-lg max-w-2xl mx-auto mb-8 leading-relaxed"
            style={{ color: "var(--color-page-text-muted)" }}
          >
            {isManaged
              ? "We run the infrastructure so you don't have to. Pay only when they're working."
              : "Self-host for free on your own infrastructure. Fully managed is available if you prefer."}
          </p>
          <div class="flex flex-wrap gap-3 justify-center">
            {isManaged ? (
              <>
                <ScheduleCallButton
                  class="inline-flex items-center gap-2 text-sm font-semibold px-5 py-2.5 rounded-lg transition-all hover:opacity-90"
                  style={{
                    backgroundColor: "var(--color-page-text)",
                    color: "var(--color-page-bg)",
                  }}
                >
                  <ScheduleCallIcon />
                  Talk to Founder
                </ScheduleCallButton>
                <button
                  type="button"
                  onClick={() => setIsManaged(false)}
                  class="inline-flex items-center gap-2 text-sm font-medium px-5 py-2.5 rounded-lg transition-all hover:opacity-90"
                  style={{
                    color: "var(--color-page-text-muted)",
                    border: "1px solid var(--color-page-border)",
                  }}
                >
                  Self-host instead
                </button>
              </>
            ) : (
              <>
                <a
                  href={GITHUB_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  class="inline-flex items-center gap-2 text-sm font-semibold px-5 py-2.5 rounded-lg transition-all hover:opacity-90"
                  style={{
                    backgroundColor: "var(--color-page-text)",
                    color: "var(--color-page-bg)",
                  }}
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="currentColor"
                    aria-hidden="true"
                  >
                    <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
                  </svg>
                  View on GitHub
                </a>
                <button
                  type="button"
                  onClick={() => setIsManaged(true)}
                  class="inline-flex items-center gap-2 text-sm font-medium px-5 py-2.5 rounded-lg transition-all hover:opacity-90"
                  style={{
                    color: "var(--color-page-text-muted)",
                    border: "1px solid var(--color-page-border)",
                  }}
                >
                  Switch to Managed
                </button>
              </>
            )}
          </div>
        </div>

        {/* Main Content */}
        {isManaged ? (
          <>
            {/* Resource pricing */}
            <div class="mb-6">
              <div class="flex items-center justify-center gap-3 mb-4">
                <h2
                  class="text-lg font-bold"
                  style={{ color: "var(--color-page-text)" }}
                >
                  Usage-based pricing
                </h2>
                <button
                  type="button"
                  onClick={() => setMonthly(!monthly)}
                  class="relative inline-flex h-6 w-11 items-center rounded-full transition-colors cursor-pointer"
                  style={{
                    backgroundColor: monthly
                      ? "var(--color-tg-accent)"
                      : "rgba(255,255,255,0.12)",
                  }}
                >
                  <span
                    class="inline-block h-4 w-4 rounded-full bg-white transition-transform"
                    style={{
                      transform: monthly
                        ? "translateX(22px)"
                        : "translateX(4px)",
                    }}
                  />
                </button>
                <span
                  class="text-xs font-medium"
                  style={{ color: "var(--color-page-text-muted)" }}
                >
                  Monthly
                </span>
              </div>
              <div class="grid grid-cols-1 sm:grid-cols-3 gap-4">
                {resources.map((r) => (
                  <div
                    key={r.label}
                    class="rounded-xl p-6"
                    style={{
                      backgroundColor: "var(--color-page-bg-elevated)",
                      border: "1px solid var(--color-page-border)",
                    }}
                  >
                    <div
                      class="text-sm font-semibold mb-3"
                      style={{ color: "var(--color-page-text)" }}
                    >
                      {r.label}
                    </div>
                    <div class="mb-1">
                      <span
                        class="text-xl font-bold"
                        style={{ color: "var(--color-page-text)" }}
                      >
                        {monthly ? r.monthlyRate : r.rate}
                      </span>
                    </div>
                    <div
                      class="text-xs"
                      style={{ color: "var(--color-page-text-muted)" }}
                    >
                      {monthly ? r.monthlyUnit : r.unit}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Idle callout */}
            <div
              class="text-center text-sm mb-16 py-3 rounded-lg"
              style={{
                color: "var(--color-page-text-muted)",
                backgroundColor: "var(--color-page-surface-dim)",
                border: "1px solid var(--color-page-border)",
              }}
            >
              Idle agents cost{" "}
              <span
                class="font-semibold"
                style={{ color: "var(--color-page-text)" }}
              >
                $0
              </span>
              . Billed per second, only while active.
            </div>
          </>
        ) : (
          <div class="mb-16">
            <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
              {modes.map((mode) => (
                <ModeCard key={mode.id} mode={mode} />
              ))}
            </div>
          </div>
        )}

        {/* Highlights */}
        <div class="mb-16">
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-6">
            {highlights.map((item) => (
              <div
                key={item.title}
                class="rounded-xl p-5"
                style={{
                  backgroundColor: "var(--color-page-bg-elevated)",
                  border: "1px solid var(--color-page-border)",
                }}
              >
                <h3
                  class="text-sm font-semibold mb-2"
                  style={{ color: "var(--color-page-text)" }}
                >
                  {item.title}
                </h3>
                <p
                  class="text-sm leading-relaxed"
                  style={{ color: "var(--color-page-text-muted)" }}
                >
                  {item.description}
                </p>
                {item.link && (
                  <a
                    href={item.link}
                    class="inline-block mt-2 text-xs font-medium transition-opacity hover:opacity-80"
                    style={{ color: "var(--color-tg-accent)" }}
                  >
                    {item.linkLabel} →
                  </a>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Docs links */}
        <div class="mb-16">
          <h3
            class="text-sm font-semibold mb-4 text-center"
            style={{ color: "var(--color-page-text)" }}
          >
            Learn more
          </h3>
          <div class="flex flex-wrap justify-center gap-2">
            {docsLinks.map((link) => (
              <a
                key={link.label}
                href={link.href}
                class="text-xs font-medium px-3 py-1.5 rounded-lg transition-all hover:opacity-80"
                style={{
                  backgroundColor: "var(--color-page-surface-dim)",
                  color: "var(--color-page-text-muted)",
                  border: "1px solid var(--color-page-border)",
                }}
              >
                {link.label}
              </a>
            ))}
          </div>
        </div>

        {/* Mode Callout */}
        <div
          class="rounded-xl p-8 text-center"
          style={{
            backgroundColor: "var(--color-page-bg-elevated)",
            border: "1px solid var(--color-page-border)",
          }}
        >
          {isManaged ? (
            <>
              <h3
                class="text-lg font-semibold mb-2"
                style={{ color: "var(--color-page-text)" }}
              >
                100% open-source
              </h3>
              <p
                class="text-sm mb-5 max-w-md mx-auto leading-relaxed"
                style={{ color: "var(--color-page-text-muted)" }}
              >
                Lobu is fully open-source. Self-host for free on your own
                infrastructure, or let us manage it for you.
              </p>
              <div class="flex flex-wrap gap-3 justify-center">
                <a
                  href={GITHUB_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  class="inline-flex items-center gap-2 text-xs font-medium px-4 py-2 rounded-lg transition-all hover:opacity-80"
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
                    fill="currentColor"
                    aria-hidden="true"
                  >
                    <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
                  </svg>
                  View on GitHub
                </a>
                <ScheduleCallButton
                  class="inline-flex items-center gap-2 text-xs font-medium px-4 py-2 rounded-lg transition-all hover:opacity-80"
                  style={{
                    color: "var(--color-tg-accent)",
                  }}
                >
                  <ScheduleCallIcon />
                  Talk to Founder
                </ScheduleCallButton>
              </div>
            </>
          ) : (
            <>
              <h3
                class="text-lg font-semibold mb-2"
                style={{ color: "var(--color-page-text)" }}
              >
                Want us to handle it?
              </h3>
              <p
                class="text-sm mb-5 max-w-md mx-auto leading-relaxed"
                style={{ color: "var(--color-page-text-muted)" }}
              >
                Skip the setup and maintenance. Get started in seconds with our
                fully managed serverless platform.
              </p>
              <div class="flex flex-wrap gap-3 justify-center">
                <button
                  type="button"
                  onClick={() => setIsManaged(true)}
                  class="inline-flex items-center gap-2 text-xs font-medium px-4 py-2 rounded-lg transition-all hover:opacity-80"
                  style={{
                    backgroundColor: "var(--color-page-surface)",
                    color: "var(--color-page-text)",
                    border: "1px solid var(--color-page-border-active)",
                  }}
                >
                  Switch to Managed
                </button>
                <ScheduleCallButton
                  class="inline-flex items-center gap-2 text-xs font-medium px-4 py-2 rounded-lg transition-all hover:opacity-80"
                  style={{
                    color: "var(--color-tg-accent)",
                  }}
                >
                  <ScheduleCallIcon />
                  Talk to Founder
                </ScheduleCallButton>
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

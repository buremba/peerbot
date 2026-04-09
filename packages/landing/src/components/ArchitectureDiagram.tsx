import { messagingChannels } from "./platforms";

const gatewayLayer = {
  label: "Gateway",
  sublabel: "single egress point",
  features: [
    "Secret swapping — workers never see real keys",
    "HTTP proxy with domain allowlist",
    "MCP proxy with per-user OAuth",
    "BYO provider keys (Anthropic, OpenAI, etc.)",
  ],
};

const runtimeLayer = {
  label: "OpenClaw Runtime",
  sublabel: "per-user isolation",
  features: [
    "One sandbox per user and channel",
    "Kata Containers / Firecracker microVMs / gVisor on GCP",
    "virtualized bash for scaling beyond 1000 users",
    "No direct internet access (internal network)",
    "Nix reproducible environments",
    "OpenTelemetry for observability",
  ],
};

function Arrow() {
  return (
    <svg
      width="32"
      height="12"
      viewBox="0 0 32 12"
      fill="none"
      class="shrink-0 hidden md:block mt-4"
      aria-hidden="true"
    >
      <line
        x1="0"
        y1="6"
        x2="26"
        y2="6"
        stroke="var(--color-page-text-muted)"
        stroke-width="1.5"
      />
      <polyline
        points="22,2 28,6 22,10"
        stroke="var(--color-page-text-muted)"
        stroke-width="1.5"
        fill="none"
      />
    </svg>
  );
}

function FeatureList({
  features,
  accent,
}: {
  features: string[];
  accent?: boolean;
}) {
  return (
    <ul class="mt-4 space-y-2 w-full max-w-[230px]">
      {features.map((f) => (
        <li
          key={f}
          class="text-xs leading-relaxed flex gap-2"
          style={{ color: "var(--color-page-text-muted)" }}
        >
          <span
            class="shrink-0 mt-1 w-1 h-1 rounded-full"
            style={{
              backgroundColor: accent
                ? "var(--color-tg-accent)"
                : "var(--color-page-text-muted)",
            }}
          />
          {f}
        </li>
      ))}
    </ul>
  );
}

function PlatformColumn() {
  return (
    <div class="flex flex-col items-center flex-1 min-w-0">
      <div class="w-full max-w-[200px] space-y-1.5">
        {messagingChannels.map((channel) => (
          <div
            key={channel.id}
            class="rounded-lg px-4 py-2 flex items-center gap-2.5"
            style={{
              backgroundColor: "var(--color-page-surface-dim)",
              border: "1px solid var(--color-page-border)",
            }}
          >
            <span style={{ color: "var(--color-page-text-muted)" }}>
              {channel.renderIcon(14)}
            </span>
            <div>
              <div
                class="text-xs font-semibold"
                style={{ color: "var(--color-page-text)" }}
              >
                {channel.label}
              </div>
              <div
                class="text-[9px]"
                style={{ color: "var(--color-page-text-muted)" }}
              >
                {channel.detail}
              </div>
            </div>
          </div>
        ))}
      </div>
      <FeatureList
        features={[
          "Native UI per platform — not just text",
          "Users authenticate with their own accounts",
          "Embedded settings via inline buttons",
        ]}
      />
    </div>
  );
}

function GatewayColumn() {
  return (
    <div class="flex flex-col items-center flex-1 min-w-0">
      <div
        class="rounded-lg px-5 py-3 text-center w-full max-w-[200px]"
        style={{
          backgroundColor: "rgba(var(--color-tg-accent-rgb), 0.12)",
          border: "1px solid var(--color-tg-accent)",
        }}
      >
        <div
          class="text-sm font-semibold"
          style={{ color: "var(--color-tg-accent)" }}
        >
          {gatewayLayer.label}
        </div>
        <div
          class="text-[10px] mt-0.5"
          style={{ color: "var(--color-page-text-muted)" }}
        >
          {gatewayLayer.sublabel}
        </div>
      </div>
      <FeatureList features={gatewayLayer.features} accent />
    </div>
  );
}

function RuntimeColumn() {
  return (
    <div class="flex flex-col items-center flex-1 min-w-0">
      <div class="w-full max-w-[200px] space-y-1.5">
        {["User A", "User B", "User C"].map((user, i) => (
          <div
            key={user}
            class="rounded-lg px-4 py-2 flex items-center justify-between"
            style={{
              backgroundColor: "var(--color-page-surface-dim)",
              border: "1px solid var(--color-page-border)",
              opacity: i === 0 ? 1 : i === 1 ? 0.6 : 0.35,
            }}
          >
            <div class="text-left">
              <div
                class="text-xs font-semibold"
                style={{ color: "var(--color-page-text)" }}
              >
                {runtimeLayer.label}
              </div>
              <div
                class="text-[9px]"
                style={{ color: "var(--color-page-text-muted)" }}
              >
                {user}
              </div>
            </div>
            <span
              class="text-[8px] font-medium px-1.5 py-0.5 rounded-full"
              style={{
                backgroundColor: "rgba(16, 185, 129, 0.15)",
                color: "#10b981",
                border: "1px solid rgba(16, 185, 129, 0.3)",
              }}
            >
              isolated
            </span>
          </div>
        ))}
      </div>
      <FeatureList features={runtimeLayer.features} />
    </div>
  );
}

export function ArchitectureDiagram() {
  return (
    <div class="flex flex-col md:flex-row items-start justify-center gap-6 md:gap-0">
      <PlatformColumn />
      <Arrow />
      <GatewayColumn />
      <Arrow />
      <RuntimeColumn />
    </div>
  );
}

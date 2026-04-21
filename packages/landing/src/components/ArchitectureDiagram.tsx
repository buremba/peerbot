import type { LandingUseCaseId } from "../use-case-definitions";
import { messagingChannels } from "./platforms";

const gatewayLayer = {
  label: "Lobu",
  sublabel: "Control Plane",
  features: [
    "Workers never see secrets",
    "HTTP proxy with domain allowlist",
    "MCP proxy with per-user OAuth",
    "BYO provider keys (Anthropic etc.)",
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
      class="shrink-0 hidden md:block self-center"
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
      <div
        class="text-[9px] uppercase tracking-wider mb-1"
        style={{ color: "var(--color-page-text-muted)" }}
      >
        Messaging platforms
      </div>
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
          "Link users across platforms with single sign-on",
          "Approval flows, rich cards, buttons, and more",
        ]}
      />
    </div>
  );
}

const gatewayBadges = [
  {
    label: "Secrets",
    href: "/guides/security/",
    icon: (
      <svg
        width={10}
        height={10}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
        <path d="M7 11V7a5 5 0 0 1 10 0v4" />
      </svg>
    ),
  },
  {
    label: "Single Sign-On (IdP)",
    href: null,
    icon: (
      <svg
        width={10}
        height={10}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
        <circle cx="12" cy="7" r="4" />
      </svg>
    ),
  },
  {
    label: "Skill Registry",
    href: "/getting-started/skills/",
    icon: (
      <svg
        width={10}
        height={10}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <rect x="2" y="3" width="7" height="7" rx="1" />
        <rect x="15" y="3" width="7" height="7" rx="1" />
        <rect x="2" y="14" width="7" height="7" rx="1" />
        <rect x="15" y="14" width="7" height="7" rx="1" />
      </svg>
    ),
  },
  {
    label: "Traces",
    href: "/guides/observability/",
    icon: (
      <svg
        width={10}
        height={10}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
      </svg>
    ),
  },
  {
    label: "Sandboxing",
    href: "/deployment/kubernetes/",
    icon: (
      <svg
        width={10}
        height={10}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="M12 2L2 7l10 5 10-5-10-5z" />
        <path d="M2 17l10 5 10-5" />
        <path d="M2 12l10 5 10-5" />
      </svg>
    ),
  },
];

function GatewayColumn({ useCaseId }: { useCaseId?: LandingUseCaseId }) {
  const suffix = useCaseId ? `/for/${useCaseId}` : "";
  return (
    <div class="flex flex-col items-center flex-1 min-w-0">
      <div
        class="text-[9px] uppercase tracking-wider mb-1"
        style={{ color: "var(--color-page-text-muted)" }}
      >
        Bring your own agent
      </div>
      <AgentStack useCaseId={useCaseId} />
      <AttachmentPill
        label="Lobu Memory"
        href={`/memory${suffix}`}
        icon={<MemoryIcon size={11} />}
      />
      <DashedConnector />
      <div
        class="rounded-lg px-4 py-3 text-center w-full max-w-[200px]"
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
        <div class="flex flex-row flex-wrap justify-center gap-1 mt-2.5">
          {gatewayBadges.map((badge) => {
            const cls =
              "inline-flex items-center gap-1 rounded-full px-2 py-0.5 transition-colors";
            const style = {
              backgroundColor: "rgba(0,0,0,0.25)",
              border: "1px solid var(--color-page-border)",
              color: "var(--color-page-text-muted)",
            };
            const inner = (
              <>
                {badge.icon}
                <span class="text-[9px] font-medium tracking-wide uppercase">
                  {badge.label}
                </span>
              </>
            );
            return badge.href ? (
              <a key={badge.label} href={badge.href} class={cls} style={style}>
                {inner}
              </a>
            ) : (
              <div key={badge.label} class={cls} style={style}>
                {inner}
              </div>
            );
          })}
        </div>
      </div>
      <FeatureList features={gatewayLayer.features} accent />
    </div>
  );
}

function RuntimeColumn({ useCaseId }: { useCaseId?: LandingUseCaseId }) {
  const suffix = useCaseId ? `/for/${useCaseId}` : "";
  return (
    <div class="flex flex-col items-center flex-1 min-w-0">
      <div
        class="text-[9px] uppercase tracking-wider mb-1 text-center"
        style={{ color: "var(--color-page-text-muted)" }}
      >
        Equip your agent
      </div>
      <AttachmentPill
        label="Lobu Skills"
        href={`/skills${suffix}`}
        icon={<SkillsIcon size={11} />}
      />
      <DashedConnector />
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

function MemoryIcon({ size = 12 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5" />
      <path d="M3 12c0 1.66 4.03 3 9 3s9-1.34 9-3" />
    </svg>
  );
}

function SkillsIcon({ size = 12 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
    </svg>
  );
}

function AttachmentPill({
  label,
  href,
  icon,
}: {
  label: string;
  href: string;
  icon: JSX.Element;
}) {
  return (
    <a
      href={href}
      class="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 transition-colors"
      style={{
        backgroundColor: "rgba(var(--color-tg-accent-rgb), 0.12)",
        border: "1px solid var(--color-tg-accent)",
        color: "var(--color-tg-accent)",
      }}
    >
      {icon}
      <span class="text-[10px] font-medium tracking-wide uppercase">
        {label}
      </span>
    </a>
  );
}

function DashedConnector() {
  return (
    <svg width="2" height="14" class="my-1 hidden md:block" aria-hidden="true">
      <line
        x1="1"
        y1="0"
        x2="1"
        y2="14"
        stroke="var(--color-page-text-muted)"
        stroke-width="1"
        stroke-dasharray="2 2"
      />
    </svg>
  );
}

function ChatGPTIcon({ size = 12 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.677l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023l-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.393.681zm1.097-2.365l2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5Z" />
    </svg>
  );
}

function ClaudeIcon({ size = 12 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z" />
    </svg>
  );
}

function OpenClawIcon({ size = 12 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 120 120"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M60 10 C30 10 15 35 15 55 C15 75 30 95 45 100 L45 110 L55 110 L55 100 C55 100 60 102 65 100 L65 110 L75 110 L75 100 C90 95 105 75 105 55 C105 35 90 10 60 10Z" />
      <path d="M20 45 C5 40 0 50 5 60 C10 70 20 65 25 55 C28 48 25 45 20 45Z" />
      <path d="M100 45 C115 40 120 50 115 60 C110 70 100 65 95 55 C92 48 95 45 100 45Z" />
    </svg>
  );
}

function McpClientIcon({ size = 12 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <path d="M9 2v6" />
      <path d="M15 2v6" />
      <path d="M7 8h10v4a5 5 0 0 1-10 0z" />
      <path d="M12 17v5" />
    </svg>
  );
}

const agents: {
  id: "chatgpt" | "claude" | "openclaw" | "mcp-client";
  label: string;
  detail: string;
  href: string;
  renderIcon: (size?: number) => JSX.Element;
  useCaseSuffix: boolean;
}[] = [
  {
    id: "chatgpt",
    label: "ChatGPT",
    detail: "MCP connector",
    href: "/connect-from/chatgpt/",
    renderIcon: (size) => <ChatGPTIcon size={size} />,
    useCaseSuffix: true,
  },
  {
    id: "claude",
    label: "Claude",
    detail: "MCP connector",
    href: "/connect-from/claude/",
    renderIcon: (size) => <ClaudeIcon size={size} />,
    useCaseSuffix: true,
  },
  {
    id: "openclaw",
    label: "OpenClaw",
    detail: "plugin",
    href: "/connect-from/openclaw/",
    renderIcon: (size) => <OpenClawIcon size={size} />,
    useCaseSuffix: true,
  },
  {
    id: "mcp-client",
    label: "Your MCP client",
    detail: "any MCP-capable agent",
    href: "/getting-started/memory/",
    renderIcon: (size) => <McpClientIcon size={size} />,
    useCaseSuffix: false,
  },
];

function AgentStack({ useCaseId }: { useCaseId?: LandingUseCaseId }) {
  const suffix = useCaseId ? `for/${useCaseId}/` : "";
  return (
    <div class="w-full max-w-[180px] space-y-1.5 mb-2">
      {agents.map((agent) => (
        <a
          key={agent.id}
          href={`${agent.href}${agent.useCaseSuffix ? suffix : ""}`}
          class="rounded-lg px-3 py-1.5 flex items-center gap-2 transition-colors"
          style={{
            backgroundColor: "var(--color-page-surface-dim)",
            border: "1px solid var(--color-page-border)",
          }}
        >
          <span style={{ color: "var(--color-page-text-muted)" }}>
            {agent.renderIcon(12)}
          </span>
          <div>
            <div
              class="text-[11px] font-semibold leading-tight"
              style={{ color: "var(--color-page-text)" }}
            >
              {agent.label}
            </div>
            <div
              class="text-[9px] leading-tight"
              style={{ color: "var(--color-page-text-muted)" }}
            >
              {agent.detail}
            </div>
          </div>
        </a>
      ))}
    </div>
  );
}

export function ArchitectureDiagram({
  useCaseId,
}: {
  useCaseId?: LandingUseCaseId;
} = {}) {
  return (
    <div class="flex flex-col md:flex-row items-start justify-center gap-6 md:gap-0">
      <PlatformColumn />
      <Arrow />
      <GatewayColumn useCaseId={useCaseId} />
      <Arrow />
      <RuntimeColumn useCaseId={useCaseId} />
    </div>
  );
}

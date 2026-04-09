import { ScheduleCallButton } from "./ScheduleDialog";
import { deliverySurfaces, formatLabelList } from "./platforms";

const GITHUB_URL = "https://github.com/lobu-ai/lobu";

const deliverySurfacesLabel = formatLabelList(
  deliverySurfaces.map((surface) => surface.label)
);

export function PricingSection() {
  return (
    <section class="pt-28 pb-16 px-4 sm:px-8">
      <div class="max-w-[56rem] mx-auto">
        <h1
          class="text-3xl sm:text-4xl font-bold tracking-tight text-center mb-3"
          style={{ color: "var(--color-page-text)" }}
        >
          Pricing
        </h1>
        <p
          class="text-sm text-center mb-12 max-w-lg mx-auto"
          style={{ color: "var(--color-page-text-muted)" }}
        >
          Lobu is open source. Self-host for free or get expert help deploying
          agents for your organization.
        </p>

        <div class="grid md:grid-cols-2 gap-6">
          {/* Open Source */}
          <div
            class="rounded-2xl p-6 sm:p-8 flex flex-col"
            style={{
              backgroundColor: "var(--color-page-surface)",
              border: "1px solid var(--color-page-border)",
            }}
          >
            <h2
              class="text-xl font-bold mb-1"
              style={{ color: "var(--color-page-text)" }}
            >
              Open Source
            </h2>
            <p
              class="text-2xl font-bold mb-4"
              style={{ color: "var(--color-page-text)" }}
            >
              Free
            </p>
            <p
              class="text-sm mb-6"
              style={{ color: "var(--color-page-text-muted)" }}
            >
              Self-host on your infrastructure. Full feature set, no
              restrictions.
            </p>
            <ul class="space-y-3 mb-8 flex-1">
              {[
                "Unlimited agents and users",
                `All delivery surfaces (${deliverySurfacesLabel})`,
                "Docker Compose and Kubernetes deployment",
                "Embeddable in Node.js apps",
                "MCP proxy with credential isolation",
                "Built-in eval framework",
                "Community support via GitHub",
              ].map((item) => (
                <li
                  key={item}
                  class="flex items-start gap-2 text-sm"
                  style={{ color: "var(--color-page-text-muted)" }}
                >
                  <span
                    class="mt-0.5 shrink-0"
                    style={{ color: "var(--color-tg-accent)" }}
                  >
                    ~
                  </span>
                  {item}
                </li>
              ))}
            </ul>
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noopener noreferrer"
              class="inline-flex items-center justify-center gap-2 text-sm font-medium px-6 py-3 rounded-lg transition-all hover:opacity-90 w-full"
              style={{
                backgroundColor: "var(--color-page-text)",
                color: "var(--color-page-bg)",
              }}
            >
              Get Started
            </a>
          </div>

          {/* Expert Implementation */}
          <div
            class="rounded-2xl p-6 sm:p-8 flex flex-col"
            style={{
              backgroundColor: "var(--color-page-surface)",
              border: "1px solid var(--color-tg-accent)",
            }}
          >
            <h2
              class="text-xl font-bold mb-1"
              style={{ color: "var(--color-page-text)" }}
            >
              Expert Implementation
            </h2>
            <p
              class="text-2xl font-bold mb-4"
              style={{ color: "var(--color-page-text)" }}
            >
              Custom
            </p>
            <p
              class="text-sm mb-6"
              style={{ color: "var(--color-page-text-muted)" }}
            >
              End-to-end agent deployment and ongoing infrastructure
              maintenance.
            </p>
            <ul class="space-y-3 mb-8 flex-1">
              {[
                "Architecture and deployment planning",
                "Custom skill and MCP server development",
                "Kubernetes cluster setup and hardening",
                "Agent identity and prompt engineering",
                "Platform integration (Slack, Teams, custom)",
                "Ongoing maintenance and 99.9% SLA",
                "Direct access to the founder",
              ].map((item) => (
                <li
                  key={item}
                  class="flex items-start gap-2 text-sm"
                  style={{ color: "var(--color-page-text-muted)" }}
                >
                  <span
                    class="mt-0.5 shrink-0"
                    style={{ color: "var(--color-tg-accent)" }}
                  >
                    ~
                  </span>
                  {item}
                </li>
              ))}
            </ul>
            <ScheduleCallButton
              class="inline-flex items-center justify-center gap-2 text-sm font-medium px-6 py-3 rounded-lg transition-all hover:opacity-90 w-full cursor-pointer"
              style={{
                backgroundColor: "var(--color-tg-accent)",
                color: "var(--color-page-bg)",
              }}
            >
              Talk to Founder
            </ScheduleCallButton>
          </div>
        </div>
      </div>
    </section>
  );
}

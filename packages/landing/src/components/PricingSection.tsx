import type { ComponentChildren } from "preact";
import { ScheduleCallButton, ScheduleCallIcon } from "./ScheduleDialog";
import { deliverySurfaces, formatLabelList } from "./platforms";

const GITHUB_URL = "https://github.com/lobu-ai/lobu";
const CLOUD_URL = "https://app.lobu.ai/auth/login";

const deliverySurfacesLabel = formatLabelList(
  deliverySurfaces.map((surface) => surface.label)
);

type PricingPlan = {
  name: string;
  price: string;
  note?: string;
  description: string;
  features: string[];
  highlighted?: boolean;
  cta:
    | {
        type: "link";
        label: string;
        href: string;
      }
    | {
        type: "schedule";
        label: string;
      };
};

const plans: PricingPlan[] = [
  {
    name: "Open Source",
    price: "Free",
    description:
      "Run Lobu on your own infrastructure with the full open-source stack.",
    features: [
      "Unlimited agents and users",
      `All delivery surfaces (${deliverySurfacesLabel})`,
      "Deploy with Docker Compose or Kubernetes",
      "Embed in Node.js apps",
      "MCP proxy with credential isolation",
      "Built-in evals",
      "Community support on GitHub",
    ],
    cta: {
      type: "link",
      label: "Start Self-Hosting",
      href: GITHUB_URL,
    },
  },
  {
    name: "Cloud",
    price: "Free",
    note: "(in beta)",
    description:
      "Managed Lobu hosting. Free in beta for up to 10k events and 1,000 compute minutes per month.",
    features: [
      "Deploy in minutes",
      "Managed gateway and scaling",
      "Built-in integrations via Lobu memory",
      "Credential isolation included",
      "No infrastructure to operate",
    ],
    highlighted: true,
    cta: {
      type: "link",
      label: "Start Free Beta",
      href: CLOUD_URL,
    },
  },
  {
    name: "Expert Implementation",
    price: "Custom",
    description: "We design, launch, and maintain your production deployment.",
    features: [
      "Architecture and rollout plan",
      "Custom skills and MCP servers",
      "Secure Kubernetes setup",
      "Prompt and agent design",
      "Slack, Teams, and custom integrations",
      "Ongoing maintenance with SLA",
      "Direct founder support",
    ],
    cta: {
      type: "schedule",
      label: "Book Intro Call",
    },
  },
];

function FeatureList({ features }: { features: string[] }) {
  return (
    <ul class="space-y-3 mb-8 flex-1">
      {features.map((feature) => (
        <li
          key={feature}
          class="flex items-start gap-2 text-sm"
          style={{ color: "var(--color-page-text-muted)" }}
        >
          <span
            class="mt-0.5 shrink-0"
            style={{ color: "var(--color-tg-accent)" }}
          >
            ~
          </span>
          {feature}
        </li>
      ))}
    </ul>
  );
}

function PlanCard({
  plan,
  children,
}: {
  plan: PricingPlan;
  children: ComponentChildren;
}) {
  const borderColor = plan.highlighted
    ? "var(--color-tg-accent)"
    : "var(--color-page-border)";

  return (
    <div
      class="rounded-2xl p-6 sm:p-8 flex flex-col"
      style={{
        backgroundColor: "var(--color-page-surface)",
        border: `1px solid ${borderColor}`,
      }}
    >
      <h2
        class="text-xl font-bold mb-1"
        style={{ color: "var(--color-page-text)" }}
      >
        {plan.name}
      </h2>
      <p
        class={`text-2xl font-bold mb-4 ${plan.note ? "flex items-baseline gap-2" : ""}`}
        style={{ color: "var(--color-page-text)" }}
      >
        {plan.price}
        {plan.note ? (
          <span
            class="text-sm font-normal"
            style={{ color: "var(--color-page-text-muted)" }}
          >
            {plan.note}
          </span>
        ) : null}
      </p>
      <p class="text-sm mb-6" style={{ color: "var(--color-page-text-muted)" }}>
        {plan.description}
      </p>
      <FeatureList features={plan.features} />
      {children}
    </div>
  );
}

function PlanCta({ plan }: { plan: PricingPlan }) {
  const style = plan.highlighted
    ? {
        backgroundColor: "var(--color-tg-accent)",
        color: "var(--color-page-bg)",
      }
    : {
        backgroundColor: "var(--color-page-text)",
        color: "var(--color-page-bg)",
      };

  if (plan.cta.type === "schedule") {
    return (
      <ScheduleCallButton
        class="inline-flex items-center justify-center gap-2 text-sm font-medium px-6 py-3 rounded-lg transition-all hover:opacity-90 w-full cursor-pointer"
        style={style}
      >
        <ScheduleCallIcon />
        {plan.cta.label}
      </ScheduleCallButton>
    );
  }

  return (
    <a
      href={plan.cta.href}
      target="_blank"
      rel="noopener noreferrer"
      class="inline-flex items-center justify-center gap-2 text-sm font-medium px-6 py-3 rounded-lg transition-all hover:opacity-90 w-full"
      style={style}
    >
      {plan.cta.label}
    </a>
  );
}

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
          Choose self-hosted, managed cloud, or hands-on deployment support.
        </p>

        <div class="grid lg:grid-cols-3 md:grid-cols-2 gap-6">
          {plans.map((plan) => (
            <PlanCard key={plan.name} plan={plan}>
              <PlanCta plan={plan} />
            </PlanCard>
          ))}
        </div>
      </div>
    </section>
  );
}

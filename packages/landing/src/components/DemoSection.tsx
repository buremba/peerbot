import type { ComponentChildren } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import type {
  ExampleRelation,
  LandingUseCaseId,
  RecordNode,
} from "../use-case-definitions";
import {
  DEFAULT_LANDING_USE_CASE_ID,
  getLandingUseCaseShowcase,
  landingUseCaseGroupedOptions,
  type TraceRow,
} from "../use-case-showcases";
import { deliverySurfaces } from "./platforms";
import { ScopedUseCaseTabs } from "./ScopedUseCaseTabs";
import {
  accentAmber,
  accentCyan,
  accentPink,
  textColor,
} from "./memory/styles";

function Card({
  title,
  description,
  href,
  hrefLabel,
  children,
}: {
  title: string;
  description?: string;
  href?: string;
  hrefLabel?: string;
  children: ComponentChildren;
}) {
  return (
    <div
      class="rounded-2xl p-6 h-full"
      style={{
        backgroundColor: "var(--color-page-bg-elevated)",
        border: "1px solid var(--color-page-border)",
      }}
    >
      <div class="flex items-center justify-between gap-3 mb-2">
        <h3
          class="text-lg font-semibold"
          style={{ color: "var(--color-page-text)" }}
        >
          {title}
        </h3>
        {href ? (
          <a
            href={href}
            class="text-sm font-medium transition-opacity hover:opacity-80 shrink-0"
            style={{ color: "var(--color-tg-accent)" }}
          >
            {hrefLabel ?? `${title} page`} →
          </a>
        ) : null}
      </div>
      {description ? (
        <p
          class="text-sm leading-relaxed mb-4"
          style={{ color: "var(--color-page-text-muted)" }}
        >
          {description}
        </p>
      ) : null}
      {children}
    </div>
  );
}

function PillList({ items }: { items: string[] }) {
  return (
    <div class="flex flex-wrap gap-1.5">
      {items.map((item) => (
        <span
          key={item}
          class="text-[11px] font-medium px-2 py-1 rounded-full"
          style={{
            color: "var(--color-page-text-muted)",
            backgroundColor: "rgba(255,255,255,0.05)",
            border: "1px solid rgba(255,255,255,0.09)",
          }}
        >
          {item}
        </span>
      ))}
    </div>
  );
}

function ResponseBlock({ label, text }: { label: string; text: string }) {
  return (
    <div
      class="rounded-xl p-4"
      style={{
        backgroundColor: "rgba(255,255,255,0.03)",
        border: "1px solid var(--color-tg-accent)",
      }}
    >
      <div
        class="text-[10px] uppercase tracking-[0.18em] mb-2"
        style={{ color: "var(--color-tg-accent)" }}
      >
        {label}
      </div>
      <div
        class="text-sm leading-7"
        style={{ color: "var(--color-page-text)" }}
      >
        {text}
      </div>
    </div>
  );
}

const TRACE_KIND_META: Record<
  TraceRow["kind"],
  { label: string; color: string }
> = {
  skill: { label: "skill", color: "var(--color-tg-accent)" },
  memory_recall: { label: "recall", color: accentCyan },
  memory_upsert: { label: "upsert", color: accentPink },
  memory_link: { label: "link", color: accentPink },
};

type TraceTile = { text: string; fg: string; bg: string; border: string };

function getTraceTile(row: TraceRow): TraceTile {
  const call = row.call.toLowerCase();
  if (row.kind === "skill") {
    if (call.startsWith("pagerduty")) {
      return {
        text: "PD",
        fg: "#f59e0b",
        bg: "rgba(245, 158, 11, 0.14)",
        border: "rgba(245, 158, 11, 0.4)",
      };
    }
    if (call.startsWith("k8s") || call.startsWith("helm")) {
      return {
        text: "K8",
        fg: "#60a5fa",
        bg: "rgba(96, 165, 250, 0.14)",
        border: "rgba(96, 165, 250, 0.4)",
      };
    }
    if (call.startsWith("approval")) {
      return {
        text: "OK",
        fg: accentAmber,
        bg: "rgba(248, 184, 78, 0.14)",
        border: "rgba(248, 184, 78, 0.4)",
      };
    }
    return {
      text: row.source.slice(0, 2).toUpperCase(),
      fg: "var(--color-tg-accent)",
      bg: "rgba(255,255,255,0.06)",
      border: "rgba(255,255,255,0.16)",
    };
  }
  if (row.kind === "memory_recall") {
    return {
      text: "\u21BA",
      fg: accentCyan,
      bg: "rgba(103, 232, 249, 0.12)",
      border: "rgba(103, 232, 249, 0.4)",
    };
  }
  if (row.kind === "memory_upsert") {
    return {
      text: "+",
      fg: accentPink,
      bg: "rgba(251, 113, 133, 0.12)",
      border: "rgba(251, 113, 133, 0.4)",
    };
  }
  return {
    text: "\u2192",
    fg: accentPink,
    bg: "rgba(251, 113, 133, 0.12)",
    border: "rgba(251, 113, 133, 0.4)",
  };
}

function EntityCard({ node }: { node: RecordNode }) {
  return (
    <div
      class="rounded-lg p-3 grid gap-1.5"
      style={{
        backgroundColor: "rgba(255,255,255,0.03)",
        border: "1px solid rgba(255,255,255,0.08)",
      }}
    >
      <div class="flex items-center gap-2 flex-wrap">
        <span
          class="text-[10px] uppercase tracking-[0.16em] px-1.5 py-0.5 rounded"
          style={{
            color: accentCyan,
            border: `1px solid rgba(103, 232, 249, 0.35)`,
            backgroundColor: `rgba(103, 232, 249, 0.06)`,
          }}
        >
          {node.kind}
        </span>
        <span class="text-sm" style={{ color: "var(--color-page-text)" }}>
          {node.label}
        </span>
      </div>
      {node.chips?.length ? (
        <div class="flex flex-wrap gap-1">
          {node.chips.map((chip) => (
            <span
              key={chip}
              class="text-[10px] px-1.5 py-0.5 rounded-full"
              style={{
                color: "var(--color-page-text-muted)",
                backgroundColor: "rgba(255,255,255,0.04)",
                border: "1px solid rgba(255,255,255,0.06)",
              }}
            >
              {chip}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function RelationshipTriple({ relation }: { relation: ExampleRelation }) {
  return (
    <div class="flex flex-wrap items-center gap-1.5">
      <span
        class="px-2 py-0.5 rounded-full text-xs"
        style={{
          color: textColor,
          backgroundColor: `rgba(103, 232, 249, 0.08)`,
          border: "1px solid rgba(103, 232, 249, 0.22)",
        }}
      >
        <span class="font-semibold">{relation.sourceType}</span>{" "}
        {relation.source}
      </span>
      <span
        class="px-1.5 py-0.5 rounded-full text-[10px] uppercase tracking-[0.16em]"
        style={{
          color: accentCyan,
          backgroundColor: `rgba(103, 232, 249, 0.06)`,
          border: "1px solid rgba(103, 232, 249, 0.18)",
        }}
      >
        {relation.label}
      </span>
      <span
        class="px-2 py-0.5 rounded-full text-xs"
        style={{
          color: textColor,
          backgroundColor: `rgba(134, 239, 172, 0.08)`,
          border: "1px solid rgba(134, 239, 172, 0.22)",
        }}
      >
        <span class="font-semibold">{relation.targetType}</span>{" "}
        {relation.target}
      </span>
    </div>
  );
}

function TraceSection({
  rows,
  skillsHref,
  memoryHref,
  mcpServer,
  allowedDomains,
  entities,
  relation,
}: {
  rows: TraceRow[];
  skillsHref: string;
  memoryHref: string;
  mcpServer: string;
  allowedDomains: string[];
  entities: RecordNode[];
  relation?: ExampleRelation;
}) {
  return (
    <div class="mt-5">
      <div
        class="text-[10px] uppercase tracking-[0.18em] mb-3"
        style={{ color: "var(--color-page-text-muted)" }}
      >
        Trace
      </div>
      <div class="flex flex-col">
        {rows.map((row, i) => {
          const meta = TRACE_KIND_META[row.kind];
          const tile = getTraceTile(row);
          const isLast = i === rows.length - 1;
          return (
            <div
              key={`${row.call}-${i}`}
              class="flex items-stretch gap-3"
              style={{ paddingBottom: isLast ? 0 : "12px" }}
            >
              <div class="relative flex flex-col items-center shrink-0 w-8">
                <div
                  class="w-8 h-8 shrink-0 rounded-lg flex items-center justify-center text-[11px] font-semibold relative z-10"
                  style={{
                    color: tile.fg,
                    backgroundColor: tile.bg,
                    border: `1px solid ${tile.border}`,
                  }}
                >
                  {tile.text}
                </div>
                {!isLast ? (
                  <div
                    class="absolute w-px"
                    style={{
                      left: "50%",
                      top: "32px",
                      bottom: "-12px",
                      transform: "translateX(-50%)",
                      background:
                        "linear-gradient(180deg, rgba(255,255,255,0.18) 0%, rgba(255,255,255,0.08) 100%)",
                    }}
                  />
                ) : null}
              </div>
              <div
                class="flex-1 min-w-0 rounded-xl px-3 py-3"
                style={{
                  backgroundColor: "rgba(255,255,255,0.035)",
                  border: "1px solid rgba(255,255,255,0.07)",
                }}
              >
                <div class="flex items-center gap-2 flex-wrap">
                  <span
                    class="text-sm font-semibold"
                    style={{ color: "var(--color-page-text)" }}
                  >
                    {row.source}
                  </span>
                  <span
                    class="text-[10px] uppercase tracking-[0.18em] px-1.5 py-0.5 rounded"
                    style={{
                      color: meta.color,
                      border: `1px solid ${meta.color}`,
                    }}
                  >
                    {meta.label}
                  </span>
                </div>
                <div
                  class="font-mono text-[11px] mt-1 break-all"
                  style={{ color: "var(--color-page-text-muted)" }}
                >
                  {row.call}
                </div>
                <div
                  class="text-sm mt-1.5"
                  style={{ color: "var(--color-page-text)" }}
                >
                  <span style={{ color: meta.color }}>{"\u2192 "}</span>
                  {row.result}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div class="mt-5 grid gap-3">
        <div class="grid gap-2 sm:grid-cols-[8rem_1fr] items-start">
          <div
            class="text-[10px] uppercase tracking-[0.18em] sm:pt-1"
            style={{ color: "var(--color-page-text-muted)" }}
          >
            MCP server
          </div>
          <div class="flex flex-wrap gap-1.5">
            <span
              class="text-[11px] font-mono px-2 py-1 rounded-full"
              style={{
                color: "var(--color-page-text)",
                backgroundColor: "rgba(255,255,255,0.05)",
                border: "1px solid rgba(255,255,255,0.09)",
              }}
            >
              {mcpServer}
            </span>
          </div>
          <div
            class="text-[10px] uppercase tracking-[0.18em] sm:pt-1"
            style={{ color: "var(--color-page-text-muted)" }}
          >
            Network allowlist
          </div>
          <div class="flex flex-wrap gap-1.5">
            {allowedDomains.map((domain) => (
              <span
                key={domain}
                class="text-[11px] font-mono px-2 py-1 rounded-full"
                style={{
                  color: "var(--color-page-text-muted)",
                  backgroundColor: "rgba(255,255,255,0.03)",
                  border: "1px solid rgba(255,255,255,0.08)",
                }}
              >
                {domain}
              </span>
            ))}
          </div>
        </div>
        {entities.length ? (
          <div class="grid gap-2">
            <div
              class="text-[10px] uppercase tracking-[0.18em]"
              style={{ color: "var(--color-page-text-muted)" }}
            >
              Entities touched
            </div>
            <div class="grid gap-2 sm:grid-cols-2">
              {entities.map((node) => (
                <EntityCard key={node.id} node={node} />
              ))}
            </div>
          </div>
        ) : null}
        {relation ? (
          <div class="grid gap-1">
            <div
              class="text-[10px] uppercase tracking-[0.18em]"
              style={{ color: "var(--color-page-text-muted)" }}
            >
              Relationship
            </div>
            <RelationshipTriple relation={relation} />
          </div>
        ) : null}
      </div>

      <div class="mt-4 flex flex-wrap gap-4">
        <a
          href={skillsHref}
          class="text-xs hover:underline"
          style={{ color: "var(--color-tg-accent)" }}
        >
          Learn more about Skills →
        </a>
        <a
          href={memoryHref}
          class="text-xs hover:underline"
          style={{ color: "var(--color-tg-accent)" }}
        >
          Learn more about Memory →
        </a>
      </div>
    </div>
  );
}

function RequestBlock({
  label,
  text,
  showPlatforms = false,
}: {
  label: string;
  text: string;
  showPlatforms?: boolean;
}) {
  return (
    <div
      class="rounded-xl p-4 mb-5"
      style={{
        backgroundColor: "rgba(0,0,0,0.28)",
        border: "1px solid rgba(255,255,255,0.06)",
      }}
    >
      <div
        class="text-[10px] uppercase tracking-[0.18em] mb-2"
        style={{ color: "var(--color-page-text-muted)" }}
      >
        {label}
      </div>
      <div
        class="text-sm leading-7"
        style={{ color: "var(--color-page-text)" }}
      >
        {text}
      </div>
      {showPlatforms ? (
        <div class="flex flex-wrap gap-2 mt-4">
          {deliverySurfaces.map((surface) => (
            <a
              key={surface.id}
              href={surface.href}
              class="inline-flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-full transition-opacity hover:opacity-80"
              style={{
                color: "var(--color-page-text-muted)",
                backgroundColor: "rgba(255,255,255,0.04)",
                border: "1px solid rgba(255,255,255,0.06)",
              }}
            >
              <span class="shrink-0" aria-hidden="true">
                {surface.renderIcon(12)}
              </span>
              {surface.label}
            </a>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function DemoSection(props: {
  defaultUseCaseId?: LandingUseCaseId;
  activeUseCaseId?: LandingUseCaseId;
  onActiveUseCaseChange?: (id: LandingUseCaseId) => void;
  showTabs?: boolean;

  linkTabsToCampaigns?: boolean;
}) {
  const [internalUseCaseId, setInternalUseCaseId] = useState(
    props.activeUseCaseId ??
      props.defaultUseCaseId ??
      DEFAULT_LANDING_USE_CASE_ID
  );

  useEffect(() => {
    if (props.activeUseCaseId) {
      setInternalUseCaseId(props.activeUseCaseId);
    }
  }, [props.activeUseCaseId]);

  const resolvedUseCaseId =
    props.activeUseCaseId ?? internalUseCaseId ?? props.defaultUseCaseId;
  const activeUseCase = useMemo(
    () => getLandingUseCaseShowcase(resolvedUseCaseId),
    [resolvedUseCaseId]
  );
  const memoryHref = `/memory/for/${activeUseCase.id}`;
  const skillsHref = `/skills/for/${activeUseCase.id}`;

  return (
    <section id="how-it-works" class="pt-4 pb-14 px-8">
      <div class="w-full max-w-[72rem] mx-auto px-2 sm:px-6 lg:px-6 box-border">
        {props.showTabs === false ? null : (
          <ScopedUseCaseTabs
            groups={landingUseCaseGroupedOptions}
            activeId={activeUseCase.id}
            onSelect={
              props.linkTabsToCampaigns
                ? undefined
                : (id) => {
                    const nextId = id as LandingUseCaseId;
                    props.onActiveUseCaseChange?.(nextId);
                    if (props.activeUseCaseId === undefined) {
                      setInternalUseCaseId(nextId);
                    }
                  }
            }
            hrefForId={
              props.linkTabsToCampaigns ? (id) => `/for/${id}` : undefined
            }
            className="mb-6"
          />
        )}

        <div class="mb-6">
          <Card
            title={activeUseCase.label || " Agent"}
            description={activeUseCase.runtime.summary}
          >
            <RequestBlock
              label={activeUseCase.runtime.requestLabel}
              text={activeUseCase.runtime.request}
              showPlatforms
            />
            <ResponseBlock
              label={activeUseCase.runtime.responseLabel}
              text={activeUseCase.runtime.response}
            />
            {activeUseCase.runtime.trace?.length ? (
              <TraceSection
                rows={activeUseCase.runtime.trace}
                skillsHref={skillsHref}
                memoryHref={memoryHref}
                mcpServer={activeUseCase.skills.mcpServer}
                allowedDomains={activeUseCase.skills.allowedDomains}
                entities={activeUseCase.memory.recordTree.children ?? []}
                relation={activeUseCase.memory.relations[0]}
              />
            ) : null}
          </Card>
        </div>
      </div>
    </section>
  );
}

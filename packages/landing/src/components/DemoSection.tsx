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
  getOwlettoOrgSlug,
  getOwlettoUrl,
  landingUseCaseGroupedOptions,
  type TraceRow,
  type WatcherEvent,
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
  surface = true,
  children,
}: {
  title?: string;
  description?: string;
  href?: string;
  hrefLabel?: string;
  surface?: boolean;
  children: ComponentChildren;
}) {
  return (
    <div
      class={surface ? "rounded-2xl p-6 h-full" : "h-full"}
      style={
        surface
          ? {
              backgroundColor: "var(--color-page-bg-elevated)",
              border: "1px solid var(--color-page-border)",
            }
          : undefined
      }
    >
      {title || href ? (
        <div class="flex items-center justify-between gap-3 mb-2">
          {title ? (
            <h3
              class="text-lg font-semibold"
              style={{ color: "var(--color-page-text)" }}
            >
              {title}
            </h3>
          ) : (
            <div />
          )}
          {href ? (
            <a
              href={href}
              class="text-sm font-medium transition-opacity hover:opacity-80 shrink-0"
              style={{ color: "var(--color-tg-accent)" }}
            >
              {hrefLabel ?? `${title ?? "Details"} page`} →
            </a>
          ) : null}
        </div>
      ) : null}
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

function Panel({
  children,
  extraClass,
}: {
  children: ComponentChildren;
  extraClass?: string;
}) {
  return (
    <div
      class={`rounded-xl p-4${extraClass ? ` ${extraClass}` : ""}`}
      style={{
        background:
          "linear-gradient(180deg, rgba(20, 20, 24, 0.98), rgba(12, 12, 16, 0.98))",
        border: "1px solid rgba(255, 255, 255, 0.09)",
      }}
    >
      {children}
    </div>
  );
}

function SectionLabel({
  children,
  accent,
  extraClass,
}: {
  children: ComponentChildren;
  accent?: boolean;
  extraClass?: string;
}) {
  return (
    <div
      class={`text-[10px] uppercase tracking-[0.18em]${extraClass ? ` ${extraClass}` : ""}`}
      style={{
        color: accent
          ? "var(--color-tg-accent)"
          : "var(--color-page-text-muted)",
      }}
    >
      {children}
    </div>
  );
}

function TraceStep({
  tile,
  call,
  result,
  resultAccent,
  isLast,
  children,
}: {
  tile: TraceTile;
  call: string;
  result: string;
  resultAccent: string;
  isLast: boolean;
  children?: ComponentChildren;
}) {
  return (
    <div
      class="flex items-stretch gap-2"
      style={{ paddingBottom: isLast ? 0 : "8px" }}
    >
      <div class="relative flex flex-col items-center shrink-0 w-5">
        <div
          class="w-4 h-4 shrink-0 rounded-full relative z-10"
          title={tile.text}
          style={{
            backgroundColor: tile.bg,
            border: `1px solid ${tile.border}`,
          }}
        >
          <span
            class="absolute inset-[3px] rounded-full"
            style={{ backgroundColor: tile.fg }}
          />
        </div>
        {!isLast ? (
          <div
            class="absolute w-px"
            style={{
              left: "50%",
              top: "16px",
              bottom: "-8px",
              transform: "translateX(-50%)",
              background:
                "linear-gradient(180deg, rgba(255,255,255,0.18) 0%, rgba(255,255,255,0.08) 100%)",
            }}
          />
        ) : null}
      </div>
      <div class="flex-1 min-w-0 py-0.5">
        <div
          class="font-mono text-[11px] break-all"
          style={{ color: "var(--color-page-text)" }}
        >
          {call}
        </div>
        <div
          class="text-[12px] mt-0.5 leading-snug"
          style={{ color: "var(--color-page-text-muted)" }}
        >
          <span style={{ color: resultAccent }}>{"\u2192 "}</span>
          {result}
        </div>
        {children}
      </div>
    </div>
  );
}

function ResponseBlock({
  text,
  platforms,
  outcomeChannel,
}: {
  text: string;
  platforms?: typeof deliverySurfaces;
  outcomeChannel?: string;
}) {
  return (
    <div
      class="rounded-xl p-4"
      style={{
        backgroundColor: "rgba(255,255,255,0.03)",
        border: "1px solid var(--color-tg-accent)",
      }}
    >
      {outcomeChannel ? (
        <div class="flex items-center gap-2 mb-3">
          <SectionLabel accent>Outcome →</SectionLabel>
          <span class="text-sm" style={{ color: "var(--color-page-text)" }}>
            {outcomeChannel}
          </span>
        </div>
      ) : null}
      <div
        class="text-sm leading-7"
        style={{ color: "var(--color-page-text)" }}
      >
        {text}
      </div>
      {platforms?.length ? (
        <div
          class="flex flex-wrap items-center gap-2 mt-4 pt-4"
          style={{ borderTop: "1px solid rgba(255,255,255,0.08)" }}
        >
          <SectionLabel extraClass="mr-1">Available in</SectionLabel>
          {platforms.map((surface) => (
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

function PanelHeader({
  label,
  href,
  hrefLabel,
}: {
  label: string;
  href: string;
  hrefLabel: string;
}) {
  return (
    <div class="flex items-center justify-between gap-3 mb-3">
      <SectionLabel>{label}</SectionLabel>
      <a
        href={href}
        class="text-[11px] hover:underline shrink-0"
        style={{ color: "var(--color-tg-accent)" }}
      >
        {hrefLabel} →
      </a>
    </div>
  );
}

const watcherTile: TraceTile = {
  text: "◉",
  fg: accentCyan,
  bg: "rgba(103, 232, 249, 0.12)",
  border: "rgba(103, 232, 249, 0.4)",
};

function TraceList({
  rows,
  events,
}: {
  rows: TraceRow[];
  events: WatcherEvent[];
}) {
  return (
    <Panel extraClass="h-full">
      <SectionLabel extraClass="mb-3">Trace</SectionLabel>
      <div class="flex flex-col">
        <TraceStep
          tile={watcherTile}
          call="watcher.poll(since: last_run)"
          result={`${events.length} event${events.length === 1 ? "" : "s"} collected`}
          resultAccent={accentCyan}
          isLast={false}
        >
          <div class="flex flex-col gap-1 mt-2">
            {events.map((event, i) => (
              <div
                key={`${event.source}-${i}`}
                class="flex items-start gap-2 text-[12px] leading-snug"
              >
                <span
                  class="font-mono text-[10px] shrink-0 pt-0.5"
                  style={{ color: "var(--color-page-text-muted)" }}
                >
                  {event.time}
                </span>
                <span
                  class="font-semibold shrink-0"
                  style={{ color: "var(--color-page-text)" }}
                >
                  {event.source}
                </span>
                <span style={{ color: "var(--color-page-text-muted)" }}>
                  {event.text}
                </span>
              </div>
            ))}
          </div>
        </TraceStep>
        {rows.map((row, i) => (
          <TraceStep
            key={`${row.call}-${i}`}
            tile={getTraceTile(row)}
            call={row.call}
            result={row.result}
            resultAccent={TRACE_KIND_META[row.kind].color}
            isLast={i === rows.length - 1}
          />
        ))}
      </div>
    </Panel>
  );
}

function Chip({
  children,
  emphasize,
}: {
  children: ComponentChildren;
  emphasize?: boolean;
}) {
  return (
    <span
      class="text-[11px] font-mono px-2 py-1 rounded-full"
      style={{
        color: emphasize
          ? "var(--color-page-text)"
          : "var(--color-page-text-muted)",
        backgroundColor: emphasize
          ? "rgba(255,255,255,0.05)"
          : "rgba(255,255,255,0.03)",
        border: emphasize
          ? "1px solid rgba(255,255,255,0.09)"
          : "1px solid rgba(255,255,255,0.08)",
      }}
    >
      {children}
    </span>
  );
}

function SkillsPanel({
  mcpServers,
  allowedDomains,
  skillsHref,
}: {
  mcpServers: string[];
  allowedDomains: string[];
  skillsHref: string;
}) {
  return (
    <Panel>
      <PanelHeader
        label="Skills"
        href={skillsHref}
        hrefLabel="Learn about Skills"
      />
      <div class="grid gap-2 sm:grid-cols-[5.5rem_1fr] items-start">
        <SectionLabel extraClass="sm:pt-1">MCP</SectionLabel>
        <div class="flex flex-wrap gap-1.5">
          {mcpServers.map((server) => (
            <Chip key={server} emphasize>
              {server}
            </Chip>
          ))}
        </div>
        <SectionLabel extraClass="sm:pt-1">Network</SectionLabel>
        <div class="flex flex-wrap gap-1.5">
          {allowedDomains.map((domain) => (
            <Chip key={domain}>{domain}</Chip>
          ))}
        </div>
      </div>
    </Panel>
  );
}

function MemoryPanel({
  entities,
  relation,
  memoryHref,
}: {
  entities: RecordNode[];
  relation?: ExampleRelation;
  memoryHref: string;
}) {
  return (
    <Panel>
      <PanelHeader
        label="Memory"
        href={memoryHref}
        hrefLabel="Learn about Memory"
      />
      <div class="grid gap-3">
        {entities.length ? (
          <div class="grid gap-1.5">
            <SectionLabel>Entities touched</SectionLabel>
            <div class="grid gap-2 sm:grid-cols-2">
              {entities.map((node) => (
                <EntityCard key={node.id} node={node} />
              ))}
            </div>
          </div>
        ) : null}
        {relation ? (
          <div class="grid gap-1">
            <SectionLabel>Relationship</SectionLabel>
            <RelationshipTriple relation={relation} />
          </div>
        ) : null}
      </div>
    </Panel>
  );
}

function RequestBlock({ text, schedule }: { text: string; schedule: string }) {
  return (
    <Panel extraClass="mb-5">
      <div class="flex items-center gap-3 mb-3">
        <SectionLabel accent>Cron</SectionLabel>
        <span class="text-sm" style={{ color: "var(--color-page-text)" }}>
          {schedule}
        </span>
      </div>
      <div
        class="text-sm leading-7"
        style={{ color: "var(--color-page-text)" }}
      >
        {text}
      </div>
    </Panel>
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
  const orgSlug = getOwlettoOrgSlug(activeUseCase.id);
  const embedUrl = orgSlug ? getOwlettoUrl(activeUseCase.id) : null;
  const mcpServers = useMemo(() => {
    const declared = activeUseCase.skills.skills?.filter(Boolean) ?? [];
    if (declared.length) return declared;
    const fromTrace = new Set<string>();
    for (const row of activeUseCase.runtime.trace ?? []) {
      if (row.kind !== "skill") continue;
      const prefix = row.call.split(/[.:(]/)[0]?.trim();
      if (prefix) fromTrace.add(prefix);
    }
    return Array.from(fromTrace);
  }, [activeUseCase]);

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
          <Card surface={false}>
            <RequestBlock
              text={activeUseCase.runtime.request}
              schedule={activeUseCase.runtime.schedule}
            />
            {activeUseCase.runtime.trace?.length ? (
              <div class="mt-5 grid gap-4 md:grid-cols-2">
                <TraceList
                  rows={activeUseCase.runtime.trace}
                  events={activeUseCase.runtime.events}
                />
                <div class="flex flex-col gap-4">
                  <SkillsPanel
                    mcpServers={mcpServers}
                    allowedDomains={activeUseCase.skills.allowedDomains}
                    skillsHref={skillsHref}
                  />
                  <MemoryPanel
                    entities={activeUseCase.memory.recordTree.children ?? []}
                    relation={activeUseCase.memory.relations[0]}
                    memoryHref={memoryHref}
                  />
                </div>
              </div>
            ) : null}
            <div class="mt-5">
              <ResponseBlock
                text={activeUseCase.runtime.response}
                platforms={deliverySurfaces}
                outcomeChannel={activeUseCase.runtime.outcomeChannel}
              />
            </div>
          </Card>
        </div>

        {embedUrl ? (
          <div class="mb-6">
            <Card
              title="Live workspace"
              description={`Read-only preview of the ${activeUseCase.label} workspace running on Lobu.`}
              href={embedUrl}
              hrefLabel="Open workspace"
            >
              <div
                class="rounded-xl overflow-hidden"
                style={{
                  border: "1px solid var(--color-page-border)",
                  height: "640px",
                }}
              >
                <iframe
                  src={embedUrl}
                  title={`${activeUseCase.label} workspace`}
                  loading="lazy"
                  style={{
                    width: "100%",
                    height: "100%",
                    border: "0",
                    background: "var(--color-page-bg)",
                  }}
                />
              </div>
            </Card>
          </div>
        ) : null}
      </div>
    </section>
  );
}

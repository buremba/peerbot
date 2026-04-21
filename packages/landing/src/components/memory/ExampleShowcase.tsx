import type { ComponentChildren } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import { examples, type RecordNode } from "../../memory-examples";
import { landingUseCaseGroupedOptions } from "../../use-case-showcases";
import { Chip } from "../Chip";
import { ContentRail } from "../ContentRail";
import { SectionHeader } from "../SectionHeader";
import { ScopedUseCaseTabs } from "../ScopedUseCaseTabs";
import {
  accentCyan,
  cardBorderFaint,
  cardBorderSubtle,
  deepBg,
  innerCardBg,
  labelGray,
  textColor,
  textMuted,
} from "./styles";

function findRecordNode(node: RecordNode, id: string): RecordNode | null {
  if (node.id === id) {
    return node;
  }

  for (const child of node.children ?? []) {
    const found = findRecordNode(child, id);
    if (found) {
      return found;
    }
  }

  return null;
}

function getDefaultSelectedNodeId(example: (typeof examples)[number]) {
  return (
    Object.values(example.entitySelections ?? {})[0] ?? example.recordTree.id
  );
}

function normalizeNodeReference(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function getNodeAliases(
  node: RecordNode,
  highlights: Array<{ value: string }>
): string[] {
  const labelAlias = node.label.includes(": ")
    ? node.label.split(": ")[1]
    : node.label;

  return [labelAlias, ...highlights.map((highlight) => highlight.value)]
    .map(normalizeNodeReference)
    .filter(Boolean);
}

function relationMatchesNode(reference: string, nodeAliases: string[]) {
  const normalizedReference = normalizeNodeReference(reference);

  return nodeAliases.some(
    (alias) =>
      alias === normalizedReference ||
      alias.includes(normalizedReference) ||
      normalizedReference.includes(alias)
  );
}

function getDerivedPanelTable(
  stepId: string,
  step: (typeof examples)[number]["howItWorks"][number]
) {
  if (step.panel?.table) {
    return step.panel.table;
  }

  if (!step.panel?.items?.length) {
    return null;
  }

  if (stepId === "connect") {
    return {
      columns: ["Type", "Source", "Added context"],
      rows: step.panel.items.map((item) => [
        item.meta ?? "Source",
        item.label,
        item.detail,
      ]),
    };
  }

  if (stepId === "auth") {
    return {
      columns: ["Access", "System", "How it works"],
      rows: step.panel.items.map((item) => [
        item.meta ?? "Access",
        item.label,
        item.detail,
      ]),
    };
  }

  return null;
}

function PlatformLogo({
  platformId,
}: {
  platformId: "slack" | "openclaw" | "chatgpt" | "claude";
}) {
  if (platformId === "slack") {
    return (
      <svg
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="currentColor"
        aria-hidden="true"
      >
        <path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z" />
      </svg>
    );
  }

  if (platformId === "openclaw") {
    return (
      <svg
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M7 18c1.5-3 3.2-4.8 5-5.5" />
        <path d="M12 12.5c.6-2.5 2-4.5 4.5-6" />
        <path d="M7 18c-.8 1.2-1.8 2.1-3 2.7" />
        <path d="M12 12.5c-.4-2.2-.2-4.2.7-6.2" />
        <path d="M12 12.5c2 .3 3.9 1.2 5.8 2.8" />
      </svg>
    );
  }

  if (platformId === "chatgpt") {
    return (
      <img
        src="https://www.google.com/s2/favicons?domain=openai.com&sz=32"
        alt=""
        width="12"
        height="12"
        class="w-3 h-3 rounded-sm"
        loading="lazy"
      />
    );
  }

  return (
    <img
      src="https://www.google.com/s2/favicons?domain=anthropic.com&sz=32"
      alt=""
      width="12"
      height="12"
      class="w-3 h-3 rounded-sm"
      loading="lazy"
    />
  );
}

const primaryAccent = "var(--color-tg-accent)";
const primaryAccentSoft = "rgba(var(--color-tg-accent-rgb), 0.08)";
const primaryAccentSoftStrong = "rgba(var(--color-tg-accent-rgb), 0.12)";
const primaryAccentBorder = "1px solid rgba(var(--color-tg-accent-rgb), 0.24)";
const primaryAccentBorderStrong =
  "1px solid rgba(var(--color-tg-accent-rgb), 0.3)";

const stepColors = {
  model: primaryAccent,
  connect: primaryAccent,
  auth: primaryAccent,
  reuse: primaryAccent,
  fresh: primaryAccent,
};

function formatStepLabel(label: string) {
  return label.length === 1 ? `0${label}` : label;
}

function StepIntro({
  stepLabel,
  title,
  detail,
  color,
}: {
  stepLabel: string;
  title: string;
  detail: string;
  color: string;
}) {
  return (
    <div class="mb-5">
      <div
        class="text-[11px] font-semibold uppercase tracking-[0.24em] mb-2"
        style={{ color }}
      >
        {formatStepLabel(stepLabel)}
      </div>
      <h3
        class="text-xl sm:text-2xl font-bold tracking-tight mb-2"
        style={{ color: textColor }}
      >
        {title}
      </h3>
      <p class="text-sm leading-relaxed" style={{ color: textMuted }}>
        {detail}
      </p>
    </div>
  );
}

function DetailCard({ children }: { children: ComponentChildren }) {
  return (
    <div
      class="rounded-[1.5rem] p-4 sm:p-5 border"
      style={{
        backgroundColor: innerCardBg,
        borderColor: cardBorderSubtle,
      }}
    >
      {children}
    </div>
  );
}

function LinkRow({ links }: { links: Array<{ label: string; href: string }> }) {
  if (!links.length) return null;

  return (
    <div class="flex flex-wrap gap-3 text-sm">
      {links.map((link) => (
        <a
          key={link.href}
          href={link.href}
          class="transition-colors hover:opacity-80"
          style={{ color: "var(--color-tg-accent)" }}
        >
          {link.label} →
        </a>
      ))}
    </div>
  );
}

function getConnectionHref(
  platformId: "slack" | "openclaw" | "chatgpt" | "claude",
  useCaseId: string
) {
  if (platformId === "slack") {
    return "/platforms/slack/";
  }

  if (platformId === "chatgpt") {
    return `/connect-from/chatgpt/for/${useCaseId}`;
  }

  if (platformId === "claude") {
    return `/connect-from/claude/for/${useCaseId}`;
  }

  return `/connect-from/openclaw/for/${useCaseId}`;
}

function getConnectionLabel(
  platformId: "slack" | "openclaw" | "chatgpt" | "claude"
) {
  if (platformId === "slack") {
    return "Slack";
  }

  if (platformId === "chatgpt") {
    return "Connect from ChatGPT";
  }

  if (platformId === "claude") {
    return "Connect from Claude";
  }

  return "Install to OpenClaw";
}

export function ExampleShowcase(props: {
  activeUseCaseId?: string;
  onActiveUseCaseChange?: (id: string) => void;
  showTabs?: boolean;
}) {
  const { activeUseCaseId, onActiveUseCaseChange, showTabs = true } = props;
  const [internalUseCaseId, setInternalUseCaseId] = useState(
    activeUseCaseId ?? examples[0].useCaseId
  );

  const resolvedUseCaseId = activeUseCaseId ?? internalUseCaseId;
  const activeExample = useMemo(
    () =>
      examples.find((example) => example.useCaseId === resolvedUseCaseId) ??
      examples[0],
    [resolvedUseCaseId]
  );
  const [selectedNodeId, setSelectedNodeId] = useState(
    getDefaultSelectedNodeId(activeExample)
  );

  useEffect(() => {
    setSelectedNodeId(getDefaultSelectedNodeId(activeExample));
  }, [activeExample.useCaseId]);

  const selectedNode =
    findRecordNode(activeExample.recordTree, selectedNodeId) ??
    activeExample.recordTree;
  const selectedHighlights =
    activeExample.nodeHighlights?.[selectedNode.id] ?? activeExample.highlights;
  const selectedEntityLabel =
    Object.entries(activeExample.entitySelections ?? {}).find(
      ([, nodeId]) => nodeId === selectedNodeId
    )?.[0] ?? selectedNode.kind;
  const selectedNodeAliases = getNodeAliases(selectedNode, selectedHighlights);

  const switchExample = (id: string) => {
    onActiveUseCaseChange?.(id);
    if (activeUseCaseId === undefined) {
      setInternalUseCaseId(id);
    }
  };

  return (
    <div class="max-w-[68rem] mx-auto px-4 sm:px-6 pt-1">
      {showTabs ? (
        <ScopedUseCaseTabs
          groups={landingUseCaseGroupedOptions}
          activeId={activeExample.useCaseId}
          onSelect={switchExample}
          className="mb-5"
        />
      ) : null}

      <div class="text-center mb-4 mt-6">
        <a
          href={`https://github.com/lobu-ai/lobu/tree/main/examples/${activeExample.examplePath}`}
          target="_blank"
          rel="noopener noreferrer"
          class="text-xs font-medium hover:underline inline-flex items-center gap-1.5"
          style={{ color: "var(--color-tg-accent)" }}
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="currentColor"
            aria-hidden="true"
          >
            <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
          </svg>
          See full example on GitHub →
        </a>
      </div>

      <ContentRail variant="compact" className="mt-10">
        <SectionHeader
          title="How it works"
          body="Turn scattered prompts, tools, and application data into a shared context layer your agents can use everywhere."
          className="mb-12"
        />

        <div class="space-y-10">
          {activeExample.howItWorks.map((step) => {
            const color = stepColors[step.id];
            const panelTable = getDerivedPanelTable(step.id, step);

            if (step.id === "model") {
              return (
                <div
                  key={step.label}
                  class="grid grid-cols-1 lg:grid-cols-[minmax(16rem,0.78fr)_minmax(24rem,1fr)] gap-6 items-start"
                >
                  <div class="min-w-0">
                    <StepIntro
                      stepLabel={step.label}
                      title={step.title}
                      detail={step.detail}
                      color={color}
                    />

                    <div class="grid gap-3">
                      <LinkRow links={step.links ?? []} />

                      <div>
                        <div
                          class="text-[10px] uppercase tracking-[0.18em] mb-2"
                          style={{ color: labelGray }}
                        >
                          Entities
                        </div>
                        <div class="flex flex-wrap gap-1.5">
                          {(step.chips ?? activeExample.entityTypes).map(
                            (type) => {
                              const targetNodeId =
                                activeExample.entitySelections?.[type];

                              return (
                                <Chip
                                  key={type}
                                  label={type}
                                  active={targetNodeId === selectedNodeId}
                                  onClick={
                                    targetNodeId
                                      ? () => setSelectedNodeId(targetNodeId)
                                      : undefined
                                  }
                                  color={primaryAccent}
                                />
                              );
                            }
                          )}
                        </div>
                      </div>
                    </div>
                  </div>

                  <div class="min-w-0">
                    <DetailCard>
                      <div
                        class="text-[11px] font-semibold uppercase tracking-[0.24em] mb-3"
                        style={{ color: primaryAccent }}
                      >
                        Selected node
                      </div>
                      <div class="flex flex-wrap items-start justify-between gap-3 mb-4">
                        <div class="grid gap-1">
                          <div
                            class="text-[10px] uppercase tracking-[0.18em]"
                            style={{ color: labelGray }}
                          >
                            {selectedEntityLabel}
                          </div>
                          <div
                            class="text-lg font-semibold"
                            style={{ color: textColor }}
                          >
                            {selectedNode.label}
                          </div>
                        </div>
                        <span
                          class="px-2 py-0.5 rounded-full text-[10px] uppercase tracking-[0.14em]"
                          style={{
                            color: primaryAccent,
                            backgroundColor: primaryAccentSoft,
                            border: primaryAccentBorder,
                          }}
                        >
                          {selectedNode.kind}
                        </span>
                      </div>
                      <div
                        class="rounded-xl p-3 border min-h-[12.5rem] lg:h-[12.5rem] flex flex-col"
                        style={{
                          backgroundColor: deepBg,
                          borderColor: cardBorderSubtle,
                        }}
                      >
                        <div class="grid gap-3 sm:grid-cols-2">
                          {selectedHighlights.map((highlight) => (
                            <div key={highlight.label} class="grid gap-0.5">
                              <div
                                class="text-[10px] uppercase tracking-[0.2em]"
                                style={{ color: labelGray }}
                              >
                                {highlight.label}
                              </div>
                              <div class="text-sm" style={{ color: textColor }}>
                                {highlight.value}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>

                      {/* Relevant relationships for the selected node */}
                      {(() => {
                        const relevantRelations =
                          activeExample.relations.filter(
                            (relation) =>
                              relationMatchesNode(
                                relation.source,
                                selectedNodeAliases
                              ) ||
                              relationMatchesNode(
                                relation.target,
                                selectedNodeAliases
                              )
                          );
                        if (relevantRelations.length === 0) return null;

                        return (
                          <div class="mt-3">
                            <div
                              class="text-[10px] uppercase tracking-[0.18em] mb-2"
                              style={{ color: labelGray }}
                            >
                              Relationships
                            </div>
                            <div class="flex flex-wrap gap-2">
                              {relevantRelations.map((relation) => {
                                const isSelectedSource = relationMatchesNode(
                                  relation.source,
                                  selectedNodeAliases
                                );
                                const isSelectedTarget = relationMatchesNode(
                                  relation.target,
                                  selectedNodeAliases
                                );

                                return (
                                  <div
                                    key={`${relation.source}-${relation.label}`}
                                    class="flex flex-wrap items-center gap-1"
                                  >
                                    <span
                                      class="px-1.5 py-0.5 rounded-full text-[10px]"
                                      style={{
                                        color: isSelectedSource
                                          ? primaryAccent
                                          : textColor,
                                        backgroundColor: isSelectedSource
                                          ? primaryAccentSoftStrong
                                          : "rgba(103, 232, 249, 0.08)",
                                        border: isSelectedSource
                                          ? primaryAccentBorderStrong
                                          : "1px solid rgba(103, 232, 249, 0.22)",
                                      }}
                                    >
                                      <span class="font-semibold">
                                        {relation.sourceType}
                                      </span>{" "}
                                      {relation.source}
                                    </span>
                                    <span
                                      class="px-1 py-0.5 rounded-full text-[9px] uppercase tracking-[0.12em]"
                                      style={{
                                        color: accentCyan,
                                        backgroundColor:
                                          "rgba(103, 232, 249, 0.06)",
                                        border:
                                          "1px solid rgba(103, 232, 249, 0.18)",
                                      }}
                                    >
                                      {relation.label}
                                    </span>
                                    <span
                                      class="px-1.5 py-0.5 rounded-full text-[10px]"
                                      style={{
                                        color: isSelectedTarget
                                          ? primaryAccent
                                          : textColor,
                                        backgroundColor: isSelectedTarget
                                          ? primaryAccentSoftStrong
                                          : "rgba(134, 239, 172, 0.08)",
                                        border: isSelectedTarget
                                          ? primaryAccentBorderStrong
                                          : "1px solid rgba(134, 239, 172, 0.22)",
                                      }}
                                    >
                                      <span class="font-semibold">
                                        {relation.targetType}
                                      </span>{" "}
                                      {relation.target}
                                    </span>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        );
                      })()}
                    </DetailCard>
                  </div>
                </div>
              );
            }

            if (step.id === "fresh") {
              return (
                <div
                  key={step.label}
                  class="grid grid-cols-1 lg:grid-cols-[minmax(16rem,0.78fr)_minmax(24rem,1fr)] gap-6 items-start"
                >
                  <div class="min-w-0">
                    <StepIntro
                      stepLabel={step.label}
                      title={step.title}
                      detail={step.detail}
                      color={color}
                    />
                  </div>

                  <div class="min-w-0">
                    <DetailCard>
                      <div class="mb-4">
                        <div
                          class="text-[11px] font-semibold uppercase tracking-[0.24em] mb-2"
                          style={{ color }}
                        >
                          Freshness watcher
                        </div>
                        <p
                          class="text-sm leading-6 m-0"
                          style={{ color: textMuted }}
                        >
                          A scheduled watcher keeps this memory current as new
                          source changes arrive.
                        </p>
                      </div>

                      <div class="flex flex-wrap items-center gap-2 mb-3">
                        <span
                          class="text-sm font-semibold"
                          style={{ color: textColor }}
                        >
                          {activeExample.watcher.name}
                        </span>
                        <span
                          class="px-2 py-0.5 rounded-full text-[10px] uppercase tracking-[0.14em]"
                          style={{
                            color: primaryAccent,
                            backgroundColor: primaryAccentSoft,
                            border: primaryAccentBorder,
                          }}
                        >
                          {activeExample.watcher.schedule}
                        </span>
                      </div>
                      <div class="grid gap-2">
                        <div
                          class="text-xs leading-5"
                          style={{ color: textMuted }}
                        >
                          {activeExample.watcher.prompt}
                        </div>
                        <div>
                          <div
                            class="text-[10px] uppercase tracking-[0.18em] mb-0.5"
                            style={{ color: primaryAccent }}
                          >
                            Extraction schema
                          </div>
                          <code
                            class="text-[11px] leading-5 block px-2 py-1.5 rounded-lg"
                            style={{
                              color: textColor,
                              backgroundColor: primaryAccentSoft,
                            }}
                          >
                            {activeExample.watcher.extractionSchema}
                          </code>
                        </div>
                        <div>
                          <div
                            class="text-[10px] uppercase tracking-[0.18em] mb-0.5"
                            style={{ color: primaryAccent }}
                          >
                            Schema evolution
                          </div>
                          <div
                            class="text-xs leading-5"
                            style={{ color: textMuted }}
                          >
                            {activeExample.watcher.schemaEvolution}
                          </div>
                        </div>
                      </div>
                    </DetailCard>
                  </div>
                </div>
              );
            }

            return (
              <div
                key={step.label}
                class="grid grid-cols-1 lg:grid-cols-[minmax(16rem,0.78fr)_minmax(24rem,1fr)] gap-6 items-start"
              >
                <div class="min-w-0">
                  <StepIntro
                    stepLabel={step.label}
                    title={step.title}
                    detail={step.detail}
                    color={color}
                  />
                  <LinkRow links={step.links ?? []} />
                </div>

                <div class="min-w-0">
                  <DetailCard>
                    {step.panel ? (
                      <>
                        <div class="mb-4">
                          <div
                            class="text-[11px] font-semibold uppercase tracking-[0.24em] mb-2"
                            style={{ color }}
                          >
                            {step.panel.title}
                          </div>
                          {step.panel.description ? (
                            <p
                              class="text-sm leading-6 m-0"
                              style={{ color: textMuted }}
                            >
                              {step.panel.description}
                            </p>
                          ) : null}
                        </div>

                        {panelTable ? (
                          <div
                            class="mb-4 overflow-hidden rounded-xl border"
                            style={{
                              borderColor: cardBorderSubtle,
                              backgroundColor: deepBg,
                            }}
                          >
                            <div class="overflow-x-auto">
                              <table class="min-w-full border-collapse text-left">
                                <thead>
                                  <tr>
                                    {panelTable.columns.map((column) => (
                                      <th
                                        key={column}
                                        class="px-3 py-2 text-[10px] font-semibold uppercase tracking-[0.18em]"
                                        style={{
                                          color,
                                          borderBottom: `1px solid ${cardBorderSubtle}`,
                                          backgroundColor:
                                            "rgba(255,255,255,0.02)",
                                        }}
                                      >
                                        {column}
                                      </th>
                                    ))}
                                  </tr>
                                </thead>
                                <tbody>
                                  {panelTable.rows.map((row) => (
                                    <tr key={row.join("-")}>
                                      {row.map((cell, index) => (
                                        <td
                                          key={`${row[0] ?? "row"}-${index}`}
                                          class="px-3 py-2 text-xs leading-5 align-top"
                                          style={{
                                            color:
                                              index === 0
                                                ? textColor
                                                : textMuted,
                                            borderBottom: `1px solid ${cardBorderFaint}`,
                                          }}
                                        >
                                          {cell}
                                        </td>
                                      ))}
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </div>
                        ) : step.panel.items?.length ? (
                          <div class="grid gap-3 sm:grid-cols-2 mb-4">
                            {step.panel.items.map((item) => (
                              <div
                                key={`${item.meta ?? ""}-${item.label}`}
                                class="rounded-xl p-3 border"
                                style={{
                                  backgroundColor: deepBg,
                                  borderColor: cardBorderSubtle,
                                }}
                              >
                                {item.meta ? (
                                  <div
                                    class="text-[10px] uppercase tracking-[0.18em] mb-1"
                                    style={{ color }}
                                  >
                                    {item.meta}
                                  </div>
                                ) : null}
                                <div
                                  class="text-sm font-semibold mb-1"
                                  style={{ color: textColor }}
                                >
                                  {item.label}
                                </div>
                                <div
                                  class="text-xs leading-5"
                                  style={{ color: textMuted }}
                                >
                                  {item.detail}
                                </div>
                                {item.platform ? (
                                  <a
                                    href={getConnectionHref(
                                      item.platform.id,
                                      activeExample.useCaseId
                                    )}
                                    class="mt-3 inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-[10px] font-medium transition-colors hover:opacity-80"
                                    style={{
                                      color: labelGray,
                                      backgroundColor: "rgba(255,255,255,0.03)",
                                      border: `1px solid ${cardBorderSubtle}`,
                                    }}
                                  >
                                    <PlatformLogo
                                      platformId={item.platform.id}
                                    />
                                    <span>
                                      {getConnectionLabel(item.platform.id)}
                                    </span>
                                  </a>
                                ) : null}
                              </div>
                            ))}
                          </div>
                        ) : null}
                      </>
                    ) : step.chips?.length ? (
                      <div class="flex flex-wrap gap-1.5 mb-4">
                        {step.chips.map((chip) => (
                          <Chip key={chip} label={chip} color={color} />
                        ))}
                      </div>
                    ) : null}
                  </DetailCard>
                </div>
              </div>
            );
          })}
        </div>
      </ContentRail>
    </div>
  );
}

import {
  cardBg,
  cardBorder,
  innerCardBg,
  textColor,
  textMuted,
} from "./styles";

// Benchmark numbers mirrored across:
//   - this component
//   - packages/landing/src/content/docs/guides/memory-benchmarks.md
//   - packages/landing/src/content/docs/getting-started/comparison.md
//   - packages/owletto/README.md (source of truth)
// Refresh all four on each Owletto memory-benchmark release.
// last updated: 2026-04-21
export const LONGMEMEVAL_ROWS: BenchmarkRow[] = [
  {
    system: "Owletto",
    overall: "87.1%",
    answer: "78.0%",
    retrieval: "100.0%",
    latency: "237ms",
    leader: true,
  },
  {
    system: "Supermemory",
    overall: "69.1%",
    answer: "56.0%",
    retrieval: "96.6%",
    latency: "702ms",
  },
  {
    system: "Mem0",
    overall: "65.7%",
    answer: "54.0%",
    retrieval: "85.3%",
    latency: "753ms",
  },
];

export const LOCOMO_ROWS: BenchmarkRow[] = [
  {
    system: "Owletto",
    overall: "57.8%",
    answer: "38.0%",
    retrieval: "79.5%",
    latency: "121ms",
    leader: true,
  },
  {
    system: "Mem0",
    overall: "41.5%",
    answer: "28.0%",
    retrieval: "66.9%",
    latency: "606ms",
  },
  {
    system: "Supermemory",
    overall: "23.2%",
    answer: "14.0%",
    retrieval: "36.5%",
    latency: "532ms",
  },
];

export type BenchmarkRow = {
  system: string;
  overall: string;
  answer: string;
  retrieval: string;
  latency: string;
  leader?: boolean;
};

export function BenchmarkTable(props: {
  title: string;
  subtitle: string;
  rows: BenchmarkRow[];
}) {
  return (
    <div
      class="rounded-2xl p-6 sm:p-8"
      style={{
        background: cardBg,
        border: `1px solid ${cardBorder}`,
      }}
    >
      <div class="mb-5">
        <h3 class="text-lg font-semibold mb-1" style={{ color: textColor }}>
          {props.title}
        </h3>
        <p class="text-xs leading-relaxed" style={{ color: textMuted }}>
          {props.subtitle}
        </p>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full text-sm" style={{ color: textColor }}>
          <thead>
            <tr
              class="text-left text-[11px] uppercase tracking-wider"
              style={{ color: textMuted }}
            >
              <th class="font-medium pb-3 pr-4">System</th>
              <th class="font-medium pb-3 px-3 text-right">Overall</th>
              <th class="font-medium pb-3 px-3 text-right">Answer</th>
              <th class="font-medium pb-3 px-3 text-right">Retrieval</th>
              <th class="font-medium pb-3 pl-3 text-right">Latency</th>
            </tr>
          </thead>
          <tbody>
            {props.rows.map((row) => (
              <tr
                key={row.system}
                style={{
                  background: row.leader ? innerCardBg : "transparent",
                }}
              >
                <td
                  class="py-2.5 pr-4 font-medium"
                  style={{
                    color: row.leader ? textColor : textMuted,
                  }}
                >
                  {row.system}
                </td>
                <td
                  class="py-2.5 px-3 text-right tabular-nums"
                  style={{
                    color: row.leader ? textColor : textMuted,
                    fontWeight: row.leader ? 600 : 400,
                  }}
                >
                  {row.overall}
                </td>
                <td
                  class="py-2.5 px-3 text-right tabular-nums"
                  style={{ color: row.leader ? textColor : textMuted }}
                >
                  {row.answer}
                </td>
                <td
                  class="py-2.5 px-3 text-right tabular-nums"
                  style={{ color: row.leader ? textColor : textMuted }}
                >
                  {row.retrieval}
                </td>
                <td
                  class="py-2.5 pl-3 text-right tabular-nums"
                  style={{ color: row.leader ? textColor : textMuted }}
                >
                  {row.latency}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function BenchmarkTablesGrid() {
  return (
    <div class="grid gap-5 md:grid-cols-2">
      <BenchmarkTable
        title="LongMemEval (oracle-50)"
        subtitle="Single-session knowledge retention."
        rows={LONGMEMEVAL_ROWS}
      />
      <BenchmarkTable
        title="LoCoMo-50"
        subtitle="Multi-session conversational memory."
        rows={LOCOMO_ROWS}
      />
    </div>
  );
}

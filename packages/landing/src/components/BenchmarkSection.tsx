import { ContentRail } from "./ContentRail";
import { SectionHeader } from "./SectionHeader";
import { BenchmarkTablesGrid } from "./memory/BenchmarkTables";
import { textColor } from "./memory/styles";

export function BenchmarkSection() {
  return (
    <section class="pt-20 pb-20 px-4 sm:px-8">
      <ContentRail variant="compact">
        <SectionHeader
          title="Beats Mem0 and Supermemory on public benchmarks"
          body="Apples-to-apples comparison on public memory datasets. Same answerer (glm-5.1 via z.ai), same top-K, same questions."
          className="mb-10"
        />

        <BenchmarkTablesGrid />

        <div class="mt-8 text-center">
          <a
            href="/guides/memory-benchmarks/"
            class="inline-flex items-center gap-2 text-xs font-medium px-4 py-2 rounded-lg transition-all hover:opacity-80"
            style={{
              backgroundColor: "var(--color-page-surface)",
              color: textColor,
              border: "1px solid var(--color-page-border-active)",
            }}
          >
            Read the methodology
          </a>
        </div>
      </ContentRail>
    </section>
  );
}

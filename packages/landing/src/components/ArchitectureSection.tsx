import type { LandingUseCaseId } from "../use-case-definitions";
import { ArchitectureDiagram } from "./ArchitectureDiagram";

export function ArchitectureSection(props: {
  activeUseCaseId?: LandingUseCaseId;
}) {
  return (
    <section id="architecture" class="py-12 px-8 relative">
      <div class="max-w-[72rem] mx-auto">
        <h2
          class="text-2xl sm:text-3xl font-bold text-center mb-6 tracking-tight"
          style={{ color: "var(--color-page-text)" }}
        >
          Architecture
        </h2>
        <p
          class="text-center text-sm mb-12 max-w-xl mx-auto"
          style={{ color: "var(--color-page-text-muted)" }}
        >
          Zero trust by default. Every agent runs in an isolated sandbox with no
          direct network access.
        </p>

        <div class="max-w-3xl mx-auto xl:max-w-none">
          <ArchitectureDiagram useCaseId={props.activeUseCaseId} />
        </div>
      </div>
    </section>
  );
}

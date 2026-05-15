import type { LandingUseCaseId } from "../use-case-definitions";
import { ArchitectureDiagram } from "./ArchitectureDiagram";

export function ArchitectureSection(props: {
  activeUseCaseId?: LandingUseCaseId;
}) {
  return (
    <section
      id="architecture"
      class="relative px-4 sm:px-6 max-w-[72rem] mx-auto pt-10"
    >
      <div
        class="rounded-2xl overflow-hidden dotted-bg"
        style={{
          border: "1px solid var(--color-page-border)",
          background: "var(--color-page-bg)",
        }}
      >
        <div class="px-6 sm:px-10 pt-10 pb-6 max-w-3xl">
          <div
            class="text-[12px] font-semibold tracking-[0.12em] uppercase mb-3"
            style={{ color: "var(--color-page-text-muted)" }}
          >
            Runs on your infrastructure
          </div>
          <h2
            class="font-display text-[28px] sm:text-[32px] font-semibold leading-[1.1] mb-3"
            style={{
              color: "var(--color-page-text)",
              letterSpacing: "-0.02em",
            }}
          >
            One gateway, isolated workers, no leaked secrets.
          </h2>
          <p
            class="text-[15px] leading-relaxed max-w-2xl"
            style={{ color: "var(--color-page-text-muted)" }}
          >
            Lobu receives messages at the gateway, starts sandboxed worker
            processes on demand, and proxies tools, memory, and credentials so
            agents stay isolated from your real keys.
          </p>
        </div>

        <div class="px-6 sm:px-10 pt-4 pb-10 overflow-x-auto">
          <div class="min-w-[44rem] md:min-w-0">
            <ArchitectureDiagram useCaseId={props.activeUseCaseId} />
          </div>
        </div>
      </div>
    </section>
  );
}

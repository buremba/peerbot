import { useReveal } from "./use-reveal";

type SectionHeaderProps = {
  title: string;
  body?: string;
  className?: string;
};

export function SectionHeader({
  title,
  body,
  className = "",
}: SectionHeaderProps) {
  const { ref, className: revealClassName } = useReveal<HTMLDivElement>();
  const composed = ["max-w-3xl mx-auto text-center", className, revealClassName]
    .filter(Boolean)
    .join(" ");

  return (
    <div ref={ref} class={composed}>
      <h2
        class="text-2xl sm:text-3xl font-bold tracking-tight mb-3"
        style={{ color: "var(--color-page-text)" }}
      >
        {title}
      </h2>
      {body ? (
        <p
          class="text-sm leading-relaxed"
          style={{ color: "var(--color-page-text-muted)" }}
        >
          {body}
        </p>
      ) : null}
    </div>
  );
}

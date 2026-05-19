/**
 * Faked terminal output panel. Same dark code-bg + dot title bar as the
 * landing's code blocks, but the body is a hand-built sequence of typed
 * segments rather than syntax-highlighted source.
 *
 * Used as the right-column "result" surface for each primitive section
 * (Connectors / Memory / Watchers / Agents). The lines come from
 * `terminal-outputs.ts`, keyed by `[useCaseId][section]`.
 */

export type TerminalSegmentKind =
  | "plain"
  | "muted"
  | "accent"
  | "string"
  | "key"
  | "green";

export type TerminalSegment = { text: string; kind?: TerminalSegmentKind };

export type TerminalLine = TerminalSegment[];

type TerminalPanelProps = {
  /** Text shown in the dot title bar (e.g. "lobu run · sales"). */
  title: string;
  /** Body lines. Each line is a list of segments concatenated as-is. */
  lines: TerminalLine[];
  /** Tailwind className for outer wrapper sizing. */
  className?: string;
};

const KIND_COLOR: Record<TerminalSegmentKind, string> = {
  plain: "var(--color-landing-code-text)",
  muted: "var(--color-landing-code-comment)",
  accent: "var(--color-landing-code-keyword)",
  string: "var(--color-landing-code-string)",
  key: "var(--color-landing-code-key)",
  green: "#66c84a",
};

export function TerminalPanel({ title, lines, className }: TerminalPanelProps) {
  return (
    <div
      class={`overflow-hidden rounded-lg border ${className ?? ""}`}
      style={{
        backgroundColor: "var(--color-landing-code-bg)",
        borderColor: "var(--color-page-border)",
      }}
    >
      <div
        class="flex items-center gap-1.5 border-b px-4 py-2 font-mono text-[11.5px]"
        style={{
          borderColor: "rgba(255,255,255,0.08)",
          color: "var(--color-landing-code-comment)",
        }}
      >
        <span
          class="inline-block h-2.5 w-2.5 rounded-full"
          style={{ backgroundColor: "#ee5847" }}
        />
        <span
          class="inline-block h-2.5 w-2.5 rounded-full"
          style={{ backgroundColor: "#f6bd2c" }}
        />
        <span
          class="inline-block h-2.5 w-2.5 rounded-full"
          style={{ backgroundColor: "#66c84a" }}
        />
        <span class="ml-2 lowercase">{title}</span>
      </div>
      <pre
        class="overflow-x-auto px-5 py-4 font-mono text-[12.5px] leading-[1.75]"
        style={{ color: "var(--color-landing-code-text)" }}
      >
        <code class="block">
          {lines.map((line, lineIdx) => (
            <span class="block whitespace-pre" key={lineIdx}>
              {line.map((seg, segIdx) => (
                <span
                  key={segIdx}
                  style={{ color: KIND_COLOR[seg.kind ?? "plain"] }}
                >
                  {seg.text}
                </span>
              ))}
              {lineIdx < lines.length - 1 ? "\n" : ""}
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}

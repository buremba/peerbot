const GITHUB_URL = "https://github.com/lobu-ai/lobu";

type FooterColumn = {
  heading: string;
  links: Array<{ label: string; href: string; external?: boolean }>;
};

const COLUMNS: FooterColumn[] = [
  {
    heading: "Product",
    links: [
      { label: "Memory", href: "/#memory" },
      { label: "Skills", href: "/#skills" },
      { label: "Architecture", href: "/guides/architecture/" },
      { label: "MCP", href: "/mcp/" },
    ],
  },
  {
    heading: "Solutions",
    links: [
      { label: "Legal", href: "/for/legal" },
      { label: "Sales", href: "/for/sales" },
      { label: "Finance", href: "/for/finance" },
      { label: "Leadership", href: "/for/leadership" },
      { label: "Market", href: "/for/market" },
      { label: "Community", href: "/for/agent-community" },
    ],
  },
  {
    heading: "Resources",
    links: [
      { label: "Docs", href: "/getting-started/" },
      { label: "Blog", href: "/blog/" },
      { label: "Benchmarks", href: "/guides/memory-benchmarks/" },
      { label: "MCP", href: "/mcp/" },
      { label: "GitHub", href: GITHUB_URL, external: true },
    ],
  },
  {
    heading: "Legal",
    links: [
      { label: "Privacy", href: "/privacy/" },
      { label: "Terms", href: "/terms/" },
    ],
  },
];

export function Footer() {
  return (
    <footer
      class="px-6 sm:px-8 pt-20 pb-10 mt-12"
      style={{
        background: "var(--color-page-bg)",
        color: "var(--color-page-text-muted)",
        borderTop: "1px solid var(--color-page-border)",
      }}
    >
      <div class="max-w-[72rem] mx-auto">
        <div class="grid grid-cols-2 md:grid-cols-5 gap-8">
          <div class="col-span-2 md:col-span-1">
            <a
              href="/"
              class="inline-flex items-center gap-2 text-[18px] font-bold tracking-tight"
              style={{
                color: "var(--color-page-text)",
                fontFamily: "var(--font-display)",
              }}
            >
              <img src="/lobster-icon.svg" alt="Lobu" class="w-7 h-7" />
              Lobu
            </a>
            <p
              class="mt-4 text-[13px] leading-relaxed max-w-xs"
              style={{ color: "var(--color-page-text-muted)" }}
            >
              Open-source backend for multi-user AI agents. Self-hostable,
              isolated, and source-backed.
            </p>
          </div>
          {COLUMNS.map((col) => (
            <div key={col.heading}>
              <div
                class="text-[11px] font-semibold tracking-[0.12em] uppercase mb-4"
                style={{ color: "var(--color-page-text-muted)" }}
              >
                {col.heading}
              </div>
              <ul class="flex flex-col gap-2.5">
                {col.links.map((link) => (
                  <li key={link.label}>
                    <a
                      href={link.href}
                      target={link.external ? "_blank" : undefined}
                      rel={link.external ? "noopener noreferrer" : undefined}
                      class="text-[14px] transition-opacity hover:opacity-80"
                      style={{ color: "var(--color-page-text)" }}
                    >
                      {link.label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div
          class="mt-16 pt-6 flex flex-col sm:flex-row items-center justify-between gap-3 text-[12px]"
          style={{
            borderTop: "1px solid var(--color-page-border)",
            color: "var(--color-page-text-muted)",
          }}
        >
          <div>© {new Date().getFullYear()} Lobu. All rights reserved.</div>
          <div class="flex items-center gap-4">
            <a
              href="/privacy"
              class="hover:opacity-80"
              style={{ color: "var(--color-page-text-muted)" }}
            >
              Privacy
            </a>
            <a
              href="/terms"
              class="hover:opacity-80"
              style={{ color: "var(--color-page-text-muted)" }}
            >
              Terms
            </a>
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noopener noreferrer"
              class="hover:opacity-80"
              style={{ color: "var(--color-page-text-muted)" }}
            >
              GitHub
            </a>
          </div>
        </div>
      </div>
    </footer>
  );
}

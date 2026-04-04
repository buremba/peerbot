const GITHUB_URL = "https://github.com/lobu-ai/lobu";
const GITHUB_STARS_BADGE =
  "https://img.shields.io/github/stars/lobu-ai/lobu?style=social";

const leftLinks = [
  { label: "Memory", href: "/memory" },
  { label: "Skills", href: "/skills" },
];

const rightLinks = [
  { label: "Docs", href: "/getting-started" },
  { label: "API", href: "/reference/api-reference" },
  { label: "Blog", href: "/blog" },
];

function isActiveLink(currentPath: string, href: string): boolean {
  if (href === "/") return currentPath === "/";
  if (currentPath === href) return true;
  return currentPath.startsWith(`${href}/`);
}

type NavProps = {
  currentPath?: string;
};

export function Nav({ currentPath = "/" }: NavProps) {
  return (
    <nav
      class="fixed top-0 left-0 right-0 z-50 px-4 sm:px-8 py-3"
      style={{
        backgroundColor: "var(--color-page-bg-overlay)",
        backdropFilter: "blur(12px)",
        borderBottom: "1px solid var(--color-page-border)",
      }}
    >
      <div class="max-w-[60rem] mx-auto flex items-center gap-3 min-w-0">
        <a
          href="/"
          class="flex items-center gap-2 text-lg font-bold tracking-tight sm:mr-8 shrink-0"
          style={{ color: "var(--color-page-text)" }}
        >
          <img src="/lobster-icon.png" alt="Lobu" class="w-7 h-7" />
          Lobu
        </a>
        <div class="hidden md:flex items-center gap-6 mr-auto min-w-0">
          {leftLinks.map((link) => {
            const isActive = isActiveLink(currentPath, link.href);
            return (
              <a
                key={link.label}
                href={link.href}
                class="text-sm transition-opacity hover:opacity-80"
                style={{
                  color: isActive
                    ? "var(--color-page-text)"
                    : "var(--color-page-text-muted)",
                  fontWeight: isActive ? 600 : 400,
                }}
                aria-current={isActive ? "page" : undefined}
              >
                {link.label}
              </a>
            );
          })}
        </div>
        <div class="hidden sm:flex items-center gap-6 ml-auto">
          {rightLinks.map((link) => {
            const isActive = isActiveLink(currentPath, link.href);
            return (
              <a
                key={link.label}
                href={link.href}
                class="text-sm transition-opacity hover:opacity-80"
                style={{
                  color: isActive
                    ? "var(--color-page-text)"
                    : "var(--color-page-text-muted)",
                  fontWeight: isActive ? 600 : 400,
                }}
                aria-current={isActive ? "page" : undefined}
              >
                {link.label}
              </a>
            );
          })}
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            class="inline-flex items-center gap-2 transition-opacity hover:opacity-80"
          >
            <img src={GITHUB_STARS_BADGE} alt="GitHub stars" height="20" />
          </a>
        </div>
        <div class="sm:hidden ml-auto flex items-center gap-3 shrink-0">
          <a
            href="/getting-started"
            class="text-sm transition-opacity hover:opacity-80"
            style={{
              color: isActiveLink(currentPath, "/getting-started")
                ? "var(--color-page-text)"
                : "var(--color-page-text-muted)",
              fontWeight: isActiveLink(currentPath, "/getting-started")
                ? 600
                : 400,
            }}
            aria-current={
              isActiveLink(currentPath, "/getting-started") ? "page" : undefined
            }
          >
            Docs
          </a>
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            class="text-sm transition-opacity hover:opacity-80"
            style={{ color: "var(--color-page-text-muted)" }}
          >
            GitHub
          </a>
        </div>
      </div>
    </nav>
  );
}

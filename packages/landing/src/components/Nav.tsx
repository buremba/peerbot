const GITHUB_URL = "https://github.com/lobu-ai/lobu";
const GITHUB_STARS_BADGE =
  "https://img.shields.io/github/stars/lobu-ai/lobu?style=social";

function getUseCaseFromPath(path: string): string | undefined {
  const match = path.match(/\/for\/([^/]+)/);
  return match?.[1];
}

function getLeftLinks(currentPath: string) {
  const useCaseId = getUseCaseFromPath(currentPath);
  return [
    {
      label: "Memory",
      href: useCaseId ? `/memory/for/${useCaseId}` : "/memory",
    },
    {
      label: "Skills",
      href: useCaseId ? `/skills/for/${useCaseId}` : "/skills",
    },
    { label: "Pricing", href: "/pricing" },
  ];
}

const rightLinks = [
  { label: "Docs", href: "/getting-started" },
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
  const leftLinks = getLeftLinks(currentPath);

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

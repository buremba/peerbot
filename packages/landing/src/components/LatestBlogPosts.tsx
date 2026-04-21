import { ContentRail } from "./ContentRail";

export type LatestBlogPost = {
  id: string;
  title: string;
  description: string;
  dateLabel: string;
  href: string;
  tag?: string;
};

export function LatestBlogPosts({ posts }: { posts: LatestBlogPost[] }) {
  if (!posts.length) return null;

  return (
    <ContentRail variant="compact">
      <div class="flex flex-col items-center text-center mb-8 mt-12">
        <div
          class="text-xs uppercase tracking-[0.22em] mb-3"
          style={{ color: "var(--color-tg-accent)" }}
        >
          From the blog
        </div>
        <h2
          class="text-3xl sm:text-4xl tracking-[-0.03em]"
          style={{ color: "var(--color-page-text)" }}
        >
          Latest blog posts
        </h2>
      </div>

      <div class="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {posts.map((post) => (
          <a
            key={post.id}
            href={post.href}
            class="rounded-[1.5rem] p-5 border transition-transform hover:-translate-y-0.5"
            style={{
              background:
                "linear-gradient(180deg, rgba(21,24,29,0.92) 0%, rgba(13,16,20,0.82) 100%)",
              borderColor: "rgba(62, 77, 97, 0.55)",
            }}
          >
            <div class="flex items-center justify-between gap-3 mb-5">
              {post.tag ? (
                <span
                  class="text-[10px] font-medium px-2 py-0.5 rounded-full"
                  style={{
                    backgroundColor: "var(--color-page-surface-dim)",
                    color: "var(--color-page-text-muted)",
                    border: "1px solid var(--color-page-border)",
                  }}
                >
                  {post.tag}
                </span>
              ) : null}
              <span
                class="text-sm"
                style={{ color: "var(--color-page-text-muted)" }}
              >
                {post.dateLabel}
              </span>
            </div>

            <h3
              class="text-xl font-semibold leading-tight mb-3"
              style={{ color: "var(--color-page-text)" }}
            >
              {post.title}
            </h3>
            <p
              class="text-sm leading-6 m-0 mb-5"
              style={{ color: "var(--color-page-text-muted)" }}
            >
              {post.description}
            </p>
            <div
              class="text-sm font-medium"
              style={{ color: "var(--color-tg-accent)" }}
            >
              Read post →
            </div>
          </a>
        ))}
      </div>
    </ContentRail>
  );
}

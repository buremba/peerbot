import { getCollection } from "astro:content";
import type { LatestBlogPost } from "./components/LatestBlogPosts";

export async function getLatestPosts(count = 3): Promise<LatestBlogPost[]> {
  const isProduction = import.meta.env.PROD;
  return (
    await getCollection("blog", ({ data }) =>
      isProduction ? !data.draft : true
    )
  )
    .sort((a, b) => b.data.date.valueOf() - a.data.date.valueOf())
    .slice(0, count)
    .map((post) => ({
      id: post.id,
      title: post.data.title,
      description: post.data.description,
      dateLabel: post.data.date.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        timeZone: "America/Los_Angeles",
      }),
      href: `/blog/${post.id}`,
      tag: post.data.tags?.[0],
    }));
}

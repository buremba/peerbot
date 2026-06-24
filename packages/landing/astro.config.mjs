import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import preact from "@astrojs/preact";
import sitemap from "@astrojs/sitemap";
import starlight from "@astrojs/starlight";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
// Force Zod v3 for Astro action runtime compatibility.
// Resolve zod from Astro's own dependency tree so we always pick up the
// v3 copy that Astro/Starlight were built against, even when a newer zod
// (e.g. v4) is hoisted higher in the workspace.
const astroRequire = createRequire(require.resolve("astro/package.json"));
const zodPath = dirname(astroRequire.resolve("zod/package.json"));

const settingsDir = resolve(
  __dirname,
  "../gateway/src/routes/public/settings-page"
);
const mockApi = resolve(__dirname, "src/settings-mock/mock-api.ts");
const mockContext = resolve(__dirname, "src/settings-mock/mock-context.tsx");

function settingsMockPlugin() {
  return {
    name: "settings-mock",
    enforce: "pre",
    resolveId(source, importer) {
      if (!importer?.includes("settings-page")) return null;
      const resolved = resolve(dirname(importer), source);
      if (resolved === resolve(settingsDir, "api")) return mockApi;
      if (resolved === resolve(settingsDir, "app")) return mockContext;
      return null;
    },
  };
}

export default defineConfig({
  site: "https://lobu.ai",
  redirects: {
    "/pricing": "/serverless-openclaw",
    // SDK docs consolidated under /sdks/ — keep old URLs working.
    "/getting-started/connector-sdk": "/sdks/connectors",
    "/reference/connector-sdk": "/sdks/connectors-reference",
    "/getting-started/reaction-sdk": "/sdks/reactions",
    "/reference/reaction-sdk": "/sdks/reactions",
    "/platforms/rest-api": "/sdks/rest-api",
    "/guides/evals": "/sdks/evals",
  },
  integrations: [
    starlight({
      title: "Lobu Docs",
      customCss: [
        "./src/styles/starlight-shared.css",
        "./src/styles/starlight-theme.css",
      ],
      expressiveCode: {
        themes: ["github-light", "github-dark"],
      },
      components: {
        Head: "./src/components/starlight/Head.astro",
        SiteTitle: "./src/components/starlight/SiteTitle.astro",
        Header: "./src/components/starlight/Header.astro",
        Footer: "./src/components/starlight/Footer.astro",
      },
      sidebar: [
        {
          label: "Getting Started",
          items: [
            { label: "Getting Started", link: "/getting-started/" },
            { label: "Comparison", link: "/getting-started/comparison/" },
            { label: "Skills", link: "/getting-started/skills/" },
            { label: "Memory", link: "/getting-started/memory/" },
          ],
        },
        {
          label: "SDKs",
          items: [
            { label: "Overview", link: "/sdks/" },
            { label: "Client", link: "/sdks/client/" },
            { label: "REST API", link: "/sdks/rest-api/" },
            { label: "Connectors", link: "/sdks/connectors/" },
            {
              label: "Connectors reference",
              link: "/sdks/connectors-reference/",
            },
            { label: "Reactions", link: "/sdks/reactions/" },
            { label: "Memory plugin", link: "/sdks/memory-plugin/" },
            { label: "Evals", link: "/sdks/evals/" },
          ],
        },
        { label: "Deployment", autogenerate: { directory: "deployment" } },
        {
          label: "Platforms",
          items: [
            { label: "Slack", link: "/platforms/slack/" },
            { label: "Discord", link: "/platforms/discord/" },
            { label: "Microsoft Teams", link: "/platforms/teams/" },
            { label: "Google Chat", link: "/platforms/google-chat/" },
            { label: "Web App", link: "/platforms/web/" },
            { label: "WhatsApp", link: "/platforms/whatsapp/" },
          ],
        },
        {
          label: "Connect From",
          items: [
            { label: "ChatGPT", link: "/connect-from/chatgpt/" },
            { label: "Claude", link: "/connect-from/claude/" },
            { label: "OpenClaw", link: "/connect-from/openclaw/" },
          ],
        },
        { label: "Guides", autogenerate: { directory: "guides" } },
        {
          label: "Reference",
          items: [
            { label: "lobu.config.ts", link: "/reference/lobu-config/" },
            { label: "SKILL.md", link: "/reference/skill-md/" },
            { label: "Providers", link: "/reference/providers/" },
            { label: "CLI", link: "/reference/cli/" },
            { label: "lobu apply", link: "/reference/lobu-apply/" },
            { label: "Lobu memory CLI", link: "/reference/lobu-memory/" },
            { label: "REST API", link: "/reference/api-reference/" },
          ],
        },
      ],
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/lobu-ai/lobu",
        },
      ],
      disable404Route: true,
    }),
    preact({ compat: true }),
    sitemap(),
  ],
  vite: {
    // Read .env from the repo root so PUBLIC_POSTHOG_KEY (and any other
    // workspace-wide env we add later) reaches the build / dev server.
    // Without this, Vite scopes envDir to this package and the repo-root
    // .env is invisible — PosthogAnalytics then silently no-ops because
    // posthogKey is undefined.
    envDir: resolve(__dirname, "../.."),
    plugins: [settingsMockPlugin(), tailwindcss()],
    resolve: {
      alias: {
        "@settings": settingsDir,
        "@providers-config": resolve(__dirname, "../../config/providers.json"),
        "@platform-configs": resolve(
          __dirname,
          "src/generated/platform-configs.json"
        ),
        zod: zodPath,
      },
    },
  },
});

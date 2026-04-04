const memoryPillars = [
  {
    title: "Multi-tenant memory",
    body: "Owletto scopes memory by workspace, so entities, synced data, connections, and analysis stay inside the right team boundary.",
  },
  {
    title: "Typed entity graph",
    body: "Memory is organized as types, entities, relationships, connectors, and watchers instead of a pile of chat summaries.",
  },
  {
    title: "Managed integrations",
    body: "Connectors sync external systems into the same graph while OAuth, refresh, and scope upgrades stay out of workers.",
  },
];

const recallSignals = [
  "Entity name matching for known customers, products, or topics",
  "Full-text retrieval across saved facts, decisions, and observations",
  "Semantic vector search for concept-level recall",
];

const connectorModes = [
  {
    label: "OAuth",
    text: "Connectors declare scopes. Owletto handles login, encrypted storage, refresh, and scope upgrades.",
  },
  {
    label: "API keys",
    text: "Some connectors use saved or environment-backed credentials without exposing raw values to workers.",
  },
  {
    label: "Browser session",
    text: "Owletto can persist browser-backed auth, launch a browser, or connect to one over CDP.",
  },
];

const whyItFitsLobu = [
  "Workers get memory and integrations without receiving third-party OAuth tokens.",
  "The gateway proxies tool calls while Owletto keeps auth and connector state scoped to the right organization.",
  "The OpenClaw memory slot can recall durable facts before each run instead of leaning on recent chat history.",
];

const faqItems = [
  {
    q: "How is this different from filesystem-based memory?",
    a: "Filesystem memory lives on one machine, serves one user, and goes stale when nobody updates it. Owletto scopes memory by workspace so agents and teammates share the same graph. Connectors sync external data and watchers keep it fresh.",
  },
  {
    q: "How is this different from RAG or a vector database?",
    a: "RAG usually returns similar text chunks. Owletto stores typed entities, relationships, and content, then combines entity matching, full-text search, and semantic search so agents find the right context even when wording changes.",
  },
  {
    q: "How is this different from chat history?",
    a: "Chat history is per-conversation and temporary. Owletto turns conversations and external sources into durable knowledge that any agent in the workspace can recall later.",
  },
  {
    q: "Is memory shared across agents?",
    a: "Yes. Agents in the same workspace read from and write to the same graph. A support agent can save context that a sales agent recalls later, while organizations stay isolated.",
  },
  {
    q: "Can I use a different memory system?",
    a: "Yes. Owletto is the default, but workers use MCP tools, so you can point them at another memory server with the same interface.",
  },
];

function SectionDivider() {
  return <div class="section-divider" />;
}

function GitHubIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M12 .5C5.65.5.5 5.65.5 12A11.5 11.5 0 0 0 8.36 22.1c.58.1.79-.25.79-.56v-1.95c-3.18.69-3.85-1.35-3.85-1.35-.52-1.31-1.27-1.66-1.27-1.66-1.04-.71.08-.7.08-.7 1.15.08 1.75 1.18 1.75 1.18 1.02 1.76 2.68 1.25 3.34.96.1-.74.4-1.25.72-1.54-2.54-.29-5.2-1.27-5.2-5.64 0-1.25.45-2.28 1.18-3.08-.12-.29-.51-1.47.11-3.06 0 0 .96-.31 3.15 1.18a10.9 10.9 0 0 1 5.74 0c2.18-1.49 3.14-1.18 3.14-1.18.62 1.59.23 2.77.11 3.06.74.8 1.18 1.83 1.18 3.08 0 4.38-2.67 5.35-5.22 5.63.41.36.77 1.08.77 2.18v3.24c0 .31.21.66.8.55A11.5 11.5 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z" />
    </svg>
  );
}

function Card(props: { title: string; body: string }) {
  return (
    <div
      class="rounded-2xl p-5 border"
      style={{
        background:
          "linear-gradient(180deg, rgba(21,24,29,0.92) 0%, rgba(13,16,20,0.82) 100%)",
        borderColor: "rgba(62, 77, 97, 0.55)",
        boxShadow: "0 20px 60px rgba(0, 0, 0, 0.28)",
      }}
    >
      <h3
        class="text-lg font-semibold mb-2"
        style={{ color: "var(--color-page-text)" }}
      >
        {props.title}
      </h3>
      <p
        class="text-sm leading-6 m-0"
        style={{ color: "var(--color-page-text-muted)" }}
      >
        {props.body}
      </p>
    </div>
  );
}

function DiagramPanel() {
  return (
    <div
      class="rounded-[2rem] overflow-hidden border p-5 sm:p-6"
      style={{
        borderColor: "rgba(62, 77, 97, 0.55)",
        boxShadow: "0 20px 60px rgba(0, 0, 0, 0.34)",
      }}
    >
      <div class="grid gap-4">
        <div class="flex justify-center">
          <div
            class="rounded-2xl px-5 py-4 border min-w-[14rem] text-center"
            style={{
              borderColor: "rgba(248, 184, 78, 0.3)",
              backgroundColor: "rgba(248, 184, 78, 0.08)",
            }}
          >
            <div
              class="text-[11px] uppercase tracking-[0.18em] mb-1"
              style={{ color: "#f8b84e" }}
            >
              Workspace
            </div>
            <div
              class="text-base font-semibold"
              style={{ color: "var(--color-page-text)" }}
            >
              Organization
            </div>
          </div>
        </div>

        <div
          class="flex justify-center"
          style={{ color: "rgba(255,255,255,0.3)" }}
        >
          ↓
        </div>

        <div class="grid sm:grid-cols-3 gap-3">
          <div
            class="rounded-2xl p-4 border"
            style={{
              borderColor: "rgba(103, 232, 249, 0.2)",
              backgroundColor: "rgba(103, 232, 249, 0.06)",
            }}
          >
            <div
              class="text-xs uppercase tracking-[0.18em] mb-2"
              style={{ color: "#67e8f9" }}
            >
              Model
            </div>
            <div
              class="text-sm font-semibold mb-2"
              style={{ color: "var(--color-page-text)" }}
            >
              Entity types
            </div>
            <div
              class="text-sm leading-6"
              style={{ color: "var(--color-page-text-muted)" }}
            >
              customer
              <br />
              product
              <br />
              campaign
            </div>
          </div>

          <div
            class="rounded-2xl p-4 border"
            style={{
              borderColor: "rgba(134, 239, 172, 0.2)",
              backgroundColor: "rgba(134, 239, 172, 0.06)",
            }}
          >
            <div
              class="text-xs uppercase tracking-[0.18em] mb-2"
              style={{ color: "#86efac" }}
            >
              Record
            </div>
            <div
              class="text-sm font-semibold mb-2"
              style={{ color: "var(--color-page-text)" }}
            >
              Entities
            </div>
            <div
              class="text-sm leading-6"
              style={{ color: "var(--color-page-text-muted)" }}
            >
              Acme Corp
              <br />
              Widget v2
              <br />
              Launch Q3
            </div>
          </div>

          <div
            class="rounded-2xl p-4 border"
            style={{
              borderColor: "rgba(251, 113, 133, 0.2)",
              backgroundColor: "rgba(251, 113, 133, 0.06)",
            }}
          >
            <div
              class="text-xs uppercase tracking-[0.18em] mb-2"
              style={{ color: "#fb7185" }}
            >
              Log
            </div>
            <div
              class="text-sm font-semibold mb-2"
              style={{ color: "var(--color-page-text)" }}
            >
              Content
            </div>
            <div
              class="text-sm leading-6"
              style={{ color: "var(--color-page-text-muted)" }}
            >
              decisions
              <br />
              preferences
              <br />
              observations
            </div>
          </div>
        </div>

        <div class="grid sm:grid-cols-2 gap-3">
          <div
            class="rounded-2xl p-4 border"
            style={{
              borderColor: "rgba(192, 132, 252, 0.2)",
              backgroundColor: "rgba(192, 132, 252, 0.06)",
            }}
          >
            <div class="flex flex-col items-start gap-1 mb-2">
              <div
                class="text-[11px] uppercase tracking-[0.18em]"
                style={{ color: "#c084fc" }}
              >
                live data
              </div>
              <div
                class="text-sm font-semibold"
                style={{ color: "var(--color-page-text)" }}
              >
                Connectors
              </div>
            </div>
            <div
              class="text-sm leading-6"
              style={{ color: "var(--color-page-text-muted)" }}
            >
              GitHub, Google, RSS, app stores, review platforms
            </div>
          </div>

          <div
            class="rounded-2xl p-4 border"
            style={{
              borderColor: "rgba(96, 165, 250, 0.2)",
              backgroundColor: "rgba(96, 165, 250, 0.06)",
            }}
          >
            <div class="flex flex-col items-start gap-1 mb-2">
              <div
                class="text-[11px] uppercase tracking-[0.18em]"
                style={{ color: "#60a5fa" }}
              >
                live prompts
              </div>
              <div
                class="text-sm font-semibold"
                style={{ color: "var(--color-page-text)" }}
              >
                Watchers
              </div>
            </div>
            <div
              class="text-sm leading-6"
              style={{ color: "var(--color-page-text-muted)" }}
            >
              Extract data, track changes, and keep it linked to evidence
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function MemorySection() {
  return (
    <section class="pt-32 pb-24 px-4 sm:px-8">
      <div class="max-w-[58rem] mx-auto">
        <div class="grid gap-12 lg:grid-cols-[1.05fr_0.95fr] items-start">
          <div>
            <h1
              class="text-4xl sm:text-5xl font-bold tracking-tight leading-[1.1] mt-5 mb-5"
              style={{ color: "var(--color-page-text)" }}
            >
              Multi-tenant organizational memory for agents
            </h1>
            <p
              class="text-lg sm:text-xl leading-8 max-w-[40rem] m-0"
              style={{ color: "var(--color-page-text-muted)" }}
            >
              Owletto is Lobu&apos;s default memory system. It gives agents a
              typed graph, live connectors, scheduled analysis, and managed
              OAuth instead of a vector dump or short-lived chat history.
            </p>
            <div class="flex flex-wrap gap-3 mt-8">
              <a
                href="https://owletto.com"
                target="_blank"
                rel="noopener noreferrer"
                class="inline-flex items-center rounded-xl px-4 py-2.5 text-sm font-medium border transition-transform hover:-translate-y-0.5"
                style={{
                  color: "var(--color-page-text)",
                  backgroundColor: "rgba(255,255,255,0.04)",
                  borderColor: "var(--color-page-border-active)",
                }}
              >
                See live
              </a>
              <a
                href="https://github.com/lobu-ai/owletto"
                target="_blank"
                rel="noopener noreferrer"
                class="inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium"
                style={{ color: "var(--color-page-text-muted)" }}
              >
                <GitHubIcon />
                See GitHub
              </a>
            </div>
          </div>
          <DiagramPanel />
        </div>

        <SectionDivider />

        <div class="grid gap-4 md:grid-cols-3">
          {memoryPillars.map((pillar) => (
            <Card key={pillar.title} title={pillar.title} body={pillar.body} />
          ))}
        </div>

        <SectionDivider />

        <div class="max-w-[48rem] mx-auto">
          <div class="flex flex-col items-center text-center mb-8">
            <div
              class="text-xs uppercase tracking-[0.22em] mb-3"
              style={{ color: "#f8b84e" }}
            >
              How it works
            </div>
            <h2
              class="text-3xl sm:text-4xl tracking-[-0.03em]"
              style={{ color: "var(--color-page-text)" }}
            >
              A simple graph, kept fresh
            </h2>
          </div>
          <div
            class="rounded-[2rem] p-5 sm:p-6 border"
            style={{
              background:
                "linear-gradient(180deg, rgba(21,24,29,0.92) 0%, rgba(13,16,20,0.82) 100%)",
              borderColor: "rgba(62, 77, 97, 0.55)",
              boxShadow: "0 20px 60px rgba(0, 0, 0, 0.28)",
            }}
          >
            <div class="relative">
              <div
                class="absolute left-4 top-2 bottom-2 w-px"
                style={{
                  background:
                    "linear-gradient(180deg, rgba(248,184,78,0.45), rgba(103,232,249,0.35) 52%, rgba(134,239,172,0.35))",
                }}
              />

              <div class="relative flex items-start gap-4 pb-6">
                <div
                  class="relative z-[1] w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold shrink-0"
                  style={{
                    color: "rgb(8, 10, 14)",
                    backgroundColor: "#f8b84e",
                    boxShadow: "0 0 0 6px rgba(13,16,20,0.92)",
                  }}
                >
                  1
                </div>
                <div class="pt-0.5">
                  <div
                    class="text-[11px] uppercase tracking-[0.18em] mb-1"
                    style={{ color: "#f8b84e" }}
                  >
                    Model the workspace
                  </div>
                  <h3
                    class="text-lg font-semibold mb-2 mt-0"
                    style={{ color: "var(--color-page-text)" }}
                  >
                    Define entity types
                  </h3>
                  <p
                    class="text-sm leading-6 m-0"
                    style={{ color: "var(--color-page-text-muted)" }}
                  >
                    Users define core workspace objects such as customers,
                    products, competitors, or campaigns. JSON Schema gives each
                    type structure so agents save typed memory instead of loose
                    text.
                  </p>
                </div>
              </div>

              <div class="relative flex items-start gap-4 py-6">
                <div
                  class="relative z-[1] w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold shrink-0"
                  style={{
                    color: "rgb(8, 10, 14)",
                    backgroundColor: "#67e8f9",
                    boxShadow: "0 0 0 6px rgba(13,16,20,0.92)",
                  }}
                >
                  2
                </div>
                <div class="pt-0.5">
                  <div
                    class="text-[11px] uppercase tracking-[0.18em] mb-1"
                    style={{ color: "#67e8f9" }}
                  >
                    Bring in fresh context
                  </div>
                  <h3
                    class="text-lg font-semibold mb-2 mt-0"
                    style={{ color: "var(--color-page-text)" }}
                  >
                    Connect external data
                  </h3>
                  <p
                    class="text-sm leading-6 m-0"
                    style={{ color: "var(--color-page-text-muted)" }}
                  >
                    Users add connectors for GitHub, Google, RSS, review sites,
                    or internal sources. Owletto syncs those feeds into the same
                    graph so memory stays current instead of relying only on
                    what the agent was told.
                  </p>
                </div>
              </div>

              <div class="relative flex items-start gap-4 pt-6">
                <div
                  class="relative z-[1] w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold shrink-0"
                  style={{
                    color: "rgb(8, 10, 14)",
                    backgroundColor: "#86efac",
                    boxShadow: "0 0 0 6px rgba(13,16,20,0.92)",
                  }}
                >
                  3
                </div>
                <div class="pt-0.5">
                  <div
                    class="text-[11px] uppercase tracking-[0.18em] mb-1"
                    style={{ color: "#86efac" }}
                  >
                    Turn data into memory
                  </div>
                  <h3
                    class="text-lg font-semibold mb-2 mt-0"
                    style={{ color: "var(--color-page-text)" }}
                  >
                    Create watchers and live prompts
                  </h3>
                  <p
                    class="text-sm leading-6 m-0"
                    style={{ color: "var(--color-page-text-muted)" }}
                  >
                    Users create watchers that run scheduled prompts and
                    extraction over fresh data. Incoming events become
                    summaries, classifications, and durable knowledge the agent
                    can recall later.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>

        <SectionDivider />

        <div class="grid gap-8 lg:grid-cols-[1fr_0.95fr] items-start">
          <div
            class="rounded-3xl p-6 sm:p-8 border"
            style={{
              background:
                "radial-gradient(circle at top left, rgba(56, 189, 248, 0.12), transparent 36%), linear-gradient(180deg, rgba(16, 18, 24, 0.94), rgba(11, 13, 17, 0.88))",
              borderColor: "rgba(62, 77, 97, 0.55)",
            }}
          >
            <div
              class="text-xs uppercase tracking-[0.22em] mb-3"
              style={{ color: "#67e8f9" }}
            >
              Recall
            </div>
            <h2
              class="text-3xl tracking-[-0.03em] mt-0 mb-4"
              style={{ color: "var(--color-page-text)" }}
            >
              Recall stays grounded
            </h2>
            <p
              class="text-base leading-7 mb-6"
              style={{ color: "var(--color-page-text-muted)" }}
            >
              Owletto blends entity matching, text retrieval, and semantic
              search so agents can find the right context even when wording
              changes.
            </p>
            <div class="grid gap-3">
              {recallSignals.map((signal, index) => (
                <div
                  key={signal}
                  class="rounded-2xl p-4 border flex items-start gap-4"
                  style={{
                    borderColor: "rgba(103, 232, 249, 0.14)",
                    backgroundColor: "rgba(10, 13, 18, 0.52)",
                  }}
                >
                  <div
                    class="w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold shrink-0"
                    style={{
                      color: "rgb(8, 10, 14)",
                      backgroundColor: "rgb(103, 232, 249)",
                    }}
                  >
                    {index + 1}
                  </div>
                  <div
                    class="text-sm leading-6"
                    style={{ color: "var(--color-page-text-muted)" }}
                  >
                    {signal}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div
            class="rounded-3xl p-6 sm:p-8 border"
            style={{
              background:
                "radial-gradient(circle at top right, rgba(244, 114, 182, 0.14), transparent 34%), linear-gradient(180deg, rgba(19, 16, 22, 0.94), rgba(13, 11, 16, 0.9))",
              borderColor: "rgba(62, 77, 97, 0.55)",
            }}
          >
            <div
              class="text-xs uppercase tracking-[0.22em] mb-3"
              style={{ color: "#fb7185" }}
            >
              Connectors + auth
            </div>
            <h2
              class="text-3xl tracking-[-0.03em] mt-0 mb-4"
              style={{ color: "var(--color-page-text)" }}
            >
              Live systems feed the same graph
            </h2>
            <div class="grid gap-3">
              {connectorModes.map((mode) => (
                <div
                  key={mode.label}
                  class="rounded-2xl p-4 border"
                  style={{
                    borderColor: "rgba(251, 113, 133, 0.14)",
                    backgroundColor: "rgba(18, 12, 16, 0.45)",
                  }}
                >
                  <div
                    class="text-sm font-semibold mb-1"
                    style={{ color: "var(--color-page-text)" }}
                  >
                    {mode.label}
                  </div>
                  <div
                    class="text-sm leading-6"
                    style={{ color: "var(--color-page-text-muted)" }}
                  >
                    {mode.text}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <SectionDivider />

        <div class="grid gap-8 lg:grid-cols-[1fr_1fr] items-start">
          <div>
            <div
              class="text-xs uppercase tracking-[0.22em] mb-3"
              style={{ color: "#86efac" }}
            >
              Watchers
            </div>
            <h2
              class="text-3xl sm:text-4xl tracking-[-0.03em] mt-0 mb-4"
              style={{ color: "var(--color-page-text)" }}
            >
              Scheduled analysis keeps memory current
            </h2>
            <p
              class="text-base leading-7 m-0"
              style={{ color: "var(--color-page-text-muted)" }}
            >
              Watchers run on schedule, analyze bounded windows of workspace
              data, extract structured output, and keep conclusions linked to
              evidence. Memory keeps moving even when nobody is chatting.
            </p>
          </div>

          <div>
            <div
              class="text-xs uppercase tracking-[0.22em] mb-4"
              style={{ color: "#86efac" }}
            >
              Why it fits Lobu
            </div>
            <div class="grid gap-3">
              {whyItFitsLobu.map((item) => (
                <div
                  key={item}
                  class="rounded-2xl p-4 border flex items-start gap-3"
                  style={{
                    backgroundColor: "rgba(255,255,255,0.03)",
                    borderColor: "rgba(62, 77, 97, 0.42)",
                  }}
                >
                  <div
                    class="w-2.5 h-2.5 rounded-full mt-2 shrink-0"
                    style={{ backgroundColor: "#86efac" }}
                  />
                  <div
                    class="text-sm leading-6"
                    style={{ color: "var(--color-page-text-muted)" }}
                  >
                    {item}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <SectionDivider />

        <div>
          <div class="flex flex-col items-center text-center mb-8">
            <div
              class="text-xs uppercase tracking-[0.22em] mb-3"
              style={{ color: "#c084fc" }}
            >
              FAQ
            </div>
            <h2
              class="text-3xl sm:text-4xl tracking-[-0.03em]"
              style={{ color: "var(--color-page-text)" }}
            >
              Common questions
            </h2>
          </div>
          <div class="max-w-[48rem] mx-auto grid gap-4">
            {faqItems.map((item) => (
              <div
                key={item.q}
                class="rounded-2xl p-5 border"
                style={{
                  background:
                    "linear-gradient(180deg, rgba(21,24,29,0.92) 0%, rgba(13,16,20,0.82) 100%)",
                  borderColor: "rgba(62, 77, 97, 0.55)",
                }}
              >
                <h3
                  class="text-base font-semibold mb-2 mt-0"
                  style={{ color: "var(--color-page-text)" }}
                >
                  {item.q}
                </h3>
                <p
                  class="text-sm leading-6 m-0"
                  style={{ color: "var(--color-page-text-muted)" }}
                >
                  {item.a}
                </p>
              </div>
            ))}
          </div>
        </div>

        <SectionDivider />

        <div
          class="rounded-[2rem] p-7 sm:p-10 border"
          style={{
            background:
              "linear-gradient(135deg, rgba(245, 158, 11, 0.12), rgba(14, 14, 18, 0.92) 36%, rgba(56, 189, 248, 0.12))",
            borderColor: "rgba(82, 99, 124, 0.56)",
          }}
        >
          <div class="grid gap-6 lg:grid-cols-[1fr_auto] items-center">
            <div>
              <h2
                class="text-3xl sm:text-4xl tracking-[-0.03em] mt-0 mb-3"
                style={{ color: "var(--color-page-text)" }}
              >
                Shared memory across your organization
              </h2>
              <p
                class="text-base leading-7 m-0 max-w-[42rem]"
                style={{ color: "var(--color-page-text-muted)" }}
              >
                Lobu&apos;s memory story is not &quot;we store embeddings
                somewhere&quot;. It is a scoped system for organizational
                knowledge, connectors, and auth, and Owletto is the layer that
                makes it work.
              </p>
            </div>
            <div class="flex flex-wrap gap-3">
              <a
                href="https://github.com/lobu-ai/owletto"
                target="_blank"
                rel="noopener noreferrer"
                class="inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium border"
                style={{
                  color: "var(--color-page-text)",
                  backgroundColor: "rgba(255,255,255,0.05)",
                  borderColor: "var(--color-page-border-active)",
                }}
              >
                <GitHubIcon />
                Owletto on GitHub
              </a>
              <a
                href="/getting-started/"
                class="inline-flex items-center rounded-xl px-4 py-2.5 text-sm font-medium"
                style={{ color: "var(--color-page-text-muted)" }}
              >
                Getting started →
              </a>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/**
 * Build-time generator for `config/models-dev-snapshot.json` — the per-provider
 * model catalog, joined from models.dev (MIT, https://models.dev/api.json).
 *
 * Why a committed snapshot instead of a runtime fetch: model metadata should
 * work offline, in air-gapped deployments, and on a cold boot with no egress.
 * The gateway already treats `config/providers.json` as a bundled artifact;
 * the snapshot ships beside it.
 *
 * The join key is `modelsDevId` on each `config/providers.json` provider entry.
 * Lobu provider ids are LOAD-BEARING in the request path (proxy routing, OAuth
 * config lookup, stored `kind`), so they are never renamed to match models.dev.
 * models.dev is a DATA SOURCE only, never a source of identity — hence the
 * explicit mapping field rather than an id convention.
 *
 * The mapping is MANY-TO-ONE by design: Lobu's `chatgpt` (subscription product)
 * and `openai` (API-key provider) both resolve to the models.dev `openai` entry.
 *
 * A provider entry may opt out with `modelsDevExempt: true` when models.dev
 * does not catalog its upstream. `scripts/check-models-dev-coverage.ts` guards
 * that the omission is deliberate.
 *
 * Run: `bun run scripts/gen-models-dev-snapshot.ts`
 * `scripts/check-models-dev-coverage.ts` guards provider mappings against the
 * committed artifact.
 */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  ModelsDevSnapshot,
  ModelsDevSnapshotModel,
  ProvidersConfigFile,
} from "@lobu/core";

const REPO_ROOT = resolve(new URL("..", import.meta.url).pathname);
const PROVIDERS_JSON = resolve(REPO_ROOT, "config/providers.json");
const OUT = resolve(REPO_ROOT, "config/models-dev-snapshot.json");

const MODELS_DEV_API = "https://models.dev/api.json";

/** The slice of the models.dev record we read. Upstream sends much more. */
interface UpstreamModel {
  id?: string;
  name?: string;
  tool_call?: boolean;
  reasoning?: boolean;
  release_date?: string;
  limit?: { context?: number; output?: number };
  cost?: { input?: number; output?: number };
}

interface UpstreamProvider {
  models?: Record<string, UpstreamModel>;
}

function projectModel(
  key: string,
  raw: UpstreamModel
): ModelsDevSnapshotModel | null {
  // `id` is the wire model name the provider actually accepts. Fall back to the
  // map key, which upstream keys by that same id. No id ⇒ unusable, so drop it.
  const id = (raw.id ?? key)?.trim();
  if (!id) return null;
  const model: ModelsDevSnapshotModel = { id, name: raw.name?.trim() || id };
  if (typeof raw.limit?.context === "number") {
    model.contextLimit = raw.limit.context;
  }
  if (typeof raw.limit?.output === "number") {
    model.outputLimit = raw.limit.output;
  }
  if (typeof raw.cost?.input === "number") model.costInput = raw.cost.input;
  if (typeof raw.cost?.output === "number") model.costOutput = raw.cost.output;
  if (typeof raw.tool_call === "boolean") model.toolCall = raw.tool_call;
  if (typeof raw.reasoning === "boolean") model.reasoning = raw.reasoning;
  if (raw.release_date) model.releaseDate = raw.release_date;
  return model;
}

/**
 * Newest first. Models with no `release_date` sort LAST (not first): an undated
 * entry is usually a legacy/alias record, and floating it above a dated flagship
 * would put the wrong model at the top of the picker. Ties break on id so the
 * committed artifact is byte-stable across regenerations.
 */
function byReleaseDateDesc(
  a: ModelsDevSnapshotModel,
  b: ModelsDevSnapshotModel
): number {
  const ad = a.releaseDate ?? "";
  const bd = b.releaseDate ?? "";
  if (ad !== bd) {
    if (!ad) return 1;
    if (!bd) return -1;
    return ad < bd ? 1 : -1;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Join the upstream catalog onto the Lobu provider ids declared in
 * providers.json. Pure (no I/O) so focused tests can drive it with fixtures.
 */
export function buildSnapshot(
  providersConfig: ProvidersConfigFile,
  upstream: Record<string, UpstreamProvider>,
  generatedAt: string
): { snapshot: ModelsDevSnapshot; unresolved: string[] } {
  const providers: Record<string, ModelsDevSnapshotModel[]> = {};
  const joinedFrom: Record<string, string> = {};
  const unresolved: string[] = [];

  for (const entry of providersConfig.providers) {
    for (const provider of entry.providers ?? []) {
      const modelsDevId = provider.modelsDevId;
      // No mapping declared ⇒ a custom/self-hosted provider models.dev does not
      // catalog. Contribute no key at all (an empty array would be
      // indistinguishable from "mapped but upstream went empty", which is the
      // case the coverage guard needs to be able to see).
      if (!modelsDevId) continue;

      const upstreamEntry = upstream[modelsDevId];
      if (!upstreamEntry?.models) {
        // A declared mapping that does NOT resolve is a hard error: it means the
        // upstream id was renamed or removed. Silently emitting an empty list
        // would strip a real provider's model metadata with no signal.
        unresolved.push(`${entry.id} -> ${modelsDevId}`);
        continue;
      }

      const models: ModelsDevSnapshotModel[] = [];
      for (const [key, raw] of Object.entries(upstreamEntry.models)) {
        const projected = projectModel(key, raw);
        if (projected) models.push(projected);
      }
      models.sort(byReleaseDateDesc);
      // Keyed by the LOBU id. Many-to-one (chatgpt + openai → openai) lands as
      // two keys sharing an equal list, which is what the catalog wants.
      providers[entry.id] = models;
      joinedFrom[entry.id] = modelsDevId;
    }
  }

  return {
    snapshot: { source: MODELS_DEV_API, generatedAt, providers, joinedFrom },
    unresolved,
  };
}

/** The committed snapshot, or null on first generation / unreadable file. */
async function readSnapshotIfPresent(): Promise<ModelsDevSnapshot | null> {
  try {
    return JSON.parse(await readFile(OUT, "utf-8")) as ModelsDevSnapshot;
  } catch {
    return null;
  }
}

/**
 * True when two snapshots carry identical model data — everything except the
 * `generatedAt` stamp. Compared on the serialized form because the generator
 * emits deterministically (providers in providers.json order, models sorted
 * newest-first with ties broken on id), so equal data always serializes byte-
 * identically.
 */
export function sameModelData(
  a: ModelsDevSnapshot,
  b: ModelsDevSnapshot
): boolean {
  const strip = (s: ModelsDevSnapshot) =>
    JSON.stringify({
      source: s.source,
      providers: s.providers,
      joinedFrom: s.joinedFrom,
    });
  return strip(a) === strip(b);
}

async function main(): Promise<void> {
  const providersConfig = JSON.parse(
    await readFile(PROVIDERS_JSON, "utf-8")
  ) as ProvidersConfigFile;

  const response = await fetch(MODELS_DEV_API);
  if (!response.ok) {
    throw new Error(
      `models.dev fetch failed: ${response.status} ${response.statusText}`
    );
  }
  const upstream = (await response.json()) as Record<string, UpstreamProvider>;

  const { snapshot, unresolved } = buildSnapshot(
    providersConfig,
    upstream,
    new Date().toISOString().slice(0, 10)
  );

  if (unresolved.length > 0) {
    throw new Error(
      "modelsDevId declared but not found upstream (renamed/removed at " +
        `models.dev?):\n  ${unresolved.join("\n  ")}\n` +
        "Fix the mapping in config/providers.json, then re-run."
    );
  }

  // Keep the PREVIOUS `generatedAt` when nothing but the date would change.
  // The scheduled refresh (.github/workflows/models-dev-snapshot.yml) opens a
  // PR whenever this file differs, so a date stamp that moves on every run
  // would open an empty churn PR every week and train reviewers to rubber-
  // stamp it — which is precisely how a bad upstream merge slips through.
  // Comparing everything EXCEPT the stamp keeps a no-change week a true no-op.
  const previous = await readSnapshotIfPresent();
  if (previous && sameModelData(previous, snapshot)) {
    snapshot.generatedAt = previous.generatedAt;
  }

  await writeFile(OUT, `${JSON.stringify(snapshot, null, 2)}\n`, "utf-8");

  const counts = Object.entries(snapshot.providers)
    .map(([id, models]) => `${id}=${models.length}`)
    .sort()
    .join(" ");
  console.log(
    `models.dev snapshot -> ${OUT}\n` +
      `  ${Object.keys(snapshot.providers).length} providers: ${counts}`
  );
}

// Only run the I/O path when invoked directly; tests may import buildSnapshot.
if (import.meta.main) {
  await main();
}

import {
  defineAgent,
  defineConfig,
  defineEntityType,
  defineWatcher,
  reactionFromFile,
  secret,
} from "@lobu/cli/config";
import type catalogStalenessCheckerReaction from "./catalog-staleness-checker.reaction.ts";

const atlasCurator = defineAgent({
  id: "atlas-curator",
  name: "atlas-curator",
  description:
    "Curate Atlas reference data — countries, cities, regions, industries, technologies, universities",
  dir: ".",
  providers: [
    {
      id: "z-ai",
      model: "z-ai/glm-4.7",
      key: secret("Z_AI_API_KEY"),
    },
  ],
  network: {
    allowed: [
      "github.com",
      ".github.com",
      ".githubusercontent.com",
      "api.z.ai",
      ".z.ai",
    ],
  },
});

const city = defineEntityType({
  key: "city",
  name: "City",
  description: "Populated place (city, town, metro area)",
  properties: {
    country_id: {
      type: "integer",
      description: "FK to atlas.country",
      "x-table-column": true,
      "x-table-label": "Country",
      "x-link-entity-type": "country",
    },
    region_id: {
      type: "integer",
      description:
        "FK to atlas.region (optional — not every city is region-tagged)",
      "x-table-column": true,
      "x-table-label": "Region",
      "x-link-entity-type": "region",
    },
    latitude: { type: "number", description: "Decimal degrees, WGS84" },
    longitude: { type: "number", description: "Decimal degrees, WGS84" },
    population: {
      type: "integer",
      description: "City proper population (latest available estimate)",
    },
  },
});

const country = defineEntityType({
  key: "country",
  name: "Country",
  description: "Sovereign country (ISO 3166-1)",
  properties: {
    iso2: {
      type: "string",
      minLength: 2,
      maxLength: 2,
      "x-table-column": true,
      "x-table-label": "ISO2",
    },
    iso3: {
      type: "string",
      minLength: 3,
      maxLength: 3,
      "x-table-column": true,
      "x-table-label": "ISO3",
    },
    currency: {
      type: "string",
      description: "ISO 4217 currency code (e.g. USD, EUR, GBP)",
      "x-table-column": true,
      "x-table-label": "Currency",
    },
    region: {
      type: "string",
      description:
        "UN macro region (e.g. Europe, Africa, Asia, Americas, Oceania)",
      "x-table-column": true,
      "x-table-label": "Region",
    },
    population: {
      type: "integer",
      description: "Approximate population (latest available estimate)",
    },
  },
});

const industry = defineEntityType({
  key: "industry",
  name: "Industry",
  description: "Industry / sector taxonomy node (NAICS, BICS, or custom)",
  properties: {
    parent_id: {
      type: "integer",
      description: "FK to parent atlas.industry (self-reference for hierarchy)",
      "x-table-column": true,
      "x-table-label": "Parent",
      "x-link-entity-type": "industry",
    },
    taxonomy_source: {
      type: "string",
      enum: ["NAICS", "BICS", "custom"],
      "x-table-column": true,
      "x-table-label": "Source",
    },
    code: {
      type: "string",
      description: "Taxonomy code (e.g. NAICS 541512)",
      "x-table-column": true,
      "x-table-label": "Code",
    },
  },
});

const region = defineEntityType({
  key: "region",
  name: "Region",
  description:
    "First-level administrative region (state, province, etc.) within a country",
  properties: {
    country_id: {
      type: "integer",
      description: "FK to atlas.country",
      "x-table-column": true,
      "x-table-label": "Country",
      "x-link-entity-type": "country",
    },
    iso_3166_2: {
      type: "string",
      description: "ISO 3166-2 code (e.g. US-CA, GB-LND)",
      "x-table-column": true,
      "x-table-label": "ISO 3166-2",
    },
  },
});

const technology = defineEntityType({
  key: "technology",
  name: "Technology",
  description: "Technology, framework, library, platform, or developer tool",
  properties: {
    category: {
      type: "string",
      description:
        "Coarse category (e.g. database, frontend-framework, observability)",
      "x-table-column": true,
      "x-table-label": "Category",
    },
    homepage_url: {
      type: "string",
      format: "uri",
      "x-table-column": true,
      "x-table-label": "Homepage",
    },
  },
});

const university = defineEntityType({
  key: "university",
  name: "University",
  description: "Higher-education institution",
  properties: {
    country_id: {
      type: "integer",
      description: "FK to atlas.country",
      "x-table-column": true,
      "x-table-label": "Country",
      "x-link-entity-type": "country",
    },
    city_id: {
      type: "integer",
      description: "FK to atlas.city (optional)",
      "x-table-column": true,
      "x-table-label": "City",
      "x-link-entity-type": "city",
    },
    founded_year: {
      type: "integer",
      "x-table-column": true,
      "x-table-label": "Founded",
    },
    homepage_url: { type: "string", format: "uri" },
  },
});

const catalogStalenessChecker = defineWatcher({
  agent: atlasCurator,
  slug: "catalog-staleness-checker",
  name: "Catalog staleness checker",
  schedule: "0 4 * * 1",
  notification: { priority: "low" },
  tags: ["atlas", "reference", "weekly"],
  minCooldownSeconds: 3600,
  reaction: reactionFromFile<typeof catalogStalenessCheckerReaction>(
    "./catalog-staleness-checker.reaction.ts"
  ),
  prompt:
    'Sweep the atlas reference catalog for entries that haven\'t been\nupdated in 90+ days. List the stalest 10 across cities, countries,\nindustries, technologies, and universities. Suggest a re-verification\naction for each (e.g. "country/PL: confirm population from latest census").\n',
  extractionSchema: {
    type: "object",
    required: ["stale_entries"],
    properties: {
      stale_entries: {
        type: "array",
        items: {
          type: "object",
          properties: {
            entity_type: { type: "string" },
            slug: { type: "string" },
            last_updated: { type: "string" },
            suggested_action: { type: "string" },
          },
        },
      },
      total_stale_count: { type: "integer" },
    },
  },
});

export default defineConfig({
  org: "atlas",
  orgName: "Atlas",
  orgDescription: "Public reference catalog — places, taxonomies, institutions",
  agents: [atlasCurator],
  entities: [city, country, industry, region, technology, university],
  watchers: [catalogStalenessChecker],
});

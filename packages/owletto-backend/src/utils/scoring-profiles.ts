const SCORING_PROFILE_VALUES = [
  'engagement_percentile_content_60_40',
  'engagement_percentile_content_70_30_shortform',
  'inverse_rating_content_50_50',
  'inverse_rating_engagement_content_30_40_30',
  'inverse_rating_helpful_content_30_40_30',
  'inverse_rating_thumbs_content_30_40_30',
  'inverse_rating_votesum_content_30_40_30',
] as const;

type ScoringProfile = (typeof SCORING_PROFILE_VALUES)[number];

const SCORING_PROFILE_SET = new Set<string>(SCORING_PROFILE_VALUES);

const SCORING_PROFILE_SQL_MAP: Record<ScoringProfile, string> = {
  engagement_percentile_content_60_40: `
    PERCENT_RANK() OVER (PARTITION BY f.connection_id ORDER BY f.score) * 100 * 0.6 +
    LEAST(f.content_length / 20.0, 100) * 0.4
  `,
  engagement_percentile_content_70_30_shortform: `
    PERCENT_RANK() OVER (PARTITION BY f.connection_id ORDER BY f.score) * 100 * 0.7 +
    LEAST(f.content_length / 2.8, 100) * 0.3
  `,
  inverse_rating_content_50_50: `
    (5.0 - COALESCE((f.metadata->>'rating')::numeric, 3)) / 4.0 * 100 * 0.5 +
    LEAST(f.content_length / 20.0, 100) * 0.5
  `,
  inverse_rating_engagement_content_30_40_30: `
    (5.0 - COALESCE((f.metadata->>'rating')::numeric, 3)) / 4.0 * 100 * 0.3 +
    PERCENT_RANK() OVER (PARTITION BY f.connection_id ORDER BY f.score) * 100 * 0.4 +
    LEAST(f.content_length / 20.0, 100) * 0.3
  `,
  inverse_rating_helpful_content_30_40_30: `
    (5.0 - COALESCE((f.metadata->>'rating')::numeric, 3)) / 4.0 * 100 * 0.3 +
    PERCENT_RANK() OVER (PARTITION BY f.connection_id ORDER BY COALESCE((f.metadata->>'helpful_count')::numeric, 0)) * 100 * 0.4 +
    LEAST(f.content_length / 20.0, 100) * 0.3
  `,
  inverse_rating_thumbs_content_30_40_30: `
    (5.0 - COALESCE((f.metadata->>'rating')::numeric, 3)) / 4.0 * 100 * 0.3 +
    PERCENT_RANK() OVER (PARTITION BY f.connection_id ORDER BY COALESCE((f.metadata->>'thumbs_up')::numeric, 0)) * 100 * 0.4 +
    LEAST(f.content_length / 20.0, 100) * 0.3
  `,
  inverse_rating_votesum_content_30_40_30: `
    (5.0 - COALESCE((f.metadata->>'rating')::numeric, 3)) / 4.0 * 100 * 0.3 +
    PERCENT_RANK() OVER (PARTITION BY f.connection_id ORDER BY COALESCE((f.metadata->>'vote_sum')::numeric, 0)) * 100 * 0.4 +
    LEAST(f.content_length / 20.0, 100) * 0.3
  `,
};

const DEFAULT_PROFILE_BY_CONNECTOR_KEY: Record<string, ScoringProfile> = {
  capterra: 'inverse_rating_helpful_content_30_40_30',
  g2: 'inverse_rating_content_50_50',
  github: 'engagement_percentile_content_60_40',
  glassdoor: 'inverse_rating_content_50_50',
  gmaps: 'inverse_rating_content_50_50',
  google_play: 'inverse_rating_thumbs_content_30_40_30',
  hackernews: 'engagement_percentile_content_60_40',
  ios_appstore: 'inverse_rating_votesum_content_30_40_30',
  reddit: 'engagement_percentile_content_60_40',
  trustpilot: 'inverse_rating_engagement_content_30_40_30',
  x: 'engagement_percentile_content_70_30_shortform',
};

const FALLBACK_PROFILE: ScoringProfile = 'engagement_percentile_content_60_40';

function canonicalizeFormula(value: string): string {
  return value.replace(/\s+/g, '').trim();
}

const LEGACY_FORMULA_TO_PROFILE = new Map<string, ScoringProfile>(
  Object.entries(SCORING_PROFILE_SQL_MAP).map(([profile, sql]) => [
    canonicalizeFormula(sql),
    profile as ScoringProfile,
  ])
);

function isScoringProfile(value: unknown): value is ScoringProfile {
  return typeof value === 'string' && SCORING_PROFILE_SET.has(value);
}

export function getScoringFormulaSql(profile: ScoringProfile): string {
  return SCORING_PROFILE_SQL_MAP[profile];
}

function getDefaultScoringProfileForConnectorKey(
  connectorKey: string | null | undefined
): ScoringProfile {
  if (!connectorKey) return FALLBACK_PROFILE;
  const normalizedType = connectorKey.toLowerCase();
  return DEFAULT_PROFILE_BY_CONNECTOR_KEY[normalizedType] ?? FALLBACK_PROFILE;
}

function normalizeStoredScoringProfile(
  storedValue: string | null | undefined
): ScoringProfile | null {
  if (!storedValue) return null;
  const trimmed = storedValue.trim();
  if (trimmed.length === 0) return null;
  if (isScoringProfile(trimmed)) {
    return trimmed;
  }
  return LEGACY_FORMULA_TO_PROFILE.get(canonicalizeFormula(trimmed)) ?? null;
}

export function resolveStoredScoringProfile(
  storedValue: string | null | undefined,
  connectorKey: string | null | undefined
): ScoringProfile {
  const normalized = normalizeStoredScoringProfile(storedValue);
  if (normalized) return normalized;
  return getDefaultScoringProfileForConnectorKey(connectorKey);
}

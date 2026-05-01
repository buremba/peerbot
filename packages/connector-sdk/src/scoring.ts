/**
 * Calculate engagement score (0-100) based on engagement data
 * Each connector type has different metrics and scoring logic
 *
 * @param connectorKey - The connector key (reddit, github, google_play, etc.)
 * @param engagementData - Platform-specific engagement metrics
 * @returns Normalized score between 0-100
 */
export function calculateEngagementScore(
  connectorKey: string,
  engagementData: {
    score?: number;
    upvotes?: number;
    downvotes?: number;
    rating?: number;
    helpful_count?: number;
    reply_count?: number;
  }
): number {
  if (!engagementData) return 0;

  switch (connectorKey) {
    case 'reddit':
      // Reddit: karma score (upvotes - downvotes), normalized to 0-100
      // Max 10000 score = 100 points
      return Math.min(Math.max(engagementData.score || 0, 0), 10000) / 100;

    default: {
      // Generic scoring: combine rating + helpful votes + score
      if (engagementData.rating != null) {
        // Rating-based: rating (1-5) * 10 + helpful votes * 0.5
        return Math.min(
          (engagementData.rating || 0) * 10 + (engagementData.helpful_count || 0) * 0.5,
          100
        );
      }
      // Score-based: use score directly, capped at 100
      return Math.min(engagementData.score || 0, 100);
    }
  }
}

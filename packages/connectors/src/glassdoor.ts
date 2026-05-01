/**
 * Glassdoor Connector (V1 runtime)
 *
 * Scrapes employee reviews from Glassdoor using Playwright.
 */

import { createHash } from 'node:crypto';
import {
  type ActionContext,
  type ActionResult,
  type ConnectorDefinition,
  ConnectorRuntime,
  calculateEngagementScore,
  type EventEnvelope,
  type SyncContext,
  type SyncResult,
} from '@lobu/connector-sdk';
import {
  handleCookieConsent,
  openStealthBrowser,
  validateUrlDomain,
  withBrowserErrorCapture,
} from './browser-scraper-utils.ts';

/**
 * Generates a deterministic external ID for a Glassdoor review.
 * Uses the native review ID from the DOM when available, otherwise
 * derives a stable hash from review content to avoid duplicates.
 */
function deriveReviewExternalId(companyName: string, review: GlassdoorReview): string {
  if (review.id) return review.id;

  const contentKey = [
    review.date,
    review.author,
    (review.title || review.pros || review.cons).slice(0, 80),
  ]
    .filter(Boolean)
    .join('|');

  const hash = createHash('sha256').update(contentKey).digest('hex').slice(0, 12);
  const slug = companyName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return `glassdoor-${slug}-${hash}`;
}

/**
 * Raw review data extracted from a Glassdoor page
 */
interface GlassdoorReview {
  id: string;
  rating: number;
  title: string;
  pros: string;
  cons: string;
  date: string;
  author: string;
}

interface GlassdoorConfig {
  company_name: string;
  company_id?: string;
  lookback_days?: number;
}

export default class GlassdoorConnector extends ConnectorRuntime {
  readonly definition: ConnectorDefinition = {
    key: 'glassdoor',
    name: 'Glassdoor',
    description: 'Scrapes employee reviews from Glassdoor.',
    version: '1.0.0',
    faviconDomain: 'glassdoor.com',
    authSchema: {
      methods: [{ type: 'none' }],
    },
    feeds: {
      reviews: {
        key: 'reviews',
        name: 'Employee Reviews',
        description: 'Scrapes employee reviews for a given company.',
        configSchema: {
          type: 'object',
          required: ['company_name'],
          properties: {
            company_name: {
              type: 'string',
              minLength: 1,
              description: 'Company name for search-based lookup',
            },
            company_id: {
              type: 'string',
              description: 'Glassdoor company ID if known',
            },
            lookback_days: {
              type: 'integer',
              minimum: 1,
              maximum: 730,
              default: 365,
              description:
                'Number of days to look back for historical data. Default: 365 (1 year). Maximum: 730 (2 years).',
            },
          },
        },
        eventKinds: {
          review: {
            description: 'A Glassdoor employee review',
            metadataSchema: {
              type: 'object',
              properties: {
                rating: { type: 'number', description: 'Overall rating (0-5)' },
                title: { type: 'string', description: 'Review headline' },
                pros: { type: 'string' },
                cons: { type: 'string' },
              },
            },
          },
        },
      },
    },
    optionsSchema: {
      type: 'object',
      required: ['company_name'],
      properties: {
        company_name: {
          type: 'string',
          minLength: 1,
          description: 'Company name for search-based lookup',
        },
        company_id: {
          type: 'string',
          description: 'Glassdoor company ID if known',
        },
        lookback_days: {
          type: 'integer',
          minimum: 1,
          maximum: 730,
          default: 365,
          description:
            'Number of days to look back for historical data. Default: 365 (1 year). Maximum: 730 (2 years).',
        },
      },
    },
  };

  async sync(ctx: SyncContext): Promise<SyncResult> {
    const config = ctx.config as GlassdoorConfig;
    const { company_name, company_id } = config;

    if (!company_name) {
      return {
        events: [],
        checkpoint: ctx.checkpoint,
        metadata: { items_found: 0, error: 'company_name is required' },
      };
    }

    const baseUrl = company_id
      ? `https://www.glassdoor.com/Reviews/company-reviews-${company_id}.htm`
      : `https://www.glassdoor.com/Reviews/${company_name}-reviews-SRCH_KE0.htm`;
    validateUrlDomain(baseUrl, 'glassdoor.com');

    const session = await openStealthBrowser({ cdpUrl: 'auto' });

    return withBrowserErrorCapture(session, 'glassdoor-sync', async (page) => {
      // Configure viewport and user-agent to mimic a real browser
      await page.setViewportSize({ width: 1920, height: 1080 });
      await page.setExtraHTTPHeaders({
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      });

      // Navigate to the reviews page
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

      await handleCookieConsent(page, '#onetrust-accept-btn-handler');

      // Human-like delay before interacting with the page
      await page.waitForTimeout(2000);

      // Wait for review elements to render
      try {
        await page.waitForSelector(
          '[data-test="review-list-item"], .empReview, [data-test="employerReview"]',
          { timeout: 10000 }
        );
      } catch {
        // Reviews may not be present (auth wall, empty page, etc.)
      }

      // Extract raw reviews from the page DOM
      const rawReviews = await page.evaluate((): GlassdoorReview[] => {
        // Try multiple selector strategies as Glassdoor frequently changes their HTML
        const reviewElements =
          Array.from(document.querySelectorAll('[data-test="review-list-item"]')).length > 0
            ? Array.from(document.querySelectorAll('[data-test="review-list-item"]'))
            : Array.from(document.querySelectorAll('.empReview')).length > 0
              ? Array.from(document.querySelectorAll('.empReview'))
              : Array.from(document.querySelectorAll('[data-test="employerReview"]'));

        return reviewElements.map((el: Element) => {
          // Try multiple selector patterns for each field
          const ratingEl =
            el.querySelector('[data-test="overall-rating"]') ||
            el.querySelector('.rating') ||
            el.querySelector('[class*="rating"]');

          const titleEl =
            el.querySelector('[data-test="review-title"]') ||
            el.querySelector('.reviewLink') ||
            el.querySelector('[class*="title"]');

          const prosEl =
            el.querySelector('[data-test="pros"]') ||
            el.querySelector('[data-pros]') ||
            el.querySelector('.pros');

          const consEl =
            el.querySelector('[data-test="cons"]') ||
            el.querySelector('[data-cons]') ||
            el.querySelector('.cons');

          const dateEl =
            el.querySelector('[data-test="review-date"]') ||
            el.querySelector('.date') ||
            el.querySelector('time');

          const authorEl =
            el.querySelector('[data-test="employee-info"]') ||
            el.querySelector('.authorInfo') ||
            el.querySelector('[class*="author"]');

          // Try to get review ID from various attributes
          const reviewId =
            (el as HTMLElement).getAttribute('data-review-id') ||
            (el as HTMLElement).getAttribute('id') ||
            (el as HTMLElement).getAttribute('data-id') ||
            '';

          return {
            id: reviewId,
            rating: parseFloat(ratingEl?.textContent?.trim() || '0'),
            title: titleEl?.textContent?.trim() || '',
            pros: prosEl?.textContent?.trim() || '',
            cons: consEl?.textContent?.trim() || '',
            date: dateEl?.getAttribute('datetime') || dateEl?.textContent?.trim() || '',
            author: authorEl?.textContent?.trim() || '',
          };
        });
      });

      // Filter reviews that have at least pros or cons
      const validReviews = rawReviews.filter((r) => Boolean(r.pros || r.cons));

      // Transform to EventEnvelope format
      const events: EventEnvelope[] = validReviews.map((review) => {
        const externalId = deriveReviewExternalId(company_name, review);
        const content = `${review.title}\n\nPros: ${review.pros}\n\nCons: ${review.cons}`;

        return {
          origin_id: externalId,
          payload_text: content,
          author_name: review.author || undefined,
          occurred_at: review.date ? new Date(review.date) : new Date(),
          origin_type: 'review',
          score: calculateEngagementScore('glassdoor', { rating: review.rating }),
          source_url: `${baseUrl}#review_${review.id}`,
          metadata: {
            rating: review.rating,
            title: review.title,
            pros: review.pros,
            cons: review.cons,
          },
        };
      });

      return {
        events,
        checkpoint: {
          last_sync_at: new Date().toISOString(),
        } as Record<string, unknown>,
        metadata: {
          items_found: events.length,
          items_skipped: rawReviews.length - validReviews.length,
        },
      };
    });
  }

  async execute(_ctx: ActionContext): Promise<ActionResult> {
    return { success: false, error: 'Actions not supported' };
  }
}

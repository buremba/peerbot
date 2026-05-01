/**
 * Trustpilot Connector (V1 runtime)
 *
 * Scrapes business reviews from Trustpilot using Playwright.
 */

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

interface TrustpilotReview {
  rating: number;
  title: string;
  text: string;
  date: string;
  author: string;
}

const configSchema = {
  type: 'object',
  properties: {
    business_url: {
      type: 'string',
      format: 'uri',
      description:
        'Full Trustpilot review URL (e.g., "https://www.trustpilot.com/review/spotify.com")',
    },
    business_name: {
      type: 'string',
      minLength: 1,
      description: 'Business name for search-based lookup',
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
};

export default class TrustpilotConnector extends ConnectorRuntime {
  readonly definition: ConnectorDefinition = {
    key: 'trustpilot',
    name: 'Trustpilot',
    description: 'Scrapes business reviews from Trustpilot.',
    version: '1.0.0',
    faviconDomain: 'trustpilot.com',
    authSchema: {
      methods: [{ type: 'none' }],
    },
    feeds: {
      reviews: {
        key: 'reviews',
        name: 'Business Reviews',
        description: 'Scrape reviews for a business on Trustpilot.',
        configSchema,
        eventKinds: {
          review: {
            description: 'A Trustpilot business review',
            metadataSchema: {
              type: 'object',
              properties: {
                rating: { type: 'number', description: 'Star rating (1-5)' },
                helpful_count: { type: 'number' },
                title: { type: 'string', description: 'Review headline' },
              },
            },
          },
        },
      },
    },
    optionsSchema: configSchema,
  };

  async sync(ctx: SyncContext): Promise<SyncResult> {
    const businessUrl = ctx.config.business_url as string | undefined;
    const businessName = ctx.config.business_name as string | undefined;

    if (!businessUrl && !businessName) {
      throw new Error('Either business_url or business_name is required');
    }

    const baseUrl = businessUrl || `https://www.trustpilot.com/review/${businessName}`;
    validateUrlDomain(baseUrl, 'trustpilot.com');

    const session = await openStealthBrowser({ cdpUrl: 'auto' });

    return withBrowserErrorCapture(session, 'trustpilot-sync', async (page) => {
      await page.goto(baseUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });

      await handleCookieConsent(page, '[data-cookie-consent-accept]');

      // Wait for review cards to load
      try {
        await page.waitForSelector('[data-service-review-card-paper]', {
          timeout: 10000,
        });
      } catch {
        // No reviews found on page
        return {
          events: [],
          checkpoint: {
            last_sync_at: new Date().toISOString(),
            last_page: 1,
          },
          metadata: { items_found: 0 },
        };
      }

      // Extract raw reviews from the page
      const rawReviews = await page.evaluate(() => {
        const reviewElements = Array.from(
          document.querySelectorAll('[data-service-review-card-paper]')
        );

        return reviewElements.map((el: Element) => {
          const ratingElement = el.querySelector('[data-service-review-rating]');
          const titleElement = el.querySelector('[data-service-review-title-typography]');
          const textElement = el.querySelector('[data-service-review-text-typography]');
          const dateElement = el.querySelector('time');
          const authorElement = el.querySelector('[data-consumer-name-typography]');

          const rating = parseInt(
            ratingElement?.getAttribute('data-service-review-rating') || '0',
            10
          );

          return {
            rating,
            title: titleElement?.textContent?.trim() || '',
            text: textElement?.textContent?.trim() || '',
            date: dateElement?.getAttribute('datetime') || '',
            author: authorElement?.textContent?.trim() || '',
          };
        });
      });

      // Filter reviews with meaningful content (more than 10 chars)
      const reviews: TrustpilotReview[] = rawReviews.filter((r) => r.text && r.text.length > 10);

      // Transform to EventEnvelope format
      const events: EventEnvelope[] = reviews.map((review) => {
        const content = review.title ? `${review.title}\n\n${review.text}` : review.text;

        return {
          origin_id: `${review.date}-${review.author}`,
          payload_text: content,
          author_name: review.author,
          occurred_at: new Date(review.date),
          origin_type: 'review',
          score: calculateEngagementScore('trustpilot', {
            rating: review.rating,
            helpful_count: 0,
          }),
          source_url: baseUrl,
          metadata: {
            rating: review.rating,
            helpful_count: 0,
            title: review.title,
          },
        };
      });

      return {
        events,
        checkpoint: {
          last_sync_at: new Date().toISOString(),
          last_page: 1,
        } as Record<string, unknown>,
        metadata: {
          items_found: reviews.length,
        },
      };
    });
  }

  async execute(_ctx: ActionContext): Promise<ActionResult> {
    return { success: false, error: 'Actions not supported' };
  }
}

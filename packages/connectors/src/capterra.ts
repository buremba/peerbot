/**
 * Capterra Connector
 * Scrapes software reviews from Capterra using browser rendering with stealth mode.
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

interface CapterraReview {
  id: string;
  rating: number;
  title: string;
  text: string;
  date: string;
  author: string;
  helpfulCount: number;
}

export default class CapterraConnector extends ConnectorRuntime {
  readonly definition: ConnectorDefinition = {
    key: 'capterra',
    name: 'Capterra',
    version: '1.0.0',
    faviconDomain: 'capterra.com',
    description: 'Scrapes software reviews from Capterra.',
    authSchema: {
      methods: [{ type: 'none' }],
    },
    feeds: {
      reviews: {
        key: 'reviews',
        name: 'Reviews',
        description: 'Capterra software reviews',
        configSchema: {
          type: 'object',
          required: ['product_id'],
          properties: {
            product_id: {
              type: 'string',
              description: 'Capterra product ID (e.g., "12345")',
              minLength: 1,
            },
            product_name: {
              type: 'string',
              description:
                'Product name slug for URL (e.g., "spotify"). Optional - Capterra will redirect without it.',
              minLength: 1,
            },
            vendor_name: {
              type: 'string',
              description:
                'Vendor/company name (e.g., "Spotify AB"). Optional but recommended for disambiguation.',
              minLength: 1,
            },
            lookback_days: {
              type: 'integer',
              description:
                'Number of days to look back for historical data. Default: 365 (1 year). Maximum: 730 (2 years).',
              minimum: 1,
              maximum: 730,
              default: 365,
            },
          },
        },
        eventKinds: {
          review: {
            description: 'A Capterra software review',
            metadataSchema: {
              type: 'object',
              properties: {
                rating: { type: 'number', description: 'Star rating (0-5)' },
                helpful_count: { type: 'number', description: 'Number of helpful votes' },
              },
            },
          },
        },
      },
    },
    optionsSchema: {
      type: 'object',
      required: ['product_id'],
      properties: {
        product_id: {
          type: 'string',
          description: 'Capterra product ID (e.g., "12345")',
          minLength: 1,
        },
        product_name: {
          type: 'string',
          description:
            'Product name slug for URL (e.g., "spotify"). Optional - Capterra will redirect without it.',
          minLength: 1,
        },
        vendor_name: {
          type: 'string',
          description:
            'Vendor/company name (e.g., "Spotify AB"). Optional but recommended for disambiguation.',
          minLength: 1,
        },
        lookback_days: {
          type: 'integer',
          description:
            'Number of days to look back for historical data. Default: 365 (1 year). Maximum: 730 (2 years).',
          minimum: 1,
          maximum: 730,
          default: 365,
        },
      },
    },
  };

  async sync(ctx: SyncContext): Promise<SyncResult> {
    const productId = ctx.config.product_id as string;
    const productName = ctx.config.product_name as string | undefined;

    const baseUrl = productName
      ? `https://www.capterra.com/p/${productId}/${productName}/reviews`
      : `https://www.capterra.com/p/${productId}/reviews`;
    validateUrlDomain(baseUrl, 'capterra.com');

    const session = await openStealthBrowser({ cdpUrl: 'auto' });

    return withBrowserErrorCapture(session, 'capterra-sync', async (page) => {
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

      await handleCookieConsent(page, '[data-test="cookie-accept"], #onetrust-accept-btn-handler');

      // Wait for review cards
      try {
        await page.waitForSelector('[data-test="review-card"], .review-card', { timeout: 10000 });
      } catch {
        // Review selectors not found - page structure may have changed
      }

      // Extract reviews using page.evaluate
      const rawReviews: CapterraReview[] = await page.evaluate(() => {
        const reviewElements = Array.from(
          document.querySelectorAll('[data-test="review-card"], .review-card')
        );

        return reviewElements.map((el: Element, index: number) => {
          // Extract rating (usually shown as stars)
          const ratingElement = el.querySelector(
            '[data-test="rating"], .rating, [aria-label*="star"]'
          );
          let rating = 0;
          if (ratingElement) {
            const ariaLabel = ratingElement.getAttribute('aria-label');
            const ratingMatch = ariaLabel?.match(/(\d+(?:\.\d+)?)/);
            rating = ratingMatch ? parseFloat(ratingMatch[1]) : 0;
          }

          // Extract review title
          const titleElement = el.querySelector(
            '[data-test="review-title"], .review-title, h3, h4'
          );
          const title = titleElement?.textContent?.trim() || '';

          // Extract review text
          const textElement = el.querySelector(
            '[data-test="review-body"], .review-body, .review-content, .review-text'
          );
          const text = textElement?.textContent?.trim() || '';

          // Extract date
          const dateElement = el.querySelector('[data-test="review-date"], .review-date, time');
          const dateText =
            dateElement?.textContent?.trim() || dateElement?.getAttribute('datetime') || '';

          // Parse relative dates like "2 weeks ago"
          let date = new Date();
          if (dateText) {
            const weeksMatch = dateText.match(/(\d+)\s+weeks?\s+ago/i);
            const monthsMatch = dateText.match(/(\d+)\s+months?\s+ago/i);
            const daysMatch = dateText.match(/(\d+)\s+days?\s+ago/i);

            if (weeksMatch) {
              date = new Date(Date.now() - parseInt(weeksMatch[1], 10) * 7 * 24 * 60 * 60 * 1000);
            } else if (monthsMatch) {
              date = new Date(Date.now() - parseInt(monthsMatch[1], 10) * 30 * 24 * 60 * 60 * 1000);
            } else if (daysMatch) {
              date = new Date(Date.now() - parseInt(daysMatch[1], 10) * 24 * 60 * 60 * 1000);
            } else {
              // Try parsing as date
              const parsed = new Date(dateText);
              if (!Number.isNaN(parsed.getTime())) {
                date = parsed;
              }
            }
          }

          // Extract author
          const authorElement = el.querySelector(
            '[data-test="reviewer-name"], .reviewer-name, .author'
          );
          const author = authorElement?.textContent?.trim() || 'Anonymous';

          // Extract review ID from data attributes or generate
          const reviewId =
            (el as HTMLElement).getAttribute('data-review-id') ||
            (el as HTMLElement).id ||
            `${date.toISOString()}_${index}`.replace(/[^a-zA-Z0-9]/g, '_');

          // Extract helpful count
          const helpfulElement = el.querySelector('[data-test="helpful-count"], .helpful-count');
          const helpfulCount = helpfulElement
            ? parseInt(helpfulElement.textContent?.replace(/\D/g, '') || '0', 10)
            : 0;

          return {
            id: reviewId,
            rating,
            title,
            text,
            date: date.toISOString(),
            author,
            helpfulCount,
          };
        });
      });

      // Filter reviews with content
      const reviews = rawReviews.filter((r) => r.text.length > 0);

      // Transform to EventEnvelope
      const events: EventEnvelope[] = reviews.map((review) => {
        const engagementData = {
          rating: review.rating,
          helpful_count: review.helpfulCount,
        };

        return {
          origin_id: review.id,
          title: review.title,
          payload_text: review.text,
          author_name: review.author,
          occurred_at: new Date(review.date),
          origin_type: 'review',
          score: calculateEngagementScore('capterra', engagementData),
          source_url: baseUrl,
          metadata: engagementData,
        };
      });

      return {
        events,
        checkpoint: { last_sync_at: new Date().toISOString() },
        metadata: {
          items_found: rawReviews.length,
          items_skipped: rawReviews.length - reviews.length,
        },
      };
    });
  }

  async execute(_ctx: ActionContext): Promise<ActionResult> {
    return { success: false, error: 'Actions not supported' };
  }
}

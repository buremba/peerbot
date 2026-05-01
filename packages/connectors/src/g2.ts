/**
 * G2 Connector (V1 runtime)
 *
 * Scrapes B2B software reviews from G2.com using browser rendering with stealth mode.
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

interface G2Review {
  rating: number;
  title: string;
  text: string;
  author: string;
  jobTitle: string;
  industry: string;
  companySize: string;
  date: string;
  badges: string[];
  reviewUrl: string;
  helpfulCount: number;
}

interface G2Checkpoint {
  last_sync_at?: string;
  pages_crawled?: number;
}

const configSchema = {
  type: 'object',
  required: ['product_url'],
  properties: {
    product_url: {
      type: 'string',
      description: 'Full G2 product review URL e.g. https://www.g2.com/products/confluence/reviews',
    },
    lookback_days: {
      type: 'integer',
      minimum: 1,
      maximum: 730,
      default: 365,
      description: 'Number of days to look back for reviews (default 365)',
    },
  },
};

export default class G2Connector extends ConnectorRuntime {
  readonly definition: ConnectorDefinition = {
    key: 'g2',
    name: 'G2',
    description: 'Scrapes B2B software reviews from G2.com.',
    version: '1.0.0',
    faviconDomain: 'g2.com',
    authSchema: {
      methods: [{ type: 'none' }],
    },
    feeds: {
      reviews: {
        key: 'reviews',
        name: 'Product Reviews',
        description: 'Scrape reviews for a G2 product listing.',
        configSchema,
        eventKinds: {
          review: {
            description: 'A G2 B2B software review',
            metadataSchema: {
              type: 'object',
              properties: {
                rating: { type: 'number', description: 'Star rating (0-5)' },
                helpful_count: { type: 'number' },
                job_title: { type: 'string', description: 'Reviewer job title' },
                industry: { type: 'string', description: 'Reviewer industry' },
                company_size: { type: 'string', description: 'Reviewer company size' },
                badges: { type: 'array', items: { type: 'string' }, description: 'Review badges' },
              },
            },
          },
        },
      },
    },
    optionsSchema: configSchema,
  };

  async sync(ctx: SyncContext): Promise<SyncResult> {
    const productUrl = ctx.config.product_url as string;

    if (!productUrl?.match(/^https:\/\/www\.g2\.com\/products\/[^/]+\/reviews/)) {
      return {
        events: [],
        checkpoint: ctx.checkpoint,
        metadata: { items_found: 0, error: 'Invalid product_url' },
      };
    }
    validateUrlDomain(productUrl, 'g2.com');

    // Extract product key from URL for origin_id generation
    const productMatch = productUrl.match(/\/products\/([^/]+)/);
    const productKey = productMatch ? productMatch[1] : 'unknown';

    const baseUrl = productUrl;
    const allEvents: EventEnvelope[] = [];

    const session = await openStealthBrowser({ cdpUrl: 'auto' });

    return withBrowserErrorCapture(session, 'g2-sync', async (page) => {
      const maxPages = 5;

      for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
        const pageUrl = pageNum === 1 ? baseUrl : `${baseUrl}?page=${pageNum}`;

        await page.goto(pageUrl, { waitUntil: 'domcontentloaded' });

        if (pageNum === 1) {
          await handleCookieConsent(page, '#onetrust-accept-btn-handler');
        }

        // Wait for review cards to load
        try {
          await page.waitForSelector('[itemprop="review"]', { timeout: 10000 });
        } catch {
          // No reviews found on this page — stop paginating
          break;
        }

        // Extract reviews from the page
        const reviews: G2Review[] = await page.evaluate(() => {
          const results: G2Review[] = [];
          const reviewCards = document.querySelectorAll('[itemprop="review"]');

          reviewCards.forEach((card) => {
            try {
              // Extract author name from meta tag
              const authorMeta = card.querySelector('[itemprop="author"] meta[itemprop="name"]');
              const author = authorMeta?.getAttribute('content') || 'Anonymous';

              // Extract author details from sibling divs with elv-text-subtle class
              const authorContainer = card.querySelector('[itemprop="author"]');
              const parentDiv = authorContainer?.closest('.elv-gap-2')?.parentElement;
              const detailDivs = parentDiv
                ? Array.from(parentDiv.querySelectorAll('.elv-text-subtle'))
                : [];

              // Parse author details (job title, industry, company size)
              let jobTitle = '';
              let industry = '';
              let companySize = '';

              if (detailDivs.length >= 3) {
                jobTitle = detailDivs[0]?.textContent?.trim() || '';
                industry = detailDivs[1]?.textContent?.trim() || '';
                companySize = detailDivs[2]?.textContent?.trim() || '';
              } else if (detailDivs.length === 2) {
                jobTitle = detailDivs[0]?.textContent?.trim() || '';
                companySize = detailDivs[1]?.textContent?.trim() || '';
              } else if (detailDivs.length === 1) {
                companySize = detailDivs[0]?.textContent?.trim() || '';
              }

              // Extract date from meta tag
              const dateMeta = card.querySelector('meta[itemprop="datePublished"]');
              const dateStr = dateMeta?.getAttribute('content') || '';

              // Extract rating
              const ratingMeta = card.querySelector('[itemprop="ratingValue"]');
              const rating = ratingMeta ? parseFloat(ratingMeta.getAttribute('content') || '0') : 0;

              // Extract review title
              const titleDiv = card.querySelector('[itemprop="name"] .elv-font-bold');
              const title = titleDiv?.textContent?.trim().replace(/^"|"$/g, '') || '';

              // Extract review body - use innerText to preserve visual spacing/newlines
              const reviewBodyEl = card.querySelector('[itemprop="reviewBody"]');
              const reviewBody = (reviewBodyEl as HTMLElement)?.innerText?.trim() || '';

              // Extract badges
              const badgeEls = card.querySelectorAll(
                '[class*="badge"], [class*="tag"], .elv-rounded-sm.elv-border'
              );
              const badges = Array.from(badgeEls)
                .map((el) => el.textContent?.trim())
                .filter((text): text is string => !!text && text.length < 50 && text.length > 3);

              // Extract review URL
              const linkEl = card.querySelector('a[href*="survey_responses"]');
              const href = linkEl?.getAttribute('href') || '';
              const reviewUrl = href
                ? href.startsWith('http')
                  ? href
                  : `https://www.g2.com${href}`
                : '';

              // Skip reviews with minimal content
              if ((reviewBody || '').length < 50) return;

              results.push({
                rating,
                title,
                text: reviewBody,
                author,
                jobTitle,
                industry,
                companySize,
                date: dateStr,
                badges: badges.slice(0, 10),
                reviewUrl,
                helpfulCount: 0,
              });
            } catch (e) {
              console.error('[G2Connector] Error parsing review card:', e);
            }
          });

          return results;
        });

        // Transform reviews to EventEnvelope format
        for (const review of reviews) {
          const event: EventEnvelope = {
            origin_id: `g2-${productKey}-${review.date || 'nodate'}-${review.author.replace(/\s+/g, '-')}`,
            title: review.title,
            payload_text: review.text,
            author_name: review.author,
            occurred_at: review.date ? new Date(review.date) : new Date(),
            origin_type: 'review',
            score: calculateEngagementScore('g2', {
              rating: review.rating,
              helpful_count: 0,
            }),
            source_url: review.reviewUrl || baseUrl,
            metadata: {
              rating: review.rating,
              helpful_count: review.helpfulCount,
              job_title: review.jobTitle,
              industry: review.industry,
              company_size: review.companySize,
              badges: review.badges,
            },
          };
          allEvents.push(event);
        }

        // If this page had no reviews, stop paginating
        if (reviews.length === 0) break;

        // Delay between pages
        if (pageNum < maxPages) {
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }

        // Rate limit
        await new Promise((resolve) => setTimeout(resolve, 6000));
      }

      const newCheckpoint: G2Checkpoint = {
        last_sync_at: new Date().toISOString(),
        pages_crawled: Math.min(5, allEvents.length > 0 ? Math.ceil(allEvents.length / 10) : 0),
      };

      return {
        events: allEvents,
        checkpoint: newCheckpoint as Record<string, unknown>,
        metadata: {
          items_found: allEvents.length,
        },
      };
    });
  }

  async execute(_ctx: ActionContext): Promise<ActionResult> {
    return { success: false, error: 'Actions not supported' };
  }
}

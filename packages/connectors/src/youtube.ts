/**
 * YouTube Connector (V1 runtime)
 *
 * Fetches video metadata, comments, and transcripts from YouTube search results
 * via the YouTube Data API v3. Transcripts are extracted from YouTube's embedded
 * caption tracks (no third-party packages required).
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

// ---------------------------------------------------------------------------
// YouTube API types
// ---------------------------------------------------------------------------

interface YouTubeSearchItem {
  id: {
    kind: string;
    videoId: string;
  };
  snippet: {
    publishedAt: string;
    channelId: string;
    title: string;
    description: string;
    channelTitle: string;
  };
}

interface YouTubeSearchResponse {
  nextPageToken?: string;
  pageInfo: {
    totalResults: number;
    resultsPerPage: number;
  };
  items: YouTubeSearchItem[];
}

interface YouTubeVideoItem {
  id: string;
  snippet: {
    publishedAt: string;
    channelId: string;
    title: string;
    description: string;
    channelTitle: string;
    tags?: string[];
  };
  statistics: {
    viewCount?: string;
    likeCount?: string;
    commentCount?: string;
  };
  contentDetails?: {
    duration?: string;
  };
}

interface YouTubeVideoResponse {
  items: YouTubeVideoItem[];
}

interface YouTubeCommentSnippet {
  videoId: string;
  topLevelComment: {
    id: string;
    snippet: {
      textDisplay: string;
      textOriginal: string;
      authorDisplayName: string;
      authorChannelUrl?: string;
      likeCount: number;
      publishedAt: string;
      updatedAt: string;
    };
  };
  totalReplyCount: number;
}

interface YouTubeCommentThread {
  id: string;
  snippet: YouTubeCommentSnippet;
}

interface YouTubeCommentThreadResponse {
  nextPageToken?: string;
  pageInfo: {
    totalResults: number;
    resultsPerPage: number;
  };
  items: YouTubeCommentThread[];
}

interface CaptionTrack {
  baseUrl: string;
  languageCode: string;
}

// ---------------------------------------------------------------------------
// Checkpoint
// ---------------------------------------------------------------------------

interface YouTubeCheckpoint {
  last_published_at?: string;
  next_page_token?: string;
}

// ---------------------------------------------------------------------------
// Connector
// ---------------------------------------------------------------------------

export default class YouTubeConnector extends ConnectorRuntime {
  readonly definition: ConnectorDefinition = {
    key: 'youtube',
    name: 'YouTube',
    description: 'Fetches video metadata, comments, and transcripts from YouTube search results.',
    version: '1.0.0',
    faviconDomain: 'youtube.com',
    authSchema: {
      methods: [
        {
          type: 'oauth',
          provider: 'google',
          requiredScopes: ['https://www.googleapis.com/auth/youtube.readonly'],
          loginScopes: ['openid', 'email', 'profile'],
          clientIdKey: 'GOOGLE_CLIENT_ID',
          clientSecretKey: 'GOOGLE_CLIENT_SECRET',
          tokenUrl: 'https://oauth2.googleapis.com/token',
          tokenEndpointAuthMethod: 'client_secret_post',
          loginProvisioning: {
            autoCreateConnection: false,
          },
        },
      ],
    },
    feeds: {
      videos: {
        key: 'videos',
        name: 'Videos',
        requiredScopes: ['https://www.googleapis.com/auth/youtube.readonly'],
        description: 'Search YouTube for videos and collect metadata, comments, and transcripts.',
        configSchema: {
          type: 'object',
          required: ['search_query'],
          properties: {
            search_query: {
              type: 'string',
              minLength: 1,
              description: 'Search term to query YouTube.',
            },
            max_results: {
              type: 'integer',
              minimum: 1,
              maximum: 200,
              default: 50,
              description: 'Total videos to fetch per sync (max 200).',
            },
            include_transcripts: {
              type: 'boolean',
              default: true,
              description: 'Whether to fetch video transcripts.',
            },
            include_comments: {
              type: 'boolean',
              default: true,
              description: 'Whether to fetch video comments.',
            },
          },
        },
        eventKinds: {
          video: {
            description: 'A YouTube video with metadata and optional transcript',
            metadataSchema: {
              type: 'object',
              properties: {
                view_count: { type: 'number' },
                like_count: { type: 'number' },
                comment_count: { type: 'number' },
                channel_title: { type: 'string' },
                channel_id: { type: 'string' },
                has_transcript: { type: 'boolean' },
                duration: { type: 'string' },
                tags: {
                  type: 'array',
                  items: { type: 'string' },
                },
              },
            },
          },
          comment: {
            description: 'A comment on a YouTube video',
            metadataSchema: {
              type: 'object',
              properties: {
                video_id: { type: 'string' },
                like_count: { type: 'number' },
                reply_count: { type: 'number' },
              },
            },
          },
        },
      },
    },
    optionsSchema: {
      type: 'object',
      required: ['search_query'],
      properties: {
        search_query: {
          type: 'string',
          minLength: 1,
          description: 'Search term to query YouTube.',
        },
        max_results: {
          type: 'integer',
          minimum: 1,
          maximum: 200,
          default: 50,
          description: 'Total videos to fetch per sync (max 200).',
        },
        include_transcripts: {
          type: 'boolean',
          default: true,
          description: 'Whether to fetch video transcripts.',
        },
        include_comments: {
          type: 'boolean',
          default: true,
          description: 'Whether to fetch video comments.',
        },
      },
    },
  };

  private readonly BASE_URL = 'https://www.googleapis.com/youtube/v3';
  private readonly RATE_LIMIT_MS = 200;
  private readonly COMMENT_PAGE_LIMIT = 3;

  // -------------------------------------------------------------------------
  // sync
  // -------------------------------------------------------------------------

  async sync(ctx: SyncContext): Promise<SyncResult> {
    const accessToken = ctx.credentials?.accessToken as string | undefined;
    const apiKey = (ctx.config.YOUTUBE_API_KEY as string) || undefined;
    if (!accessToken && !apiKey) {
      throw new Error('YouTube requires either OAuth (Google) or a YOUTUBE_API_KEY.');
    }

    const searchQuery = ctx.config.search_query as string;
    if (!searchQuery) {
      throw new Error('search_query is required.');
    }

    const maxResults = Math.min((ctx.config.max_results as number) ?? 50, 200);
    const includeTranscripts = (ctx.config.include_transcripts as boolean) ?? true;
    const includeComments = (ctx.config.include_comments as boolean) ?? true;

    const checkpoint = (ctx.checkpoint as YouTubeCheckpoint) ?? {};
    const events: EventEnvelope[] = [];
    const seenIds = new Set<string>();

    const auth = { accessToken, apiKey };
    let pageToken: string | undefined = checkpoint.next_page_token;
    let totalCollected = 0;

    // ----- Search & collect video IDs -----
    while (totalCollected < maxResults) {
      const pageSize = Math.min(50, maxResults - totalCollected);
      const searchUrl = this.buildSearchUrl(searchQuery, pageSize, pageToken);

      const searchResponse = await this.apiGet(searchUrl, auth);
      if (!searchResponse.ok) {
        throw new Error(
          `YouTube Search API error (${searchResponse.status}): ${await searchResponse.text()}`
        );
      }

      const searchData = (await searchResponse.json()) as YouTubeSearchResponse;

      if (searchData.items.length === 0) break;

      // Collect unique video IDs from this page
      const videoIds: string[] = [];
      for (const item of searchData.items) {
        const videoId = item.id.videoId;
        if (videoId && !seenIds.has(videoId)) {
          seenIds.add(videoId);
          videoIds.push(videoId);
        }
      }

      if (videoIds.length === 0) {
        pageToken = searchData.nextPageToken;
        if (!pageToken) break;
        continue;
      }

      // ----- Fetch video details in batches of 50 -----
      const videoDetails = await this.fetchVideoDetails(auth, videoIds);

      // ----- Process each video -----
      for (const video of videoDetails) {
        try {
          const viewCount = parseInt(video.statistics.viewCount ?? '0', 10);
          const likeCount = parseInt(video.statistics.likeCount ?? '0', 10);
          const commentCount = parseInt(video.statistics.commentCount ?? '0', 10);

          // Fetch transcript if enabled
          let transcript: string | null = null;
          if (includeTranscripts) {
            try {
              transcript = await this.fetchTranscript(video.id);
            } catch {
              /* transcript fetch is best-effort */
            }
            await this.sleep(this.RATE_LIMIT_MS);
          }

          const hasTranscript = transcript != null && transcript.length > 0;

          const engagementScore = calculateEngagementScore('youtube', {
            upvotes: likeCount,
            reply_count: commentCount,
            score: Math.round(viewCount / 100),
          });

          const videoEvent: EventEnvelope = {
            origin_id: `yt_video_${video.id}`,
            title: video.snippet.title,
            payload_text: hasTranscript ? transcript! : (video.snippet.description ?? '').trim(),
            author_name: video.snippet.channelTitle,
            source_url: `https://www.youtube.com/watch?v=${video.id}`,
            occurred_at: new Date(video.snippet.publishedAt),
            origin_type: 'video',
            score: engagementScore,
            metadata: {
              view_count: viewCount,
              like_count: likeCount,
              comment_count: commentCount,
              channel_title: video.snippet.channelTitle,
              channel_id: video.snippet.channelId,
              has_transcript: hasTranscript,
              ...(video.contentDetails?.duration && {
                duration: video.contentDetails.duration,
              }),
              ...(video.snippet.tags &&
                video.snippet.tags.length > 0 && {
                  tags: video.snippet.tags,
                }),
            },
          };

          events.push(videoEvent);

          // ----- Fetch comments if enabled -----
          if (includeComments && commentCount > 0) {
            try {
              const comments = await this.fetchComments(auth, video.id);
              for (const comment of comments) {
                const commentSnippet = comment.snippet.topLevelComment.snippet;

                const commentEvent: EventEnvelope = {
                  origin_id: `yt_comment_${comment.snippet.topLevelComment.id}`,
                  payload_text: commentSnippet.textOriginal,
                  author_name: commentSnippet.authorDisplayName,
                  source_url: `https://www.youtube.com/watch?v=${video.id}&lc=${comment.snippet.topLevelComment.id}`,
                  occurred_at: new Date(commentSnippet.publishedAt),
                  origin_type: 'comment',
                  origin_parent_id: `yt_video_${video.id}`,
                  metadata: {
                    video_id: video.id,
                    like_count: commentSnippet.likeCount,
                    reply_count: comment.snippet.totalReplyCount,
                  },
                };

                events.push(commentEvent);
              }
            } catch {
              /* comment fetch is best-effort */
            }
          }
        } catch {
          /* skip individual video failures */
        }
      }

      totalCollected += videoIds.length;
      pageToken = searchData.nextPageToken;

      if (!pageToken) break;

      await this.sleep(this.RATE_LIMIT_MS);
    }

    // Sort events by occurred_at descending
    events.sort((a, b) => b.occurred_at.getTime() - a.occurred_at.getTime());

    // Update checkpoint
    const latestPublishedAt = events.length > 0 ? events[0].occurred_at.toISOString() : undefined;

    const newCheckpoint: YouTubeCheckpoint = {
      last_published_at: latestPublishedAt ?? checkpoint.last_published_at,
      next_page_token: pageToken,
    };

    return {
      events,
      checkpoint: newCheckpoint as Record<string, unknown>,
      metadata: {
        items_found: events.length,
        videos_collected: seenIds.size,
      },
    };
  }

  // -------------------------------------------------------------------------
  // execute
  // -------------------------------------------------------------------------

  async execute(_ctx: ActionContext): Promise<ActionResult> {
    return { success: false, error: 'Actions not supported' };
  }

  // -------------------------------------------------------------------------
  // YouTube API helpers
  // -------------------------------------------------------------------------

  private buildSearchUrl(query: string, maxResults: number, pageToken?: string): string {
    const params = new URLSearchParams({
      part: 'snippet',
      q: query,
      type: 'video',
      order: 'date',
      maxResults: String(maxResults),
    });
    if (pageToken) {
      params.set('pageToken', pageToken);
    }
    return `${this.BASE_URL}/search?${params.toString()}`;
  }

  private async fetchVideoDetails(
    auth: { accessToken?: string; apiKey?: string },
    videoIds: string[]
  ): Promise<YouTubeVideoItem[]> {
    const results: YouTubeVideoItem[] = [];

    // Batch in groups of 50 (YouTube API limit)
    for (let i = 0; i < videoIds.length; i += 50) {
      const batch = videoIds.slice(i, i + 50);
      const params = new URLSearchParams({
        part: 'snippet,statistics,contentDetails',
        id: batch.join(','),
      });

      const response = await this.apiGet(`${this.BASE_URL}/videos?${params.toString()}`, auth);
      if (!response.ok) {
        throw new Error(`YouTube Videos API error (${response.status}): ${await response.text()}`);
      }

      const data = (await response.json()) as YouTubeVideoResponse;
      results.push(...data.items);

      if (i + 50 < videoIds.length) {
        await this.sleep(this.RATE_LIMIT_MS);
      }
    }

    return results;
  }

  private async fetchComments(
    auth: { accessToken?: string; apiKey?: string },
    videoId: string
  ): Promise<YouTubeCommentThread[]> {
    const allComments: YouTubeCommentThread[] = [];
    let pageToken: string | undefined;
    let pages = 0;

    while (pages < this.COMMENT_PAGE_LIMIT) {
      const params = new URLSearchParams({
        part: 'snippet',
        videoId,
        maxResults: '100',
        order: 'relevance',
      });
      if (pageToken) {
        params.set('pageToken', pageToken);
      }

      const response = await this.apiGet(
        `${this.BASE_URL}/commentThreads?${params.toString()}`,
        auth
      );

      if (!response.ok) {
        // Comments may be disabled — not a fatal error
        if (response.status === 403) break;
        throw new Error(
          `YouTube Comments API error (${response.status}): ${await response.text()}`
        );
      }

      const data = (await response.json()) as YouTubeCommentThreadResponse;
      allComments.push(...data.items);

      pageToken = data.nextPageToken;
      if (!pageToken) break;

      pages++;
      await this.sleep(this.RATE_LIMIT_MS);
    }

    return allComments;
  }

  // -------------------------------------------------------------------------
  // Transcript fetching (no external packages)
  // -------------------------------------------------------------------------

  private async fetchTranscript(videoId: string): Promise<string | null> {
    try {
      // Fetch the YouTube watch page HTML
      const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
      const response = await fetch(watchUrl, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });

      if (!response.ok) return null;

      const html = await response.text();

      // Extract captionTracks from ytInitialPlayerResponse
      const captionTracks = this.extractCaptionTracks(html);
      if (!captionTracks || captionTracks.length === 0) return null;

      // Prefer English, fall back to first available
      const englishTrack = captionTracks.find(
        (t) => t.languageCode === 'en' || t.languageCode.startsWith('en-')
      );
      const track = englishTrack ?? captionTracks[0];

      // Fetch the timedtext XML
      const captionResponse = await fetch(track.baseUrl);
      if (!captionResponse.ok) return null;

      const captionXml = await captionResponse.text();
      return this.parseTimedTextXml(captionXml);
    } catch {
      return null;
    }
  }

  private extractCaptionTracks(html: string): CaptionTrack[] | null {
    // Look for ytInitialPlayerResponse in the page
    const playerResponseMatch = html.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\});/s);
    if (!playerResponseMatch) return null;

    try {
      const playerResponse = JSON.parse(playerResponseMatch[1]) as {
        captions?: {
          playerCaptionsTracklistRenderer?: {
            captionTracks?: Array<{
              baseUrl: string;
              languageCode: string;
            }>;
          };
        };
      };

      const tracks = playerResponse.captions?.playerCaptionsTracklistRenderer?.captionTracks;
      if (!tracks || tracks.length === 0) return null;

      return tracks.map((t) => ({
        baseUrl: t.baseUrl,
        languageCode: t.languageCode,
      }));
    } catch {
      return null;
    }
  }

  private parseTimedTextXml(xml: string): string | null {
    // Extract text from <text> elements in the timedtext XML
    // Format: <text start="0.0" dur="2.0">caption text here</text>
    const textSegments: string[] = [];
    const textRegex = /<text[^>]*>([\s\S]*?)<\/text>/g;
    let match: RegExpExecArray | null;

    while ((match = textRegex.exec(xml)) !== null) {
      let text = match[1];
      // Decode HTML entities in a single pass so '&amp;lt;' does not become '<'.
      text = text.replace(
        /&(amp|lt|gt|quot|apos|#39|#(\d+));/g,
        (_match, name, numeric) => {
          switch (name) {
            case 'amp':
              return '&';
            case 'lt':
              return '<';
            case 'gt':
              return '>';
            case 'quot':
              return '"';
            case 'apos':
            case '#39':
              return "'";
            default:
              return numeric ? String.fromCharCode(parseInt(numeric, 10)) : '';
          }
        }
      );
      // Strip any remaining HTML tags (loop to handle nested/broken markup
      // like '<<script>script>' that a single pass would leave behind).
      let previous: string;
      do {
        previous = text;
        text = text.replace(/<[^>]*>/g, '');
      } while (text !== previous);
      const trimmed = text.trim();
      if (trimmed) {
        textSegments.push(trimmed);
      }
    }

    if (textSegments.length === 0) return null;
    return textSegments.join(' ');
  }

  // -------------------------------------------------------------------------
  // Utilities
  // -------------------------------------------------------------------------

  /** Fetch a YouTube API URL with auth (OAuth token or API key). */
  private async apiGet(
    url: string,
    auth: { accessToken?: string; apiKey?: string }
  ): Promise<Response> {
    const parsedUrl = new URL(url);
    if (auth.apiKey && !auth.accessToken) {
      parsedUrl.searchParams.set('key', auth.apiKey);
    }
    const headers: Record<string, string> = {};
    if (auth.accessToken) {
      headers.Authorization = `Bearer ${auth.accessToken}`;
    }
    return fetch(parsedUrl.toString(), { headers });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

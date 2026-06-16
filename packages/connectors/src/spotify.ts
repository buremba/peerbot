/**
 * Spotify Connector (V1 runtime)
 *
 * Syncs saved tracks, playlists, recently played, and top tracks from Spotify.
 * Requires OAuth with user-scoped tokens.
 */

import {
  type ConnectorDefinition,
  ConnectorRuntime,
  createHttpClient,
  type EventEnvelope,
  type HttpClient,
  paginateByCursor,
  paginateByOffset,
  type SyncContext,
  type SyncResult,
} from '@lobu/connector-sdk';

// ---------------------------------------------------------------------------
// Spotify API types
// ---------------------------------------------------------------------------

interface SpotifyArtist {
  id: string;
  name: string;
  external_urls: { spotify: string };
}

interface SpotifyImage {
  url: string;
  height: number | null;
  width: number | null;
}

interface SpotifyAlbum {
  id: string;
  name: string;
  images: SpotifyImage[];
  release_date: string;
  external_urls: { spotify: string };
}

interface SpotifyTrack {
  /**
   * Spotify catalog track id. Null for local files and unavailable tracks —
   * use `trackKey()` for a stable per-track identifier, never `track.id`
   * directly in an origin_id (otherwise every local track collides on
   * `..._track_null` and supersedes the others).
   */
  id: string | null;
  name: string;
  artists: SpotifyArtist[];
  album: SpotifyAlbum;
  duration_ms: number;
  popularity: number;
  explicit: boolean;
  external_urls: { spotify: string };
  uri: string;
  preview_url: string | null;
}

interface SpotifyPagingResponse<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
  next: string | null;
  previous: string | null;
}

interface SpotifySavedTrack {
  added_at: string;
  track: SpotifyTrack;
}

interface SpotifyPlaylist {
  id: string;
  name: string;
  description: string | null;
  public: boolean | null;
  collaborative: boolean;
  owner: { id: string; display_name: string | null };
  tracks: { total: number; href: string };
  images: SpotifyImage[];
  external_urls: { spotify: string };
}

interface SpotifyPlaylistTrackItem {
  added_at: string;
  added_by: { id: string };
  track: SpotifyTrack | null;
}

interface SpotifyRecentlyPlayedItem {
  track: SpotifyTrack;
  played_at: string;
  context: { type: string; uri: string; external_urls: { spotify: string } } | null;
}

interface SpotifyRecentlyPlayedResponse {
  items: SpotifyRecentlyPlayedItem[];
  cursors: { after: string; before: string } | null;
  next: string | null;
}

interface SpotifyCheckpoint {
  last_sync_at?: string;
  offset?: number;
  cursor?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function artistNames(artists: SpotifyArtist[]): string {
  return artists.map((a) => a.name).join(', ');
}

/**
 * Stable per-track identifier for origin_ids. Spotify omits `id` for local
 * files and unavailable tracks; falling back to the always-present `uri`
 * (e.g. `spotify:local:...`) keeps each track distinct. Without this, every
 * id-less track collapses onto `..._track_null` and the dedup path supersedes
 * them down to a single surviving row (silent data loss).
 */
export function trackKey(track: { id: string | null; uri: string }): string {
  return track.id ?? track.uri;
}

function albumArt(images: SpotifyImage[]): string | undefined {
  return images[0]?.url;
}

// ---------------------------------------------------------------------------
// Connector
// ---------------------------------------------------------------------------

export default class SpotifyConnector extends ConnectorRuntime {
  readonly definition: ConnectorDefinition = {
    key: 'spotify',
    name: 'Spotify',
    description: 'Syncs saved tracks, playlists, recently played, and top tracks from Spotify.',
    version: '1.0.0',
    faviconDomain: 'spotify.com',
    authSchema: {
      methods: [
        {
          type: 'oauth',
          provider: 'spotify',
          authorizationUrl: 'https://accounts.spotify.com/authorize',
          tokenUrl: 'https://accounts.spotify.com/api/token',
          userinfoUrl: 'https://api.spotify.com/v1/me',
          tokenEndpointAuthMethod: 'client_secret_basic',
          requiredScopes: [
            'user-read-private',
            'user-read-email',
            'user-library-read',
            'user-top-read',
            'user-read-recently-played',
            'playlist-read-private',
          ],
          loginScopes: ['user-read-private', 'user-read-email'],
          clientIdKey: 'SPOTIFY_CLIENT_ID',
          clientSecretKey: 'SPOTIFY_CLIENT_SECRET',
          loginProvisioning: {
            autoCreateConnection: true,
          },
          setupInstructions:
            'Create a Spotify App at https://developer.spotify.com/dashboard — add {{redirect_uri}} as a Redirect URI, then copy the client ID and secret below.',
        },
      ],
    },
    feeds: {
      saved_tracks: {
        key: 'saved_tracks',
        name: 'Saved Tracks',
        description: 'Your liked/saved tracks on Spotify.',
        displayNameTemplate: 'Saved Tracks',
        requiredScopes: ['user-library-read'],
        eventKinds: {
          track: {
            description: 'A saved Spotify track',
            metadataSchema: {
              type: 'object',
              properties: {
                artist: { type: 'string' },
                album: { type: 'string' },
                album_art_url: { type: 'string', format: 'uri' },
                duration_ms: { type: 'number' },
                popularity: { type: 'number' },
                explicit: { type: 'boolean' },
                release_date: { type: 'string' },
              },
            },
          },
        },
      },
      playlists: {
        key: 'playlists',
        name: 'Playlists',
        description: 'Your playlists and their tracks.',
        displayNameTemplate: 'Playlists',
        requiredScopes: ['playlist-read-private'],
        eventKinds: {
          playlist: {
            description: 'A Spotify playlist',
            metadataSchema: {
              type: 'object',
              properties: {
                track_count: { type: 'number' },
                public: { type: 'boolean' },
                collaborative: { type: 'boolean' },
                owner: { type: 'string' },
              },
            },
          },
          playlist_track: {
            description: 'A track within a Spotify playlist',
            metadataSchema: {
              type: 'object',
              properties: {
                playlist_id: { type: 'string' },
                playlist_name: { type: 'string' },
                artist: { type: 'string' },
                album: { type: 'string' },
                added_at: { type: 'string' },
                added_by: { type: 'string' },
              },
            },
          },
        },
      },
      recently_played: {
        key: 'recently_played',
        name: 'Recently Played',
        description: 'Your recently played tracks.',
        displayNameTemplate: 'Recently Played',
        requiredScopes: ['user-read-recently-played'],
        eventKinds: {
          play: {
            description: 'A recently played track',
            metadataSchema: {
              type: 'object',
              properties: {
                artist: { type: 'string' },
                album: { type: 'string' },
                duration_ms: { type: 'number' },
                context_type: { type: 'string' },
                context_uri: { type: 'string' },
              },
            },
          },
        },
      },
      top_tracks: {
        key: 'top_tracks',
        name: 'Top Tracks',
        description: 'Your top tracks by listening frequency.',
        displayNameTemplate: 'Top Tracks ({time_range})',
        requiredScopes: ['user-top-read'],
        configSchema: {
          type: 'object',
          properties: {
            time_range: {
              type: 'string',
              enum: ['short_term', 'medium_term', 'long_term'],
              default: 'medium_term',
              description:
                'Time range: short_term (~4 weeks), medium_term (~6 months), long_term (all time).',
            },
          },
        },
        eventKinds: {
          top_track: {
            description: 'A top track by listening frequency',
            metadataSchema: {
              type: 'object',
              properties: {
                artist: { type: 'string' },
                album: { type: 'string' },
                popularity: { type: 'number' },
                rank: { type: 'number' },
                time_range: { type: 'string' },
              },
            },
          },
        },
      },
    },
  };

  private readonly API_BASE = 'https://api.spotify.com/v1';
  private readonly PAGE_SIZE = 50;
  private readonly MAX_PAGES = 20;

  // -------------------------------------------------------------------------
  // sync
  // -------------------------------------------------------------------------

  async sync(ctx: SyncContext): Promise<SyncResult> {
    const accessToken = ctx.credentials?.accessToken;
    if (!accessToken) {
      throw new Error('Spotify requires OAuth authentication.');
    }

    const http = createHttpClient({
      getAccessToken: () => accessToken,
      errorPrefix: 'Spotify API',
    });

    switch (ctx.feedKey) {
      case 'saved_tracks':
        return this.syncSavedTracks(ctx, http);
      case 'playlists':
        return this.syncPlaylists(ctx, http);
      case 'recently_played':
        return this.syncRecentlyPlayed(ctx, http);
      case 'top_tracks':
        return this.syncTopTracks(ctx, http);
      default:
        throw new Error(`Unknown feed: ${ctx.feedKey}`);
    }
  }

  // -------------------------------------------------------------------------
  // execute
  // -------------------------------------------------------------------------
  // -------------------------------------------------------------------------
  // Feed: saved_tracks
  // -------------------------------------------------------------------------

  private async syncSavedTracks(ctx: SyncContext, http: HttpClient): Promise<SyncResult> {
    const events: EventEnvelope[] = [];

    const pages = paginateByOffset(
      async (offset) => {
        const data = await http.get<SpotifyPagingResponse<SpotifySavedTrack>>(
          `${this.API_BASE}/me/tracks?limit=${this.PAGE_SIZE}&offset=${offset}`
        );
        return { items: data.items, hasMore: !!data.next };
      },
      { pageSize: this.PAGE_SIZE, maxPages: this.MAX_PAGES }
    );

    for await (const items of pages) {
      for (const item of items) {
        const track = item.track;
        events.push({
          origin_id: `spotify_track_${trackKey(track)}`,
          title: track.name,
          payload_text: `${track.name} by ${artistNames(track.artists)} — ${track.album.name}`,
          author_name: artistNames(track.artists),
          source_url: track.external_urls.spotify,
          occurred_at: new Date(item.added_at),
          origin_type: 'track',
          metadata: {
            artist: artistNames(track.artists),
            album: track.album.name,
            album_art_url: albumArt(track.album.images),
            duration_ms: track.duration_ms,
            popularity: track.popularity,
            explicit: track.explicit,
            release_date: track.album.release_date,
          },
        });
      }

      if (ctx.emitEvents) await ctx.emitEvents(events.splice(0));
    }

    return {
      events,
      checkpoint: { last_sync_at: new Date().toISOString() } satisfies SpotifyCheckpoint as Record<
        string,
        unknown
      >,
    };
  }

  // -------------------------------------------------------------------------
  // Feed: playlists
  // -------------------------------------------------------------------------

  private async syncPlaylists(ctx: SyncContext, http: HttpClient): Promise<SyncResult> {
    const events: EventEnvelope[] = [];

    // First, fetch all playlists
    const playlists: SpotifyPlaylist[] = [];
    const playlistPages = paginateByOffset(
      async (offset) => {
        const data = await http.get<SpotifyPagingResponse<SpotifyPlaylist>>(
          `${this.API_BASE}/me/playlists?limit=${this.PAGE_SIZE}&offset=${offset}`
        );
        return { items: data.items, hasMore: !!data.next };
      },
      { pageSize: this.PAGE_SIZE, maxPages: this.MAX_PAGES }
    );
    for await (const items of playlistPages) {
      playlists.push(...items);
    }

    // Emit playlist events
    for (const pl of playlists) {
      events.push({
        origin_id: `spotify_playlist_${pl.id}`,
        title: pl.name,
        payload_text: pl.description ?? pl.name,
        author_name: pl.owner.display_name ?? pl.owner.id,
        source_url: pl.external_urls.spotify,
        occurred_at: new Date(),
        origin_type: 'playlist',
        metadata: {
          track_count: pl.tracks.total,
          public: pl.public,
          collaborative: pl.collaborative,
          owner: pl.owner.display_name ?? pl.owner.id,
        },
      });
    }

    if (ctx.emitEvents) await ctx.emitEvents(events.splice(0));

    // Then fetch tracks for each playlist
    for (const pl of playlists) {
      const trackPages = paginateByOffset(
        async (offset) => {
          const data = await http.get<SpotifyPagingResponse<SpotifyPlaylistTrackItem>>(
            `${this.API_BASE}/playlists/${pl.id}/tracks?limit=${this.PAGE_SIZE}&offset=${offset}`
          );
          return { items: data.items, hasMore: !!data.next };
        },
        { pageSize: this.PAGE_SIZE, maxPages: this.MAX_PAGES }
      );

      for await (const items of trackPages) {
        const trackEvents: EventEnvelope[] = [];
        for (const item of items) {
          if (!item.track) continue;
          const track = item.track;
          trackEvents.push({
            origin_id: `spotify_pl_${pl.id}_track_${trackKey(track)}`,
            title: track.name,
            payload_text: `${track.name} by ${artistNames(track.artists)}`,
            author_name: artistNames(track.artists),
            source_url: track.external_urls.spotify,
            occurred_at: new Date(item.added_at),
            origin_type: 'playlist_track',
            origin_parent_id: `spotify_playlist_${pl.id}`,
            metadata: {
              playlist_id: pl.id,
              playlist_name: pl.name,
              artist: artistNames(track.artists),
              album: track.album.name,
              added_at: item.added_at,
              added_by: item.added_by.id,
            },
          });
        }

        if (ctx.emitEvents) await ctx.emitEvents(trackEvents);
        else events.push(...trackEvents);
      }
    }

    return {
      events,
      checkpoint: { last_sync_at: new Date().toISOString() } satisfies SpotifyCheckpoint as Record<
        string,
        unknown
      >,
    };
  }

  // -------------------------------------------------------------------------
  // Feed: recently_played
  // -------------------------------------------------------------------------

  private async syncRecentlyPlayed(ctx: SyncContext, http: HttpClient): Promise<SyncResult> {
    const events: EventEnvelope[] = [];
    const checkpoint = (ctx.checkpoint ?? {}) as SpotifyCheckpoint;
    let firstUrl = `${this.API_BASE}/me/player/recently-played?limit=${this.PAGE_SIZE}`;

    // Resume from last cursor if available
    if (checkpoint.cursor) {
      firstUrl += `&after=${checkpoint.cursor}`;
    }

    let newCursor: string | undefined;

    // Spotify paginates recently-played via full `next` URLs, so the cursor is the page URL.
    const pages = paginateByCursor<SpotifyRecentlyPlayedItem, string>(
      async (url) => {
        const data = await http.get<SpotifyRecentlyPlayedResponse>(url ?? firstUrl);
        // Store the latest cursor for next sync
        if (data.cursors?.after) {
          newCursor = data.cursors.after;
        }
        return { items: data.items, nextCursor: data.next };
      },
      { maxPages: this.MAX_PAGES, initialCursor: firstUrl }
    );

    for await (const items of pages) {
      for (const item of items) {
        const track = item.track;
        const playedAt = new Date(item.played_at);
        events.push({
          origin_id: `spotify_play_${trackKey(track)}_${playedAt.getTime()}`,
          title: track.name,
          payload_text: `${track.name} by ${artistNames(track.artists)}`,
          author_name: artistNames(track.artists),
          source_url: track.external_urls.spotify,
          occurred_at: playedAt,
          origin_type: 'play',
          metadata: {
            artist: artistNames(track.artists),
            album: track.album.name,
            duration_ms: track.duration_ms,
            context_type: item.context?.type,
            context_uri: item.context?.uri,
          },
        });
      }

      if (ctx.emitEvents) await ctx.emitEvents(events.splice(0));
    }

    return {
      events,
      checkpoint: {
        last_sync_at: new Date().toISOString(),
        ...(newCursor && { cursor: newCursor }),
      } satisfies SpotifyCheckpoint as Record<string, unknown>,
    };
  }

  // -------------------------------------------------------------------------
  // Feed: top_tracks
  // -------------------------------------------------------------------------

  private async syncTopTracks(ctx: SyncContext, http: HttpClient): Promise<SyncResult> {
    const timeRange = (ctx.config.time_range as string) ?? 'medium_term';
    const events: EventEnvelope[] = [];
    let rank = 1;
    // UTC-midnight bucket so re-syncs within the same day dedup (see occurred_at below).
    const snapshotDay = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);

    const pages = paginateByOffset(
      async (offset) => {
        const data = await http.get<SpotifyPagingResponse<SpotifyTrack>>(
          `${this.API_BASE}/me/top/tracks?time_range=${timeRange}&limit=${this.PAGE_SIZE}&offset=${offset}`
        );
        return { items: data.items, hasMore: !!data.next };
      },
      { pageSize: this.PAGE_SIZE, maxPages: this.MAX_PAGES }
    );

    for await (const items of pages) {
      for (const track of items) {
        events.push({
          origin_id: `spotify_top_${timeRange}_${trackKey(track)}`,
          title: `#${rank} ${track.name}`,
          payload_text: `${track.name} by ${artistNames(track.artists)} — ${track.album.name}`,
          author_name: artistNames(track.artists),
          source_url: track.external_urls.spotify,
          // Day-bucketed snapshot time. A bare `new Date()` makes every sync
          // look new (occurred_at always differs), so an unchanged top-tracks
          // ranking supersedes itself on each run and the events table grows
          // unbounded with masked rows. Bucketing to UTC midnight lets an
          // identical same-day snapshot dedup while still recording the new
          // ranking whenever it actually shifts.
          occurred_at: snapshotDay,
          origin_type: 'top_track',
          metadata: {
            artist: artistNames(track.artists),
            album: track.album.name,
            popularity: track.popularity,
            rank,
            time_range: timeRange,
          },
        });
        rank++;
      }

      if (ctx.emitEvents) await ctx.emitEvents(events.splice(0));
    }

    return {
      events,
      checkpoint: { last_sync_at: new Date().toISOString() } satisfies SpotifyCheckpoint as Record<
        string,
        unknown
      >,
    };
  }
}

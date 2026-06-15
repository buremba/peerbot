/**
 * Apple Photos Connector (V1 runtime) — Lobu Mac app.
 *
 * Runs on a Mac advertising the `photos` capability. The bridge holds the
 * `NSPhotoLibraryUsageDescription` Info.plist string and prompts the user via
 * TCC the first time a job is claimed. Once granted, PhotoKit exposes the
 * user's local Photos library — which is mirrored from iCloud Photos when
 * that's enabled — including the rich metadata Google's Photos Library API
 * does NOT expose: location (lat/lng), people (Apple's on-device face
 * recognition), albums, captions, keywords, and Vision OCR text.
 *
 * One feed in v1:
 *
 * - `library`: every PHAsset in the user's library, with stable origin ids
 *   derived from the asset's localIdentifier. Re-runs upsert by origin id.
 *
 * v1 ingests metadata + remote references (asset_local_id, asset_cloud_id,
 * source_url for the photos.apple.com deep link). The actual image bytes
 * are NOT embedded in events; future connector actions (`fetch_thumbnail`,
 * `fetch_original`) will let an agent pull bytes on demand via the Mac
 * worker.
 *
 * The connector DEFINITION here is the source of truth for shape; EXECUTION
 * lives in the Mac app's PhotosSyncService, which polls /api/workers/* with
 * `photos: true` and streams events back through the standard worker
 * protocol — same `runs` lifecycle as every other device-bound connector.
 *
 * The TS sync()/execute() are safety stubs: if a server-side worker somehow
 * bypassed the capability gate (`required_capability='photos'`), the run
 * throws immediately instead of silently producing zero events.
 */

import {
  type ActionResult,
  type ConnectorDefinition,
  ConnectorRuntime,
  type SyncContext,
  type SyncResult,
} from '@lobu/connector-sdk';

const BRIDGE_ONLY_MESSAGE =
  'apple.photos runs only on a worker advertising capability "photos" (Lobu Mac app with Photos permission). ' +
  'This run was claimed by a worker without that capability — check connector_definitions.required_capability and the poll-time capability filter.';

export default class ApplePhotosConnector extends ConnectorRuntime {
  readonly definition: ConnectorDefinition = {
    key: 'apple.photos',
    name: 'Apple Photos',
    description:
      'Sync your Photos library (local or iCloud-mirrored) from the Lobu Mac app. ' +
      'Includes location, people, albums, captions, keywords, and Vision OCR text — ' +
      'data Google Photos\' API does not expose.',
    version: '0.1.0',
    faviconDomain: 'apple.com',
    requiredCapability: 'photos',
    runtime: {
      platforms: ['macos'],
      scopes: ['date', 'location', 'people', 'albums', 'captions', 'keywords', 'ocr'],
    },
    authSchema: {
      methods: [{ type: 'none' }],
    },
    feeds: {
      library: {
        key: 'library',
        name: 'Library',
        description:
          'Every photo in your library. Each event carries the photo\'s metadata ' +
          '(date taken, location, people, albums, captions, OCR text) plus stable ' +
          'asset identifiers so agents can fetch the image bytes on demand.',
        configSchema: {
          type: 'object',
          properties: {
            backfill_days: {
              type: 'integer',
              minimum: 1,
              maximum: 36500,
              default: 3650,
              description:
                'How many days back the bridge backfills on a fresh sync. Default 10 years; ' +
                'incremental runs only re-query the modification window since last_sync_at.',
            },
            include_screenshots: {
              type: 'boolean',
              default: true,
              description: 'Include screenshots (PHAssetMediaSubtype.photoScreenshot).',
            },
            include_videos: {
              type: 'boolean',
              default: false,
              description: 'Include video assets in addition to photos.',
            },
          },
        },
        eventKinds: {
          photo: {
            description:
              'A single photo (or video, if enabled) from the user\'s Apple Photos library. ' +
              'v1 (this PR) populates: asset_local_id, media_type, media_subtypes, ' +
              'date_taken, date_modified, width, height, duration_s, latitude/longitude/altitude_m, ' +
              'albums, is_favorite, is_hidden — everything PhotoKit\'s public API exposes. ' +
              'v2 will add: asset_cloud_id, place_name (reverse geocoding), people, ' +
              'keywords, caption, ocr_text — all of which require direct reads against ' +
              'the Photos.sqlite bundle (FDA + schema-pinned, osxphotos-style). ' +
              'Schema allows nulls so v1 events validate cleanly.',
            metadataSchema: {
              type: 'object',
              required: ['source', 'origin_id', 'asset_local_id'],
              properties: {
                source: { type: 'string', const: 'apple_photos' },
                origin_id: { type: 'string' },
                asset_local_id: {
                  type: 'string',
                  description: 'PHAsset.localIdentifier — stable per-device handle.',
                },
                asset_cloud_id: {
                  type: ['string', 'null'],
                  description: 'iCloud asset id when synced via iCloud Photos.',
                },
                media_type: {
                  type: 'string',
                  enum: ['image', 'video', 'audio', 'unknown'],
                },
                media_subtypes: {
                  type: 'array',
                  items: { type: 'string' },
                  description:
                    'PHAssetMediaSubtype flags: live, hdr, screenshot, panorama, portrait, etc.',
                },
                date_taken: { type: ['string', 'null'], format: 'date-time' },
                date_modified: { type: ['string', 'null'], format: 'date-time' },
                width: { type: ['integer', 'null'] },
                height: { type: ['integer', 'null'] },
                duration_s: {
                  type: ['number', 'null'],
                  description: 'Duration in seconds — videos and Live Photos only.',
                },
                latitude: { type: ['number', 'null'] },
                longitude: { type: ['number', 'null'] },
                altitude_m: { type: ['number', 'null'] },
                place_name: {
                  type: ['string', 'null'],
                  description:
                    'Reverse-geocoded human-readable place from CLGeocoder when available offline.',
                  // Device-populated (CLGeocoder/MKLocalSearch — Apple frameworks
                  // the server can't call). The gateway only backfills
                  // city/region/country via geo_lookup() when null; finer
                  // address/venue tiers must be filled in here, on-device.
                },
                people: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'Named-person tags from Apple\'s on-device face recognition.',
                },
                albums: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'User album names this asset belongs to.',
                },
                keywords: {
                  type: 'array',
                  items: { type: 'string' },
                },
                caption: { type: ['string', 'null'] },
                is_favorite: { type: 'boolean' },
                is_hidden: { type: 'boolean' },
              },
            },
          },
        },
      },
    },
  };

  async sync(_ctx: SyncContext): Promise<SyncResult> {
    throw new Error(BRIDGE_ONLY_MESSAGE);
  }

  async execute(): Promise<ActionResult> {
    throw new Error(BRIDGE_ONLY_MESSAGE);
  }
}

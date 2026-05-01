/**
 * Google Photos Connector
 *
 * Reliable photo ingestion without browser scraping.
 *
 *   1. CDP grab (once per run): connect to the user's running Chrome and pull
 *      cookies via Network.getAllCookies at browser level. No tab attach, no
 *      page navigation — just cookies.
 *   2. Extract WIZ tokens (FdrFJe / cfb2h / SNlM0e) from photos.google.com HTML.
 *   3. Paginate the timeline with direct POSTs to the `lcxiM` batchexecute RPC
 *      (≈300 photos per call — GPS and place name included in the response).
 *   4. Parallel fill of EXIF for each photo via direct POSTs to `fDcn4b`.
 *
 * Requires Chrome running with remote debugging enabled on the worker host.
 */
import { createHash } from 'node:crypto';
import {
  type ActionContext,
  type ActionResult,
  type ConnectorDefinition,
  ConnectorRuntime,
  type EventEnvelope,
  resolveCdpUrl,
  type SyncContext,
  type SyncResult,
  sdkLogger,
} from '@lobu/connector-sdk';

// ── Types ──────────────────────────────────────────────────────

interface GooglePhotosCheckpoint {
  last_photo_id?: string;
  last_timestamp?: string;
  account_fingerprint?: string;
}

interface WizSession {
  sid: string;
  bl: string;
  at: string;
  cookieHeader: string;
  accountFingerprint: string;
}

interface TimelinePhoto {
  mediaKey: string;
  cdnUrl: string;
  width: number;
  height: number;
  dateTaken: Date;
  modifiedAt?: Date;
  latitude?: number;
  longitude?: number;
  locationName?: string;
  placeId?: string;
}

interface PhotoDetail {
  filename?: string;
  cameraMake?: string;
  cameraModel?: string;
  focalOrStop?: number;
  aperture?: number;
  iso?: number;
  shutterSec?: number;
  tzOffsetMin?: number;
}

// ── CDP cookie grab ────────────────────────────────────────────

const COOKIE_DOMAIN_SUFFIXES = ['google.com', 'googleusercontent.com'];

async function fetchCookiesViaCdp(cdpUrl: string): Promise<string> {
  const wsUrl = cdpUrl.startsWith('ws') ? cdpUrl : await resolveToWs(cdpUrl);
  sdkLogger.info({ wsUrl }, '[GooglePhotos] Opening CDP for cookie grab');

  const ws = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('CDP connect timeout')), 60000);
    ws.onopen = () => {
      clearTimeout(t);
      resolve();
    };
    ws.onerror = () => {
      clearTimeout(t);
      reject(new Error('CDP connect failed — is Chrome running with --remote-debugging-port?'));
    };
  });

  let msgId = 1;
  const sendBrowser = (method: string, params: Record<string, unknown> = {}): Promise<any> =>
    new Promise((resolve, reject) => {
      const id = msgId++;
      const t = setTimeout(() => reject(new Error(`${method} timeout`)), 30000);
      const handler = (e: MessageEvent) => {
        const data = JSON.parse(e.data as string);
        if (data.id !== id) return;
        clearTimeout(t);
        ws.removeEventListener('message', handler);
        data.error ? reject(new Error(data.error.message)) : resolve(data.result);
      };
      ws.addEventListener('message', handler);
      ws.send(JSON.stringify({ id, method, params }));
    });

  try {
    const { targetId } = await sendBrowser('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await sendBrowser('Target.attachToTarget', { targetId, flatten: true });

    const sendSession = (method: string, params: Record<string, unknown> = {}): Promise<any> =>
      new Promise((resolve, reject) => {
        const id = msgId++;
        const t = setTimeout(() => reject(new Error(`${method} timeout`)), 30000);
        const handler = (e: MessageEvent) => {
          const data = JSON.parse(e.data as string);
          if (data.id !== id) return;
          clearTimeout(t);
          ws.removeEventListener('message', handler);
          data.error ? reject(new Error(data.error.message)) : resolve(data.result);
        };
        ws.addEventListener('message', handler);
        ws.send(JSON.stringify({ id, method, params, sessionId }));
      });

    await sendSession('Network.enable');
    const { cookies } = await sendSession('Network.getAllCookies');
    await sendBrowser('Target.closeTarget', { targetId });

    const host = 'photos.google.com';
    const matched = (cookies as Array<{ name: string; value: string; domain: string }>).filter(
      (c) => {
        if (!c.domain) return false;
        const d = c.domain.startsWith('.') ? c.domain.slice(1) : c.domain;
        if (!COOKIE_DOMAIN_SUFFIXES.some((s) => d === s || d.endsWith(`.${s}`))) return false;
        // For cookie header: include if cookie applies to photos.google.com
        if (c.domain.startsWith('.')) {
          const s = c.domain.slice(1);
          return host === s || host.endsWith(`.${s}`);
        }
        return c.domain === host;
      }
    );
    sdkLogger.info({ n: matched.length }, '[GooglePhotos] cookies captured');
    return matched.map((c) => `${c.name}=${c.value}`).join('; ');
  } finally {
    ws.close();
  }
}

async function resolveToWs(httpUrl: string): Promise<string> {
  const { fetchCdpVersionInfo } = await import('@lobu/connector-sdk');
  const info = await fetchCdpVersionInfo(httpUrl);
  if (!info?.webSocketDebuggerUrl) {
    throw new Error(`CDP endpoint did not respond at ${httpUrl}`);
  }
  const parsed = new URL(httpUrl);
  const ws = new URL(info.webSocketDebuggerUrl);
  ws.hostname = parsed.hostname;
  ws.port = parsed.port;
  return ws.toString();
}

// ── Session bootstrap ──────────────────────────────────────────

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

/**
 * SAPISID is the per-Google-account master cookie; hashing it yields a stable
 * identifier for detecting account drift without leaking auth material if the
 * checkpoint is dumped.
 */
function accountFingerprintFromCookies(cookieHeader: string): string {
  const match = cookieHeader.match(/(?:^|;\s*)SAPISID=([^;]+)/);
  if (!match) throw new Error('SAPISID cookie missing — not signed in to Google.');
  return createHash('sha256').update(match[1]).digest('hex').slice(0, 16);
}

async function bootstrapSession(cookieHeader: string): Promise<WizSession> {
  const accountFingerprint = accountFingerprintFromCookies(cookieHeader);
  const res = await fetch('https://photos.google.com/', {
    headers: {
      cookie: cookieHeader,
      'user-agent': USER_AGENT,
      accept: 'text/html,application/xhtml+xml',
      'accept-language': 'en-US,en;q=0.9',
    },
  });
  const html = await res.text();
  const m = html.match(/window\.WIZ_global_data\s*=\s*(\{[\s\S]*?\});/);
  if (!m) {
    const title = html.match(/<title>([^<]*)/)?.[1] ?? '';
    throw new Error(
      `Google Photos session invalid (title="${title}"). Sign in at photos.google.com in Chrome first.`
    );
  }
  const wiz = JSON.parse(m[1]) as Record<string, unknown>;
  const sid = wiz.FdrFJe as string;
  const bl = wiz.cfb2h as string;
  const at = wiz.SNlM0e as string;
  if (!sid || !bl || !at) {
    throw new Error('WIZ tokens missing — auth flow may have changed.');
  }
  return { sid, bl, at, cookieHeader, accountFingerprint };
}

// ── batchexecute RPC helpers ───────────────────────────────────

function parseWrb(text: string): { rpcId: string; payload: unknown }[] {
  const out: { rpcId: string; payload: unknown }[] = [];
  const stripped = text.replace(/^\)\]\}'?\n+/, '');
  const nl = stripped.indexOf('\n');
  if (nl === -1) return out;
  const rest = stripped.substring(nl + 1);
  const jsonPart = rest.replace(/\n\d+\n.*$/s, '').trim();
  try {
    const outer = JSON.parse(jsonPart);
    for (const e of outer) {
      if (Array.isArray(e) && e[0] === 'wrb.fr' && typeof e[2] === 'string') {
        try {
          out.push({ rpcId: e[1] as string, payload: JSON.parse(e[2]) });
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* ignore */
  }
  return out;
}

let reqCounter = 100000;

class RpcAuthError extends Error {
  constructor(
    public status: number,
    rpcId: string
  ) {
    super(`${rpcId} auth failure HTTP ${status}`);
  }
}
class RpcTransientError extends Error {
  constructor(
    public status: number,
    rpcId: string
  ) {
    super(`${rpcId} transient HTTP ${status}`);
  }
}

async function rpcCallOnce<T>(
  rpcId: string,
  args: unknown[],
  sourcePath: string,
  s: WizSession
): Promise<T | null> {
  const reqid = ++reqCounter;
  const url =
    'https://photos.google.com/_/PhotosUi/data/batchexecute' +
    `?rpcids=${rpcId}` +
    `&source-path=${encodeURIComponent(sourcePath)}` +
    `&f.sid=${s.sid}&bl=${encodeURIComponent(s.bl)}` +
    `&hl=en&soc-app=165&soc-platform=1&soc-device=1&_reqid=${reqid}&rt=c`;
  const fReq = JSON.stringify([[[rpcId, JSON.stringify(args), null, '1']]]);
  const body = `f.req=${encodeURIComponent(fReq)}&at=${encodeURIComponent(s.at)}&`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
      cookie: s.cookieHeader,
      origin: 'https://photos.google.com',
      referer: 'https://photos.google.com/',
      'x-same-domain': '1',
      'user-agent': USER_AGENT,
    },
    body,
  });
  if (res.status === 401 || res.status === 403) throw new RpcAuthError(res.status, rpcId);
  if (res.status === 429 || res.status >= 500) throw new RpcTransientError(res.status, rpcId);
  if (!res.ok) throw new Error(`${rpcId} HTTP ${res.status}`);
  const text = await res.text();
  const match = parseWrb(text).find((e) => e.rpcId === rpcId);
  return (match?.payload as T) ?? null;
}

interface MutableSession {
  current: WizSession;
  refresh: () => Promise<WizSession>;
}

async function rpcCall<T>(
  rpcId: string,
  args: unknown[],
  sourcePath: string,
  ms: MutableSession
): Promise<T | null> {
  let refreshed = false;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await rpcCallOnce<T>(rpcId, args, sourcePath, ms.current);
    } catch (e) {
      if (e instanceof RpcAuthError) {
        if (refreshed) throw e;
        sdkLogger.warn(
          { rpcId, status: e.status },
          '[GooglePhotos] auth error — refreshing session'
        );
        ms.current = await ms.refresh();
        refreshed = true;
        continue;
      }
      if (e instanceof RpcTransientError) {
        if (attempt === 3) throw e;
        const delay = 500 * 2 ** attempt;
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw e;
    }
  }
  return null;
}

// ── Timeline (lcxiM) extractor ─────────────────────────────────

function extractTimelinePhoto(row: unknown): TimelinePhoto | null {
  if (!Array.isArray(row)) return null;
  const mediaKey = row[0];
  const img = row[1];
  const dt = row[2];
  if (typeof mediaKey !== 'string' || !Array.isArray(img) || typeof dt !== 'number') return null;
  const cdnUrl = img[0];
  const width = img[1];
  const height = img[2];
  if (typeof cdnUrl !== 'string' || typeof width !== 'number' || typeof height !== 'number') {
    return null;
  }

  const photo: TimelinePhoto = {
    mediaKey,
    cdnUrl,
    width,
    height,
    dateTaken: new Date(dt),
    ...(typeof row[5] === 'number' ? { modifiedAt: new Date(row[5]) } : {}),
  };

  const extras = row[9];
  if (extras && typeof extras === 'object' && !Array.isArray(extras)) {
    const loc = (extras as Record<string, unknown>)['129168200'];
    if (Array.isArray(loc) && Array.isArray(loc[1])) {
      const locData = loc[1] as unknown[];
      const coords = locData[0];
      if (Array.isArray(coords) && coords.length >= 2) {
        const lat = coords[0];
        const lng = coords[1];
        if (typeof lat === 'number' && typeof lng === 'number') {
          photo.latitude = lat / 1e7;
          photo.longitude = lng / 1e7;
        }
      }
      const placeInfo = locData[4];
      if (Array.isArray(placeInfo) && Array.isArray(placeInfo[0])) {
        const place = placeInfo[0] as unknown[];
        if (Array.isArray(place[1]) && Array.isArray(place[1][0])) {
          const name = (place[1][0] as unknown[])[0];
          if (typeof name === 'string') photo.locationName = name;
        }
        if (typeof place[2] === 'string') photo.placeId = place[2];
      }
    }
  }
  return photo;
}

async function paginateTimeline(
  ms: MutableSession,
  opts: { maxPages?: number; stopBefore?: Date }
): Promise<{
  photos: TimelinePhoto[];
  rowsSeen: number;
  rowsRejected: number;
  reachedCutoff: boolean;
  hitMaxPages: boolean;
  exhausted: boolean;
  apiCalls: number;
}> {
  const photos: TimelinePhoto[] = [];
  let cursor: string | null = null;
  let page = 0;
  let apiCalls = 0;
  let rowsSeen = 0;
  let rowsRejected = 0;
  let reachedCutoff = false;
  let exhausted = false;
  let hitMaxPages = false;

  while (true) {
    if (opts.maxPages != null && page >= opts.maxPages) {
      hitMaxPages = true;
      break;
    }
    const args: unknown[] = cursor ? [cursor] : [];
    apiCalls++;
    const payload = (await rpcCall('lcxiM', args, '/', ms)) as unknown[] | null;
    if (!Array.isArray(payload)) {
      exhausted = true;
      break;
    }

    const rows = Array.isArray(payload[0]) ? (payload[0] as unknown[]) : [];
    const nextCursor = typeof payload[1] === 'string' ? (payload[1] as string) : null;

    let hitStop = false;
    for (const r of rows) {
      rowsSeen++;
      const p = extractTimelinePhoto(r);
      if (!p) {
        rowsRejected++;
        continue;
      }
      if (opts.stopBefore && p.dateTaken <= opts.stopBefore) {
        hitStop = true;
        reachedCutoff = true;
        break;
      }
      photos.push(p);
    }

    if ((page + 1) % 10 === 0) {
      sdkLogger.info({ page: page + 1, photos: photos.length }, '[GooglePhotos] timeline progress');
    }
    page++;
    if (hitStop) break;
    if (!nextCursor) {
      exhausted = true;
      break;
    }
    cursor = nextCursor;
  }

  // A high reject rate means Google changed the row shape — loud signal so we
  // catch it before downstream consumers see a quiet drop in ingestion.
  if (rowsSeen > 100 && rowsRejected / rowsSeen > 0.2) {
    sdkLogger.warn(
      { rowsSeen, rowsRejected, rate: rowsRejected / rowsSeen },
      '[GooglePhotos] high extraction reject rate — lcxiM row shape may have changed'
    );
  }
  return { photos, rowsSeen, rowsRejected, reachedCutoff, hitMaxPages, exhausted, apiCalls };
}

// ── fDcn4b EXIF extractor ──────────────────────────────────────

function extractDetailFromFDcn4b(payload: unknown): PhotoDetail | null {
  if (!Array.isArray(payload)) return null;
  const root = Array.isArray(payload[0]) ? (payload[0] as unknown[]) : (payload as unknown[]);
  if (!Array.isArray(root)) return null;

  const get = (i: number) => root[i];
  const out: PhotoDetail = {};
  if (typeof get(2) === 'string' && (get(2) as string).length > 0) out.filename = get(2) as string;
  if (typeof get(4) === 'number') out.tzOffsetMin = Math.round((get(4) as number) / 60000);

  const exif = get(23);
  if (Array.isArray(exif)) {
    if (typeof exif[0] === 'string') out.cameraMake = exif[0] as string;
    if (typeof exif[1] === 'string') out.cameraModel = exif[1] as string;
    if (typeof exif[3] === 'number') out.focalOrStop = exif[3] as number;
    if (typeof exif[4] === 'number') out.aperture = exif[4] as number;
    if (typeof exif[5] === 'number') out.iso = exif[5] as number;
    if (typeof exif[6] === 'number') out.shutterSec = exif[6] as number;
  }
  return Object.keys(out).length ? out : null;
}

async function fillExif(
  photos: TimelinePhoto[],
  ms: MutableSession,
  concurrency: number
): Promise<{ results: Map<string, PhotoDetail>; transientFailures: number }> {
  const results = new Map<string, PhotoDetail>();
  let cursor = 0;
  let transientFailures = 0;
  let fatal: Error | null = null;

  async function worker() {
    while (cursor < photos.length && !fatal) {
      const idx = cursor++;
      const p = photos[idx];
      try {
        const payload = await rpcCall('fDcn4b', [p.mediaKey], `/photo/${p.mediaKey}`, ms);
        const d = extractDetailFromFDcn4b(payload);
        if (d) results.set(p.mediaKey, d);
      } catch (e) {
        if (e instanceof RpcAuthError) {
          fatal = e;
          return;
        }
        transientFailures++;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => worker()));
  if (fatal) throw fatal;
  return { results, transientFailures };
}

// ── Event envelope ─────────────────────────────────────────────

const VIDEO_EXT = /\.(mov|mp4|m4v|avi|mkv|webm|3gp)$/i;

function isVideo(exif?: PhotoDetail): boolean {
  return !!(exif?.filename && VIDEO_EXT.test(exif.filename));
}

function photoToEvent(p: TimelinePhoto, exif?: PhotoDetail): EventEnvelope {
  const cameraMake = exif?.cameraMake;
  const cameraModel = exif?.cameraModel;
  const video = isVideo(exif);
  return {
    origin_id: `gp_${p.mediaKey}`,
    title: exif?.filename || `Photo ${p.dateTaken.toISOString().split('T')[0]}`,
    payload_text: '',
    source_url: `https://photos.google.com/photo/${p.mediaKey}`,
    occurred_at: p.dateTaken,
    origin_type: video ? 'video' : 'photo',
    score: 0,
    metadata: {
      media_key: p.mediaKey,
      date_taken: p.dateTaken.toISOString(),
      cdn_url: p.cdnUrl,
      thumbnail_url: `${p.cdnUrl}=w400-h400`,
      width: p.width,
      height: p.height,
      is_video: video,
      ...(p.modifiedAt ? { modified_at: p.modifiedAt.toISOString() } : {}),
      ...(p.latitude != null ? { latitude: p.latitude } : {}),
      ...(p.longitude != null ? { longitude: p.longitude } : {}),
      ...(p.locationName ? { location_name: p.locationName } : {}),
      ...(p.placeId ? { place_id: p.placeId } : {}),
      ...(exif?.filename ? { filename: exif.filename } : {}),
      ...(cameraMake ? { camera_make: cameraMake } : {}),
      ...(cameraModel ? { camera_model: cameraModel } : {}),
      ...(exif?.aperture != null ? { aperture: exif.aperture } : {}),
      ...(exif?.iso != null ? { iso: exif.iso } : {}),
      ...(exif?.shutterSec != null ? { shutter_sec: exif.shutterSec } : {}),
      ...(exif?.focalOrStop != null ? { focal_or_stop: exif.focalOrStop } : {}),
      ...(exif?.tzOffsetMin != null ? { tz_offset_min: exif.tzOffsetMin } : {}),
    },
  };
}

// ── Connector ──────────────────────────────────────────────────

export default class GooglePhotosConnector extends ConnectorRuntime {
  readonly definition: ConnectorDefinition = {
    key: 'google_photos',
    name: 'Google Photos',
    description:
      'Ingests Google Photos metadata via direct batchexecute RPCs using cookies captured from a running Chrome session.',
    version: '6.1.0',
    faviconDomain: 'photos.google.com',
    authSchema: {
      methods: [
        {
          type: 'browser',
          capture: 'cdp',
          description:
            'Grabs session cookies from your running Chrome via Chrome DevTools Protocol. Chrome must be launched with --remote-debugging-port=9222 and signed in to Google Photos.',
          defaultCdpUrl: 'auto',
        },
      ],
    },
    feeds: {
      photos: {
        key: 'photos',
        name: 'Photos',
        description: 'Sync photo metadata from your Google Photos library.',
        configSchema: {
          type: 'object',
          properties: {
            max_pages: {
              type: 'integer',
              minimum: 1,
              description: 'Cap on lcxiM pages (≈300 photos each). Omit for full backfill.',
            },
            exif_limit: {
              type: 'integer',
              minimum: 0,
              default: 1000,
              description: 'Max photos to enrich with EXIF per run. Set 0 to skip EXIF.',
            },
            exif_concurrency: {
              type: 'integer',
              minimum: 1,
              maximum: 20,
              default: 10,
            },
          },
        },
        eventKinds: {
          photo: {
            description: 'A photo with metadata (date, dimensions, GPS, place, EXIF)',
            metadataSchema: {
              type: 'object',
              properties: {
                media_key: { type: 'string' },
                date_taken: { type: 'string' },
                modified_at: { type: 'string' },
                cdn_url: { type: 'string' },
                thumbnail_url: { type: 'string' },
                width: { type: 'number' },
                height: { type: 'number' },
                is_video: { type: 'boolean' },
                latitude: { type: 'number' },
                longitude: { type: 'number' },
                location_name: { type: 'string' },
                place_id: { type: 'string' },
                filename: { type: 'string' },
                camera_make: { type: 'string' },
                camera_model: { type: 'string' },
                aperture: { type: 'number' },
                iso: { type: 'number' },
                shutter_sec: { type: 'number' },
                focal_or_stop: { type: 'number' },
                tz_offset_min: { type: 'number' },
              },
            },
          },
          video: {
            description: 'A video with metadata (date, dimensions, GPS, place)',
            metadataSchema: {
              type: 'object',
              properties: {
                media_key: { type: 'string' },
                date_taken: { type: 'string' },
                modified_at: { type: 'string' },
                cdn_url: { type: 'string' },
                thumbnail_url: { type: 'string' },
                width: { type: 'number' },
                height: { type: 'number' },
                is_video: { type: 'boolean' },
                latitude: { type: 'number' },
                longitude: { type: 'number' },
                location_name: { type: 'string' },
                place_id: { type: 'string' },
                filename: { type: 'string' },
              },
            },
          },
        },
      },
    },
  };

  async sync(ctx: SyncContext): Promise<SyncResult> {
    const config = ctx.config as Record<string, unknown>;
    const checkpoint = (ctx.checkpoint ?? {}) as GooglePhotosCheckpoint;

    const cdpUrl = await resolveCdpUrl((ctx.sessionState as any)?.cdp_url || 'auto', {
      loggerLabel: 'GooglePhotos',
    });

    const bootstrap = async (): Promise<WizSession> => {
      const cookieHeader = await fetchCookiesViaCdp(cdpUrl);
      return bootstrapSession(cookieHeader);
    };

    const session = await bootstrap();
    sdkLogger.info(
      { accountFingerprint: session.accountFingerprint },
      '[GooglePhotos] session bootstrapped'
    );

    if (
      checkpoint.account_fingerprint &&
      checkpoint.account_fingerprint !== session.accountFingerprint
    ) {
      throw new Error(
        `Google account mismatch — checkpoint belongs to ${checkpoint.account_fingerprint}, ` +
          `current Chrome session is ${session.accountFingerprint}. ` +
          'Switch Chrome to the original account or create a new connection.'
      );
    }

    const ms: MutableSession = { current: session, refresh: bootstrap };

    const stopBefore = checkpoint.last_timestamp ? new Date(checkpoint.last_timestamp) : undefined;
    const maxPages = typeof config.max_pages === 'number' ? config.max_pages : undefined;

    const started = Date.now();
    const timeline = await paginateTimeline(ms, {
      ...(maxPages != null ? { maxPages } : {}),
      ...(stopBefore ? { stopBefore } : {}),
    });
    sdkLogger.info(
      {
        photos: timeline.photos.length,
        pages: timeline.apiCalls,
        exhausted: timeline.exhausted,
        hitMaxPages: timeline.hitMaxPages,
        reachedCutoff: timeline.reachedCutoff,
        ms: Date.now() - started,
      },
      '[GooglePhotos] timeline done'
    );

    const exifLimit = typeof config.exif_limit === 'number' ? config.exif_limit : 1000;
    const exifConcurrency =
      typeof config.exif_concurrency === 'number' ? config.exif_concurrency : 10;

    let exifMap: Map<string, PhotoDetail> = new Map();
    let exifFailures = 0;
    if (exifLimit > 0 && timeline.photos.length > 0) {
      const targets = timeline.photos.slice(0, exifLimit);
      const exifStart = Date.now();
      const exif = await fillExif(targets, ms, exifConcurrency);
      exifMap = exif.results;
      exifFailures = exif.transientFailures;
      sdkLogger.info(
        {
          enriched: exifMap.size,
          target: targets.length,
          transientFailures: exifFailures,
          ms: Date.now() - exifStart,
        },
        '[GooglePhotos] exif done'
      );
    }

    const events = timeline.photos.map((p) => photoToEvent(p, exifMap.get(p.mediaKey)));

    // Only advance checkpoint when we know we've seen everything newer than the
    // prior checkpoint. hitMaxPages with no cutoff means there are older photos
    // we didn't fetch — advancing would permanently skip them on the next run.
    const canAdvance = timeline.reachedCutoff || timeline.exhausted;
    const newest = timeline.photos[0];
    const newCheckpoint: GooglePhotosCheckpoint =
      canAdvance && newest
        ? {
            last_photo_id: newest.mediaKey,
            last_timestamp: newest.dateTaken.toISOString(),
            account_fingerprint: session.accountFingerprint,
          }
        : { ...checkpoint, account_fingerprint: session.accountFingerprint };

    const videoCount = events.filter((e) => e.origin_type === 'video').length;

    return {
      events,
      checkpoint: newCheckpoint as unknown as Record<string, unknown>,
      auth_update: {},
      metadata: {
        items_found: events.length,
        videos: videoCount,
        photos: events.length - videoCount,
        timeline_pages: timeline.apiCalls,
        rows_seen: timeline.rowsSeen,
        rows_rejected: timeline.rowsRejected,
        exif_fetched: exifMap.size,
        exif_transient_failures: exifFailures,
        reached_cutoff: timeline.reachedCutoff,
        exhausted: timeline.exhausted,
        hit_max_pages: timeline.hitMaxPages,
        checkpoint_advanced: canAdvance,
      },
    };
  }

  async execute(_ctx: ActionContext): Promise<ActionResult> {
    return { success: false, error: 'Actions not supported' };
  }
}

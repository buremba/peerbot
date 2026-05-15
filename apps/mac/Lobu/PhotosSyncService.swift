import Foundation
import Photos

/// Result of an `apple.photos` sync pass — events to stream plus the new
/// per-feed checkpoint (`last_sync_at` Unix seconds, used to bound the
/// modificationDate predicate on the next run).
struct PhotosOutput {
    let items: [WorkerStreamItem]
    let checkpoint: [String: AnyEncodable]
}

/// Handles `apple.photos` jobs via PhotoKit. Reads the user's Photos library
/// (local + iCloud-mirrored, transparent to PhotoKit) and emits one event per
/// PHAsset with all the metadata the public framework exposes:
///
/// - Date taken & modified, pixel dimensions, duration
/// - Location (CLLocation lat/lng/altitude) — present on photos with GPS in
///   EXIF; Google's Photos Library API strips this for non-app-uploaded media
/// - Media type + mediaSubtype flags (live, hdr, screenshot, panorama, …)
/// - User album membership (built once per run, then attached per asset)
/// - isFavorite, isHidden
///
/// Fields the public PhotoKit API does NOT expose — and which therefore stay
/// absent in v1 events — include named people (face recognition), captions,
/// keywords, and Vision OCR text. All of that lives in the Photos.sqlite
/// bundle and requires Full Disk Access + schema-pinned direct SQL reads
/// (the osxphotos approach). That extension is deliberate v2 work.
///
/// Incremental: the checkpoint stores `last_sync_at` (Unix seconds); the next
/// pass queries assets whose `modificationDate >= checkpoint - 1 day` so
/// late-arriving iCloud syncs (which can finish hours after the iPhone took
/// the shot) are picked up. Origin ids are derived from `localIdentifier`
/// which is stable per-device, so the server-side `onConflictUpdate` dedup
/// absorbs the overlap as no-op upserts.
enum PhotosSyncService {
    enum PhotosError: LocalizedError {
        case unauthorized
        case unsupportedFeed(String)
        var errorDescription: String? {
            switch self {
            case .unauthorized:
                return "Photos library access is not granted. Open System Settings → Privacy & Security → Photos and enable Lobu."
            case let .unsupportedFeed(key):
                return "Unknown apple.photos feed: \(key)"
            }
        }
    }

    /// Persisted once the user has been through the system permission sheet at
    /// least once. We surface the permission state in the menu bar based on
    /// `PHPhotoLibrary.authorizationStatus(for: .readWrite)`, so this flag
    /// only gates the "ask now" CTA.
    static let userDefaultsKey = "lobu.photosRequested"

    static var hasBeenRequested: Bool { UserDefaults.standard.bool(forKey: userDefaultsKey) }

    /// Photos is available on every macOS version Lobu supports — no
    /// entitlement gate (the Mac app is unsandboxed; TCC handles the prompt
    /// via NSPhotoLibraryUsageDescription in Info.plist).
    static func isAvailable() -> Bool { true }

    /// Whether the user has granted at least read access. Mirrors the values
    /// PhotoKit returns: `.authorized` and `.limited` both allow library
    /// queries (limited just returns a narrower asset set).
    static var isAuthorized: Bool {
        switch PHPhotoLibrary.authorizationStatus(for: .readWrite) {
        case .authorized, .limited: return true
        default: return false
        }
    }

    /// Outcome of `requestAuthorization()`:
    /// - `.granted` — the user said yes (or had previously said yes).
    /// - `.prompted` — the system sheet was shown but the user declined or
    ///   dismissed it. Calling again will re-prompt the next time TCC is
    ///   cleared, but not from the app itself.
    /// - `.blocked` — the bundle's TCC entry is already `.denied`/`.restricted`
    ///   so `requestAuthorization` returns without showing UI. The caller
    ///   should open System Settings → Privacy → Photos directly.
    enum AuthRequestOutcome { case granted, prompted, blocked }

    /// Open the Photos permission sheet — but only when there's actually a
    /// sheet to show. If TCC has a cached `.denied` decision, the system
    /// API silently returns without prompting; we report `.blocked` so the
    /// caller can deep-link the user to System Settings instead of leaving
    /// them tapping a button that does nothing.
    static func requestAuthorization() async -> AuthRequestOutcome {
        let priorStatus = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        if priorStatus == .denied || priorStatus == .restricted {
            return .blocked
        }
        let newStatus = await PHPhotoLibrary.requestAuthorization(for: .readWrite)
        UserDefaults.standard.set(true, forKey: userDefaultsKey)
        switch newStatus {
        case .authorized, .limited: return .granted
        default: return .prompted
        }
    }

    static func runPhotos(job: WorkerJob) async throws -> PhotosOutput {
        guard isAuthorized else { throw PhotosError.unauthorized }
        let passStartedAt = Int(Date().timeIntervalSince1970)

        let backfillDays = job.config?["backfill_days"]?.intValue ?? 3650
        let includeScreenshots = job.config?["include_screenshots"].flatMap(boolValue) ?? true
        let includeVideos = job.config?["include_videos"].flatMap(boolValue) ?? false

        // Sliding window: on the first run (no checkpoint) we query back
        // `backfillDays` from now. On incremental runs we query from
        // `last_sync_at - 1 day` so late-arriving iCloud writes that bump
        // modificationDate after the originating run still get picked up —
        // BUT never further back than `backfillStart`, otherwise a single
        // wide checkpoint reset would cost a full re-scan on every poll.
        let overlapSeconds: TimeInterval = 24 * 3600
        let backfillStart = Date().addingTimeInterval(-Double(backfillDays) * 24 * 3600)
        let incrementalStart = (job.checkpoint?["last_sync_at"]?.intValue).map {
            Date(timeIntervalSince1970: TimeInterval($0) - overlapSeconds)
        }
        let queryStart = max(backfillStart, incrementalStart ?? backfillStart)

        let items: [WorkerStreamItem]
        switch job.feed_key {
        case "library", .none:
            items = libraryItems(
                from: queryStart,
                includeScreenshots: includeScreenshots,
                includeVideos: includeVideos
            )
        case let other?:
            throw PhotosError.unsupportedFeed(other)
        }

        // Mirror HealthKit's behaviour: don't burn the backfill window if a
        // first run came back empty. Empty + no prior checkpoint = either
        // empty library or a delayed first-grant; either way leave the
        // checkpoint NULL and let the next pass retry the full window.
        let hadExistingCheckpoint = job.checkpoint?["last_sync_at"]?.intValue != nil
        return PhotosOutput(
            items: items,
            checkpoint: items.isEmpty && !hadExistingCheckpoint
                ? [:]
                : ["last_sync_at": AnyEncodable(passStartedAt)]
        )
    }

    // MARK: - library feed

    private static func libraryItems(
        from start: Date,
        includeScreenshots: Bool,
        includeVideos: Bool
    ) -> [WorkerStreamItem] {
        // 1) Build the asset fetch with a modificationDate window.
        let options = PHFetchOptions()
        options.predicate = NSPredicate(format: "modificationDate >= %@", start as NSDate)
        options.sortDescriptors = [NSSortDescriptor(key: "modificationDate", ascending: true)]

        // 2) Build the asset → [album name] map once. Iterating
        // PHAssetCollection per-asset would be O(n²); a single pass over
        // user albums collects membership lists.
        let albumMap = buildAlbumMap()

        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]

        var items: [WorkerStreamItem] = []
        let assets = PHAsset.fetchAssets(with: options)
        assets.enumerateObjects { asset, _, _ in
            // Filter by media type / subtype before doing the more expensive
            // metadata assembly.
            if asset.mediaType == .video && !includeVideos { return }
            if asset.mediaType == .audio { return }
            if asset.mediaSubtypes.contains(.photoScreenshot) && !includeScreenshots { return }

            if let item = makePhotoItem(
                asset: asset,
                albumMap: albumMap,
                iso: iso
            ) {
                items.append(item)
            }
        }
        return items
    }

    private static func makePhotoItem(
        asset: PHAsset,
        albumMap: [String: [String]],
        iso: ISO8601DateFormatter
    ) -> WorkerStreamItem? {
        let originId = "apple-photos:\(asset.localIdentifier)"
        let occurredDate = asset.creationDate ?? asset.modificationDate ?? Date()

        let dayFormatter = DateFormatter()
        dayFormatter.dateFormat = "yyyy-MM-dd"
        let day = dayFormatter.string(from: occurredDate)

        let title: String
        switch asset.mediaType {
        case .video: title = "Video · \(day)"
        case .audio: title = "Audio · \(day)"
        default:     title = "Photo · \(day)"
        }

        var parts: [String] = []
        parts.append("Taken on \(day)")
        if let loc = asset.location {
            parts.append(String(format: "Location: %.5f, %.5f", loc.coordinate.latitude, loc.coordinate.longitude))
        }
        let albums = albumMap[asset.localIdentifier] ?? []
        if !albums.isEmpty {
            parts.append("Albums: \(albums.joined(separator: ", "))")
        }
        if asset.isFavorite { parts.append("Favorite") }
        let payloadText = parts.joined(separator: ". ") + "."

        var metadata: [String: AnyEncodable] = [
            "source":         AnyEncodable("apple_photos"),
            "origin_id":      AnyEncodable(originId),
            "asset_local_id": AnyEncodable(asset.localIdentifier),
            "media_type":     AnyEncodable(mediaTypeName(asset.mediaType)),
            "media_subtypes": AnyEncodable(mediaSubtypeNames(asset.mediaSubtypes)),
            "is_favorite":    AnyEncodable(asset.isFavorite),
            "is_hidden":      AnyEncodable(asset.isHidden),
            "width":          AnyEncodable(asset.pixelWidth),
            "height":         AnyEncodable(asset.pixelHeight),
        ]
        if let created = asset.creationDate {
            metadata["date_taken"] = AnyEncodable(iso.string(from: created))
        }
        if let modified = asset.modificationDate {
            metadata["date_modified"] = AnyEncodable(iso.string(from: modified))
        }
        if asset.duration > 0 {
            metadata["duration_s"] = AnyEncodable(asset.duration)
        }
        if let loc = asset.location {
            metadata["latitude"]   = AnyEncodable(loc.coordinate.latitude)
            metadata["longitude"]  = AnyEncodable(loc.coordinate.longitude)
            metadata["altitude_m"] = AnyEncodable(loc.altitude)
        }
        if !albums.isEmpty {
            metadata["albums"] = AnyEncodable(albums)
        }

        return WorkerStreamItem(
            id: originId,
            title: title,
            payload_text: payloadText,
            occurred_at: iso.string(from: occurredDate),
            semantic_type: "photo",
            metadata: metadata
        )
    }

    /// Map of `PHAsset.localIdentifier → [album name]`. Built once per run
    /// across all user-created albums; iCloud Shared Albums are intentionally
    /// excluded (different lifecycle).
    private static func buildAlbumMap() -> [String: [String]] {
        var map: [String: [String]] = [:]
        let albums = PHAssetCollection.fetchAssetCollections(
            with: .album,
            subtype: .any,
            options: nil
        )
        albums.enumerateObjects { collection, _, _ in
            guard let name = collection.localizedTitle, !name.isEmpty else { return }
            let assets = PHAsset.fetchAssets(in: collection, options: nil)
            assets.enumerateObjects { asset, _, _ in
                map[asset.localIdentifier, default: []].append(name)
            }
        }
        return map
    }

    private static func mediaTypeName(_ type: PHAssetMediaType) -> String {
        switch type {
        case .image:   return "image"
        case .video:   return "video"
        case .audio:   return "audio"
        case .unknown: return "unknown"
        @unknown default: return "unknown"
        }
    }

    private static func mediaSubtypeNames(_ subtypes: PHAssetMediaSubtype) -> [String] {
        var out: [String] = []
        if subtypes.contains(.photoPanorama)         { out.append("panorama") }
        if subtypes.contains(.photoHDR)              { out.append("hdr") }
        if subtypes.contains(.photoScreenshot)       { out.append("screenshot") }
        if subtypes.contains(.photoLive)             { out.append("live") }
        if subtypes.contains(.photoDepthEffect)      { out.append("portrait") }
        if subtypes.contains(.videoStreamed)         { out.append("streamed") }
        if subtypes.contains(.videoHighFrameRate)    { out.append("high_frame_rate") }
        if subtypes.contains(.videoTimelapse)        { out.append("timelapse") }
        return out
    }

    /// Convenience: pull a Bool out of the AnyJSONValue config bag, accepting
    /// either a real bool or a 0/1 int (operators sometimes hand-write
    /// config JSON with integers).
    private static func boolValue(_ v: AnyJSONValue) -> Bool? {
        switch v {
        case let .bool(b):    return b
        case let .integer(i): return i != 0
        default:              return nil
        }
    }
}

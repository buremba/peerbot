import AVFoundation
import Foundation
import OSLog
import SQLite3

/// Reads new messages from WhatsApp Desktop's on-device archive at
/// `~/Library/Group Containers/group.net.whatsapp.WhatsApp.shared/ChatStorage.sqlite`
/// and emits WorkerStreamItems for the `whatsapp.local` connector.
///
/// Strategy:
///   1. Snapshot `ChatStorage.sqlite` + `-wal` + `-shm` into a temp directory.
///      WhatsApp Desktop keeps the live DB busy with WAL writes; copying the
///      WAL+SHM alongside the main file lets SQLite open the snapshot as if it
///      were a normal database, applying any pending WAL frames on open.
///   2. Walk `ZWAMESSAGE` rows where `Z_PK > checkpoint.last_pk`, joined to
///      `ZWACHATSESSION` / `ZWAGROUPINFO` / `ZWAMEDIAITEM` so each event carries
///      the chat partner, group context, and media type the agent needs.
///   3. Update the checkpoint to the highest `Z_PK` actually streamed. Failures
///      throw — `SyncDispatcher` leaves the checkpoint untouched so the next
///      run retries the same window.
enum WhatsAppLocalSyncService {
    struct Output {
        let items: [WorkerStreamItem]
        let checkpoint: [String: AnyEncodable]
    }

    enum ServiceError: LocalizedError {
        case databaseNotFound(String)
        case fullDiskAccessDenied
        case snapshotFailed(String)
        case sqlite(String)

        var errorDescription: String? {
            switch self {
            case let .databaseNotFound(path): return "WhatsApp Desktop archive not found at \(path)"
            case .fullDiskAccessDenied:
                return "Lobu needs Full Disk Access to read WhatsApp Desktop. Open System Settings → Privacy & Security → Full Disk Access, add Lobu, then try again."
            case let .snapshotFailed(detail): return "Couldn't snapshot the WhatsApp archive: \(detail)"
            case let .sqlite(detail): return "SQLite error: \(detail)"
            }
        }
    }

    /// Apple Core Data timestamps are seconds since 2001-01-01 UTC.
    private static let macEpochOffset: Double = 978307200

    /// Hard cap on a single voice note we'll inline into the stream payload.
    /// WhatsApp voice notes ~50–200KB for a 30-60s clip; anything over this is
    /// almost certainly not a voice note and we skip it to keep the JSON body
    /// bounded. The check is also a guard against arbitrary file reads (e.g.
    /// a malicious / corrupt `ZMEDIALOCALPATH` value pointing at a large file).
    private static let maxAudioAttachmentBytes = 2 * 1024 * 1024

    static func sourceDatabaseURL() -> URL {
        URL(fileURLWithPath: NSHomeDirectory())
            .appendingPathComponent("Library/Group Containers/group.net.whatsapp.WhatsApp.shared/ChatStorage.sqlite")
    }

    /// `ZWAMEDIAITEM.ZMEDIALOCALPATH` is relative to the `Message/` directory
    /// inside the WhatsApp Group Container. Resolves to e.g.
    /// `~/Library/Group Containers/group.net.whatsapp.WhatsApp.shared/Message/Media/<jid>/<id>.opus`.
    private static func mediaBaseURL() -> URL {
        URL(fileURLWithPath: NSHomeDirectory())
            .appendingPathComponent("Library/Group Containers/group.net.whatsapp.WhatsApp.shared/Message")
    }

    /// True if the WhatsApp Desktop archive is on disk and openable. The bridge
    /// uses this to gate the `whatsapp_local` capability — no archive ⇒ no
    /// claim attempt.
    static func isAvailable() -> Bool {
        FileManager.default.fileExists(atPath: sourceDatabaseURL().path)
    }

    static func runWhatsAppLocal(job: WorkerJob) throws -> Output {
        let sourceURL = sourceDatabaseURL()
        guard FileManager.default.fileExists(atPath: sourceURL.path) else {
            throw ServiceError.databaseNotFound(sourceURL.path)
        }

        let maxRows = max(1, min(500_000, job.config?["max_messages_per_sync"]?.intValue ?? 5_000))
        let chatFilter = job.config?["chat_filter"]?.stringValue ?? "all"
        let lastPK = job.checkpoint?["last_pk"]?.intValue ?? 0

        // Sweep stale snapshot dirs from prior crashed runs before claiming a
        // new one. The defer below cleans the happy path; a hard kill mid-sync
        // (OOM, force-quit, panic) leaves `lobu-whatsapp-<uuid>/` behind in
        // tmp, which accumulates over time. Anything older than an hour is
        // safe to remove — no live sync runs that long.
        sweepStaleSnapshotDirs()

        let snapshotDir = try makeSnapshotDir()
        defer { try? FileManager.default.removeItem(at: snapshotDir) }

        var schemaSurvey = SchemaSurvey()

        let snapshotURL = snapshotDir.appendingPathComponent("ChatStorage.sqlite")
        try copySQLiteFamily(from: sourceURL, to: snapshotURL)

        var dbHandle: OpaquePointer?
        let flags: Int32 = SQLITE_OPEN_READONLY | SQLITE_OPEN_NOMUTEX
        let openResult = sqlite3_open_v2(snapshotURL.path, &dbHandle, flags, nil)
        guard openResult == SQLITE_OK, let db = dbHandle else {
            let message = dbHandle.map { String(cString: sqlite3_errmsg($0)) } ?? "open returned \(openResult)"
            sqlite3_close(dbHandle)
            if openResult == SQLITE_AUTH || openResult == SQLITE_PERM {
                throw ServiceError.fullDiskAccessDenied
            }
            throw ServiceError.sqlite(message)
        }
        defer { sqlite3_close(db) }

        // ZFROMJID on WhatsApp Desktop is the anonymized `@lid` form, not the
        // phone JID — we read the real JID off the chat session (1:1) or the
        // group-member row (group). ZPUSHNAME on ZWAMESSAGE is a base64-encoded
        // protobuf and unsafe to surface as text, so we lean on ZPARTNERNAME and
        // ZWAGROUPMEMBER.ZCONTACTNAME (the same strings WA Desktop's UI shows).
        // ZSTARRED is the only non-baseline column we surface — it's a stable,
        // user-visible signal ("starred messages" in WA UI). Reactions, edits,
        // and revoke (delete-for-everyone) events are NOT exposed as columns
        // on the WA Desktop schema observed in the wild (Desktop versions
        // through late 2025): the underlying tables are ZWAMESSAGE +
        // ZWAMESSAGEINFO (receipt BLOB) + ZWAMEDIAITEM, with no ZWAREACTION /
        // ZEDITED* / ZREVOKED columns. Likely they live inside the protobuf
        // BLOB ZWAMESSAGEINFO.ZRECEIPTINFO or simply aren't persisted client-
        // side. The QR-paired `whatsapp` connector (Baileys) is the path for
        // those today — see the gap-tracking comment in `unfamiliarSchema`.
        let sql = """
        SELECT
          m.Z_PK,
          m.ZMESSAGEDATE,
          m.ZTEXT,
          m.ZTOJID,
          m.ZISFROMME,
          m.ZMESSAGETYPE,
          m.ZGROUPEVENTTYPE,
          m.ZSTANZAID,
          m.ZSTARRED,
          m.ZFLAGS,
          c.ZCONTACTJID,
          c.ZPARTNERNAME,
          c.ZSESSIONTYPE,
          c.ZGROUPINFO,
          gm.ZMEMBERJID,
          gm.ZCONTACTNAME,
          gm.ZFIRSTNAME,
          media.ZTITLE,
          media.ZMEDIALOCALPATH
        FROM ZWAMESSAGE m
        LEFT JOIN ZWACHATSESSION c ON c.Z_PK = m.ZCHATSESSION
        LEFT JOIN ZWAGROUPMEMBER gm ON gm.Z_PK = m.ZGROUPMEMBER
        LEFT JOIN ZWAMEDIAITEM media ON media.ZMESSAGE = m.Z_PK
        WHERE m.Z_PK > ?
        ORDER BY m.Z_PK ASC
        LIMIT ?;
        """

        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
            throw ServiceError.sqlite(String(cString: sqlite3_errmsg(db)))
        }
        defer { sqlite3_finalize(stmt) }
        sqlite3_bind_int64(stmt, 1, Int64(lastPK))
        sqlite3_bind_int(stmt, 2, Int32(maxRows))

        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]

        var items: [WorkerStreamItem] = []
        var highestPK = lastPK

        while sqlite3_step(stmt) == SQLITE_ROW {
            let pk = Int(sqlite3_column_int64(stmt, 0))
            let msgDate = sqlite3_column_double(stmt, 1)
            let text = cString(stmt, 2)
            let toJID = cString(stmt, 3)
            let isFromMe = sqlite3_column_int(stmt, 4) != 0
            let msgType = Int(sqlite3_column_int(stmt, 5))
            // Column 6 (ZGROUPEVENTTYPE) is selected so the SELECT shape stays
            // stable across schemas, but it's no longer a system-event signal
            // — see the `isSystemEvent` line below.
            let stanzaId = cString(stmt, 7)
            let isStarred = sqlite3_column_int(stmt, 8) != 0
            let zflags = sqlite3_column_int64(stmt, 9)
            let chatJID = cString(stmt, 10)
            let partnerName = cString(stmt, 11)
            let sessionType = Int(sqlite3_column_int(stmt, 12))
            let groupInfoPK = Int(sqlite3_column_int64(stmt, 13))
            let groupMemberJID = cString(stmt, 14)
            let groupMemberName = cString(stmt, 15)
            let groupMemberFirstName = cString(stmt, 16)
            let mediaTitle = cString(stmt, 17)
            let mediaPath = cString(stmt, 18)

            schemaSurvey.observe(messageType: msgType, flags: zflags)

            highestPK = max(highestPK, pk)

            // session_type 3 == status broadcasts ("@status"). Ignore by default;
            // they're noise for the agent, and the chat_filter doesn't have a
            // dedicated mode for them.
            if sessionType == 3 { continue }

            let isGroup = groupInfoPK > 0
            if chatFilter == "individual" && isGroup { continue }
            if chatFilter == "group" && !isGroup { continue }

            let mediaType = mediaTypeName(forZMessageType: msgType)
            // Only ZMESSAGETYPE 6 is a true system/info message ("Alice joined",
            // "Bob changed the photo"). ZGROUPEVENTTYPE is non-zero on plenty
            // of non-system rows in newer schemas (media messages in groups
            // tag it with the membership-event slot), so `groupEvent != 0`
            // alone was misclassifying every group media message as a system
            // event and wiping the placeholder back to `[system event]`.
            let isSystemEvent = msgType == 6
            let occurredAt = Date(timeIntervalSince1970: msgDate + macEpochOffset)

            // Sender resolution by chat shape:
            //   group + inbound: the group_member join carries the real JID
            //                    and display name (WA Desktop UI uses these).
            //   1:1 + inbound:   the chat session's contact_jid IS the sender.
            //   outbound:        omit sender_jid; capture recipient as participant.
            let senderJID: String?
            let pushName: String?
            if isFromMe {
                senderJID = nil
                pushName = nil
            } else if isGroup {
                senderJID = groupMemberJID
                pushName = groupMemberName ?? groupMemberFirstName
            } else {
                senderJID = chatJID
                pushName = partnerName
            }
            let senderPhone = senderJID.flatMap(extractPhoneFromJID)

            let payloadText = makePayloadText(
                text: text,
                msgType: msgType,
                mediaTitle: mediaTitle,
                isSystem: isSystemEvent
            )
            // Empty bodies happen on stub rows (deleted messages, status
            // markers, etc.). Skip them so the agent isn't paging through noise.
            guard !payloadText.isEmpty else { continue }

            let title = makeTitle(
                partnerName: partnerName,
                chatJID: chatJID,
                isGroup: isGroup,
                isFromMe: isFromMe,
                pushName: pushName
            )

            // Stanza id is the WhatsApp wire-level message id; the QR-paired
            // `whatsapp` connector uses the same string as its origin_id, so
            // emitting it bare here lets the gateway's onConflictUpdate dedup
            // a message that arrives via both transports. Rows without a
            // stanza id (rare stub rows) are dropped — falling back to a
            // synthetic `pk-N` would defeat dedup and pollute origin history
            // with per-Mac-only ids.
            guard let stanzaId, !stanzaId.isEmpty else { continue }
            let originId = stanzaId

            var metadata: [String: AnyEncodable] = [
                "source": AnyEncodable("whatsapp_local"),
                "origin_id": AnyEncodable(originId),
                "chat_jid": AnyEncodable(chatJID),
                "is_group": AnyEncodable(isGroup),
                "from_me": AnyEncodable(isFromMe),
            ]
            if let senderJID { metadata["sender_jid"] = AnyEncodable(senderJID) }
            if let senderPhone { metadata["sender_phone"] = AnyEncodable(senderPhone) }
            if let pushName { metadata["push_name"] = AnyEncodable(pushName) }
            if let toJID, isFromMe { metadata["participant"] = AnyEncodable(toJID) }
            if let mediaType { metadata["media_type"] = AnyEncodable(mediaType) }
            if isStarred { metadata["is_starred"] = AnyEncodable(true) }
            if isSystemEvent { metadata["is_system_event"] = AnyEncodable(true) }

            // Audio-only attachment ingest. Other media types still get a
            // labeled placeholder ([image], [video], etc.) but we don't ship
            // their bytes — non-audio is a separate feature.
            var attachments: [WorkerStreamAttachment]? = nil
            if mediaType == "audio" {
                let audioResult = readAudioAttachment(relativePath: mediaPath)
                if let attachment = audioResult.attachment {
                    attachments = [attachment]
                } else if let skipReason = audioResult.skipReason {
                    metadata["voice_note_skipped"] = AnyEncodable(skipReason)
                }
            }

            items.append(
                WorkerStreamItem(
                    id: originId,
                    title: title,
                    payload_text: payloadText,
                    occurred_at: iso.string(from: occurredAt),
                    // Must match the eventKinds key declared in the connector
                    // definition's feeds_schema; the gateway's
                    // validateConnectorEventSemanticType drops events that don't.
                    semantic_type: "message",
                    metadata: metadata,
                    attachments: attachments
                )
            )
        }

        schemaSurvey.report(emittedItems: items.count)

        let checkpoint: [String: AnyEncodable] = ["last_pk": AnyEncodable(highestPK)]
        return Output(items: items, checkpoint: checkpoint)
    }

    // MARK: - Helpers

    private static func makeSnapshotDir() throws -> URL {
        let base = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("lobu-whatsapp-\(UUID().uuidString)", isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        } catch {
            throw ServiceError.snapshotFailed("mkdir: \(error.localizedDescription)")
        }
        return base
    }

    /// Copy the main DB plus its WAL and SHM sidecars. Order matters: copying
    /// the WAL after the main file means the snapshot may contain frames that
    /// don't exist in the copied main file, which SQLite handles cleanly
    /// (it replays the WAL on first open). The reverse can leave the snapshot
    /// missing frames the main file's header expects.
    private static func copySQLiteFamily(from source: URL, to destination: URL) throws {
        let fm = FileManager.default
        let walSource = URL(fileURLWithPath: source.path + "-wal")
        let shmSource = URL(fileURLWithPath: source.path + "-shm")
        let walDest = URL(fileURLWithPath: destination.path + "-wal")
        let shmDest = URL(fileURLWithPath: destination.path + "-shm")

        do {
            try fm.copyItem(at: source, to: destination)
        } catch {
            // POSIX EPERM (1) on the WhatsApp Group Container almost always
            // means TCC denied us — bubble that up as the FDA-denied case so
            // the user sees an actionable status rather than a copy-failed
            // line that looks like a disk error.
            let nsError = error as NSError
            if nsError.domain == NSCocoaErrorDomain && (nsError.code == NSFileReadNoPermissionError || nsError.code == 257) {
                throw ServiceError.fullDiskAccessDenied
            }
            throw ServiceError.snapshotFailed("copy main: \(error.localizedDescription)")
        }
        if fm.fileExists(atPath: walSource.path) {
            do { try fm.copyItem(at: walSource, to: walDest) }
            catch { throw ServiceError.snapshotFailed("copy wal: \(error.localizedDescription)") }
        }
        if fm.fileExists(atPath: shmSource.path) {
            // SHM is best-effort: it's process-private state that SQLite will
            // rebuild on open. A failed copy here doesn't poison the snapshot.
            try? fm.copyItem(at: shmSource, to: shmDest)
        }
    }

    private static func cString(_ stmt: OpaquePointer?, _ idx: Int32) -> String? {
        guard let raw = sqlite3_column_text(stmt, idx) else { return nil }
        let value = String(cString: raw)
        return value.isEmpty ? nil : value
    }

    private static func mediaTypeName(forZMessageType type: Int) -> String? {
        switch type {
        case 0: return nil // plain text — no media
        case 1: return "image"
        case 2: return "video"
        case 3, 10: return "audio"
        case 4: return "contact"
        case 5: return "location"
        case 7: return "url"
        case 8: return "document"
        case 11: return "location_live"
        case 13: return "call"
        case 14: return "sticker"
        case 15: return "gif"
        default: return "other_\(type)"
        }
    }

    private static func makePayloadText(text: String?, msgType: Int, mediaTitle: String?, isSystem: Bool) -> String {
        if let text, !text.isEmpty { return text }
        // For image/video rows (ZMESSAGETYPE 1/2) WhatsApp Desktop stores the
        // caption in `ZWAMEDIAITEM.ZTITLE`, NOT `ZWAMESSAGE.ZTEXT` — verified
        // against a live install. For URL/document rows (7/8) the same column
        // is the link/file title. Either way, surfacing it as payload_text
        // gives the agent something usable instead of `[image]`.
        if let mediaTitle { return mediaTitle }
        // Media-type label wins over the system-event fallback so a media row
        // never collapses to `[system event]`. The transcription pipeline
        // later replaces this placeholder for audio.
        if let kind = mediaTypeName(forZMessageType: msgType) {
            return kind == "audio" ? "[voice note]" : "[\(kind)]"
        }
        if isSystem { return "[system event]" }
        return ""
    }

    private static func makeTitle(
        partnerName: String?,
        chatJID: String?,
        isGroup: Bool,
        isFromMe: Bool,
        pushName: String?
    ) -> String? {
        let chatLabel = partnerName ?? chatJID
        guard let chatLabel else { return nil }
        if isFromMe { return "→ \(chatLabel)" }
        if isGroup, let sender = pushName { return "\(chatLabel): \(sender)" }
        return chatLabel
    }

    /// Result of attempting to inline an audio file. `attachment` is the
    /// successfully read payload; `skipReason` is set instead when we
    /// deliberately dropped the file so the caller can stamp it on the event
    /// metadata. Both nil means "no audio path to begin with" (treat as
    /// silently absent).
    struct AudioResult {
        let attachment: WorkerStreamAttachment?
        let skipReason: String?
    }

    /// Resolve a WhatsApp Desktop voice-note path on disk and read it as a
    /// base64-encoded attachment. WhatsApp Desktop downloads media on-demand,
    /// so missing files are normal (the user hasn't played it back yet) and
    /// reported via `skipReason: "not_downloaded"`. Oversized files and read
    /// errors are also surfaced so the agent isn't left staring at a
    /// `[voice note]` placeholder with no explanation.
    private static func readAudioAttachment(relativePath: String?) -> AudioResult {
        guard let relativePath, !relativePath.isEmpty else {
            return AudioResult(attachment: nil, skipReason: nil)
        }
        // Reject absolute paths up front — `appendingPathComponent` on a `/`
        // -prefixed string still ends up at the root, not under mediaBaseURL.
        guard !relativePath.hasPrefix("/") else {
            return AudioResult(attachment: nil, skipReason: "invalid_path")
        }
        let fm = FileManager.default
        // Canonicalize the media root once, then build the candidate and
        // verify by-prefix containment. `..`, symlink escapes, and any other
        // path-traversal trick on the (untrusted) ZMEDIALOCALPATH string land
        // outside the prefix and get dropped.
        let baseURL = mediaBaseURL().resolvingSymlinksInPath().standardizedFileURL
        let absoluteURL = baseURL
            .appendingPathComponent(relativePath)
            .resolvingSymlinksInPath()
            .standardizedFileURL
        guard absoluteURL.path.hasPrefix(baseURL.path + "/") else {
            return AudioResult(attachment: nil, skipReason: "invalid_path")
        }
        guard fm.fileExists(atPath: absoluteURL.path) else {
            return AudioResult(attachment: nil, skipReason: "not_downloaded")
        }
        let attrs = try? fm.attributesOfItem(atPath: absoluteURL.path)
        let size = (attrs?[.size] as? NSNumber)?.intValue ?? 0
        if size <= 0 {
            return AudioResult(attachment: nil, skipReason: "empty")
        }
        if size > maxAudioAttachmentBytes {
            return AudioResult(attachment: nil, skipReason: "too_large")
        }
        guard let data = try? Data(contentsOf: absoluteURL) else {
            return AudioResult(attachment: nil, skipReason: "read_error")
        }
        let filename = absoluteURL.lastPathComponent
        let mime = mimeTypeForExtension(absoluteURL.pathExtension.lowercased())
        let durationMs = probeAudioDurationMs(at: absoluteURL)
        let attachment = WorkerStreamAttachment(
            kind: "audio",
            filename: filename,
            mime_type: mime,
            data: data.base64EncodedString(),
            size_bytes: size,
            duration_ms: durationMs
        )
        return AudioResult(attachment: attachment, skipReason: nil)
    }

    /// Best-effort audio-duration probe via AVFoundation. Returns nil if the
    /// asset can't be loaded or the duration is indefinite — duration is
    /// informational, so a failure here never blocks ingest.
    private static func probeAudioDurationMs(at url: URL) -> Int? {
        let asset = AVURLAsset(url: url)
        let cm = asset.duration
        guard cm.isValid, !cm.isIndefinite, cm.timescale != 0 else { return nil }
        let seconds = CMTimeGetSeconds(cm)
        guard seconds.isFinite, seconds > 0 else { return nil }
        return Int((seconds * 1000.0).rounded())
    }

    /// Remove `lobu-whatsapp-*` snapshot directories older than an hour from
    /// tmp. Cheap (a single readdir + stat), runs once per sync; covers leaks
    /// from a hard-kill mid-sync where the `defer` cleanup didn't run.
    private static func sweepStaleSnapshotDirs() {
        let fm = FileManager.default
        let tmp = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
        guard let entries = try? fm.contentsOfDirectory(at: tmp,
                                                       includingPropertiesForKeys: [.contentModificationDateKey],
                                                       options: [.skipsHiddenFiles]) else { return }
        let cutoff = Date().addingTimeInterval(-60 * 60)
        for entry in entries where entry.lastPathComponent.hasPrefix("lobu-whatsapp-") {
            let modified = (try? entry.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate
            if let modified, modified < cutoff {
                try? fm.removeItem(at: entry)
            }
        }
    }

    private static func mimeTypeForExtension(_ ext: String) -> String {
        // WhatsApp voice notes ship as Opus in an OGG container (.opus or
        // .ogg). Other audio attachments may be m4a or wav. Fall back to
        // application/octet-stream so the gateway still stores them.
        switch ext {
        case "opus": return "audio/opus"
        case "ogg": return "audio/ogg"
        case "m4a": return "audio/m4a"
        case "mp4": return "audio/mp4"
        case "mp3": return "audio/mpeg"
        case "wav": return "audio/wav"
        default: return "application/octet-stream"
        }
    }

    private static func extractPhoneFromJID(_ jid: String) -> String? {
        // Only `<digits>@s.whatsapp.net` carries a real E.164 phone. `@lid`,
        // `@g.us`, and `@status` are anonymized / aggregate JIDs.
        guard let at = jid.firstIndex(of: "@") else { return nil }
        let suffix = jid[jid.index(after: at)...]
        guard suffix == "s.whatsapp.net" else { return nil }
        let digits = jid[..<at]
        return digits.allSatisfy(\.isNumber) ? String(digits) : nil
    }

    /// Per-sync diagnostics: tracks which ZMESSAGETYPE values and ZFLAGS bit
    /// patterns we encountered that we don't yet have a meaning for, then
    /// logs a single summary line at the end. The point is to give us a way
    /// to iterate on schema understanding (e.g. spotting a new message type
    /// that shows up after a WA Desktop update) without having to attach a
    /// debugger or query the live DB by hand. We do NOT change emission
    /// behavior based on what we see — that would couple ingest semantics to
    /// undocumented bits.
    private struct SchemaSurvey {
        // The ZMESSAGETYPE values we currently understand (text + media kinds
        // surfaced by `mediaTypeName` plus the system-event sentinel).
        private static let knownTypes: Set<Int> = [
            0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 13, 14, 15,
        ]
        // Bits we recognize in ZFLAGS today. 0x01000000 is set on virtually
        // every row (presence/status); other bits are uncharted territory.
        private static let knownFlagBits: Int64 = 0x01000000

        private var unknownTypes: [Int: Int] = [:]
        private var unknownFlagMasks: [Int64: Int] = [:]

        mutating func observe(messageType: Int, flags: Int64) {
            if !Self.knownTypes.contains(messageType) {
                unknownTypes[messageType, default: 0] += 1
            }
            let unknownBits = flags & ~Self.knownFlagBits
            if unknownBits != 0 {
                unknownFlagMasks[unknownBits, default: 0] += 1
            }
        }

        func report(emittedItems: Int) {
            guard !unknownTypes.isEmpty || !unknownFlagMasks.isEmpty else { return }
            let logger = Logger(subsystem: "ai.lobu.mac", category: "whatsapp.local")
            let typeSummary = unknownTypes
                .sorted { $0.key < $1.key }
                .map { "\($0.key)=\($0.value)" }
                .joined(separator: ",")
            let flagSummary = unknownFlagMasks
                .sorted { $0.value > $1.value }
                .prefix(5)
                .map { String(format: "0x%llx=%d", $0.key, $0.value) }
                .joined(separator: ",")
            logger.info(
                "wa.local schema-survey: emitted=\(emittedItems, privacy: .public) unknown_types=[\(typeSummary, privacy: .public)] unknown_flag_masks=[\(flagSummary, privacy: .public)]"
            )
        }
    }
}

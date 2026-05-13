import Foundation

/// Result of a `local.directory` feed sync: events streamed + new checkpoint
/// (single-folder; no per-folder map needed now that each folder is its own
/// feed).
struct LocalDirectoryOutput {
    let items: [WorkerStreamItem]
    /// `{ "last_sync": <unix seconds>, "cursor": <filename>? }`.
    let checkpoint: [String: AnyEncodable]
}

/// Handles one `local.directory` feed run. Each Lobu folder is now its own
/// feed with `config.folder_id` identifying which security-scoped bookmark on
/// this Mac to read.
///
/// v1 constraints (per run):
/// - Shallow enumeration only (no subdirectory recursion).
/// - Extensions: txt, md, json, csv, html.
/// - Max file size: 1 MB per file.
/// - Max files per run: 500 (paginate via `cursor` checkpoint).
///
/// Incremental: each feed run reads its checkpoint (`last_sync`, optional
/// `cursor`) and skips files whose mtime is older than `last_sync` (or whose
/// mtime equals `last_sync` and filename is `<= cursor`). The `cursor` is
/// written only when a pass hits the 500-file cap mid-second, so subsequent
/// runs continue through same-second mtime ties instead of getting stuck.
/// Events are deduped server-side by `origin_id` = `local-dir:<folderId>:<name>`.
enum LocalDirectorySyncService {
    private static let allowedExtensions: Set<String> = ["txt", "md", "json", "csv", "html"]
    private static let maxFileSize: Int = 1_048_576   // 1 MB
    private static let maxFilesPerRun: Int = 500

    /// Decode the persisted folder list. Matches the AppState representation
    /// (`[LocalFolder]` JSON under `lobu.localFolderBookmarks`).
    private static func loadFolders() -> [LocalFolder] {
        guard let data = UserDefaults.standard.data(forKey: "lobu.localFolderBookmarks") else { return [] }
        return (try? JSONDecoder().decode([LocalFolder].self, from: data)) ?? []
    }

    static func runLocalDirectory(job: WorkerJob) throws -> LocalDirectoryOutput {
        // The server-merged job.config carries the feed's `folder_id`. If
        // it's absent the run was materialized against an old-shape feed —
        // bail loudly so the failure is visible in the run log.
        guard let folderId = job.config?["folder_id"]?.stringValue, !folderId.isEmpty else {
            throw NSError(
                domain: "Lobu.LocalDirectory",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Feed config missing folder_id — Mac app and server are out of sync; restart the Mac app to reconcile."]
            )
        }

        let folders = loadFolders()
        guard let folder = folders.first(where: { $0.folderId == folderId }) else {
            // Folder removed locally while the run was in flight. Return empty
            // — the next reconcileFolderFeeds() pass will delete the server-
            // side feed.
            return LocalDirectoryOutput(items: [], checkpoint: [:])
        }

        var isStale = false
        guard let folderURL = try? URL(
            resolvingBookmarkData: folder.bookmark,
            options: .withSecurityScope,
            relativeTo: nil,
            bookmarkDataIsStale: &isStale
        ) else {
            return LocalDirectoryOutput(items: [], checkpoint: [:])
        }
        guard folderURL.startAccessingSecurityScopedResource() else {
            return LocalDirectoryOutput(items: [], checkpoint: [:])
        }
        defer { folderURL.stopAccessingSecurityScopedResource() }

        let passStartedAt = Int(Date().timeIntervalSince1970)
        let lastSync = job.checkpoint?["last_sync"]?.intValue
        let cursor = job.checkpoint?["cursor"]?.stringValue
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let fm = FileManager.default

        guard let rawEntries = try? fm.contentsOfDirectory(
            at: folderURL,
            includingPropertiesForKeys: [.fileSizeKey, .contentModificationDateKey, .isRegularFileKey],
            options: [.skipsHiddenFiles]
        ) else {
            return LocalDirectoryOutput(items: [], checkpoint: [:])
        }

        let entries = rawEntries.sorted { lhs, rhs in
            let lhsModified = (try? lhs.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate)?.timeIntervalSince1970 ?? 0
            let rhsModified = (try? rhs.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate)?.timeIntervalSince1970 ?? 0
            if lhsModified == rhsModified { return lhs.lastPathComponent < rhs.lastPathComponent }
            return lhsModified < rhsModified
        }

        var items: [WorkerStreamItem] = []
        var folderCompleted = true
        var lastProcessed: (seconds: Int, filename: String)?

        for fileURL in entries {
            guard items.count < maxFilesPerRun else {
                folderCompleted = false
                break
            }
            guard (try? fileURL.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true else { continue }
            let ext = fileURL.pathExtension.lowercased()
            guard allowedExtensions.contains(ext) else { continue }

            let resources = try? fileURL.resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey])
            let fileSize = resources?.fileSize ?? 0
            guard fileSize <= maxFileSize else { continue }

            let modifiedAt = resources?.contentModificationDate ?? Date()
            let modifiedSeconds = Int(modifiedAt.timeIntervalSince1970)
            let filename = fileURL.lastPathComponent

            // Skip files unchanged since this feed's last sync. Cursor is
            // written only when a previous pass hit maxFilesPerRun; it lets
            // the next pass continue past same-second mtime ties.
            if let lastSync {
                if let cursor {
                    if modifiedSeconds < lastSync { continue }
                    if modifiedSeconds == lastSync && filename <= cursor { continue }
                } else if modifiedAt.timeIntervalSince1970 < Double(lastSync) {
                    // Strict `<` so a same-second edit re-syncs (cheap no-op
                    // upsert) rather than missed.
                    continue
                }
            }

            guard let text = try? String(contentsOf: fileURL, encoding: .utf8) else { continue }

            let item = WorkerStreamItem(
                id: "local-dir:\(folder.folderId):\(filename)",
                title: filename,
                payload_text: text,
                occurred_at: iso.string(from: modifiedAt),
                semantic_type: "file_document",
                metadata: [
                    "source": AnyEncodable("local_directory"),
                    "folder": AnyEncodable(folder.displayName),
                    "name": AnyEncodable(filename),
                    "ext": AnyEncodable(ext),
                    "size_bytes": AnyEncodable(fileSize),
                    "modified_at": AnyEncodable(iso.string(from: modifiedAt)),
                ]
            )
            items.append(item)
            lastProcessed = (modifiedSeconds, filename)
        }

        var checkpoint: [String: AnyEncodable] = [:]
        if folderCompleted {
            checkpoint["last_sync"] = AnyEncodable(passStartedAt)
        } else if let lastProcessed {
            checkpoint["last_sync"] = AnyEncodable(lastProcessed.seconds)
            checkpoint["cursor"] = AnyEncodable(lastProcessed.filename)
        } else if let lastSync {
            checkpoint["last_sync"] = AnyEncodable(lastSync)
            if let cursor { checkpoint["cursor"] = AnyEncodable(cursor) }
        }
        return LocalDirectoryOutput(items: items, checkpoint: checkpoint)
    }
}

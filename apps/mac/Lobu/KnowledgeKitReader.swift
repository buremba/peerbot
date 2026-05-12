import Foundation
import SQLite3

/// Reads Apple's on-device Knowledge store (`~/Library/Application Support/Knowledge/knowledgeC.db`).
/// Requires Full Disk Access — the user grants it once via
/// System Settings → Privacy & Security → Full Disk Access.
///
/// The DB is a CoreData SQLite that stores usage events keyed by stream name:
///   - "/app/usage"  — per-app foreground time (we use this for Screen Time)
///   - "/app/inFocus" — app focus events
///   - "/app/webUsage" — Safari domain visits
///   - many others (notifications, focus modes, location visits, etc.)
///
/// We open read-only, so concurrent OS writers don't conflict with us.
final class KnowledgeKitReader {
    /// Daily per-app foreground duration. Output unit for the Screen Time connector.
    struct DailyAppUsage: Hashable {
        let date: String       // "yyyy-MM-dd"
        let bundleID: String   // e.g. "com.apple.Safari", "com.tinyspeck.slackmacgap"
        let seconds: Double
    }

    enum ReaderError: LocalizedError {
        case databaseNotFound(String)
        case fullDiskAccessDenied
        case sqlite(String)

        var errorDescription: String? {
            switch self {
            case let .databaseNotFound(path): return "Knowledge DB not found at \(path)"
            case .fullDiskAccessDenied:
                return "Lobu needs Full Disk Access. Open System Settings → Privacy & Security → Full Disk Access, add Lobu, then try again."
            case let .sqlite(message): return "SQLite error: \(message)"
            }
        }
    }

    /// `knowledgeC.db` uses Mac absolute time (seconds since 2001-01-01 UTC).
    /// `unixEpoch + macAbsoluteEpochOffset` converts to seconds-since-1970.
    private static let macAbsoluteEpochOffset: Double = 978307200

    private let dbPath: String
    private let calendar: Calendar

    init(
        dbPath: String = "\(NSHomeDirectory())/Library/Application Support/Knowledge/knowledgeC.db",
        calendar: Calendar = .current
    ) {
        self.dbPath = dbPath
        self.calendar = calendar
    }

    /// Fetch per-app foreground usage in the trailing `days` window, aggregated
    /// by day. Returns one row per (day, bundle_id) with summed seconds.
    func dailyAppUsage(days: Int) throws -> [DailyAppUsage] {
        guard FileManager.default.fileExists(atPath: dbPath) else {
            throw ReaderError.databaseNotFound(dbPath)
        }

        var handle: OpaquePointer?
        // SQLITE_OPEN_READONLY | SQLITE_OPEN_NOMUTEX = read-only, no in-process mutex
        let openFlags: Int32 = SQLITE_OPEN_READONLY | SQLITE_OPEN_NOMUTEX
        let openResult = sqlite3_open_v2(dbPath, &handle, openFlags, nil)
        guard openResult == SQLITE_OK, let db = handle else {
            sqlite3_close(handle)
            // SQLITE_AUTH / SQLITE_PERM typically means TCC denied us.
            if openResult == SQLITE_AUTH || openResult == SQLITE_PERM {
                throw ReaderError.fullDiskAccessDenied
            }
            throw ReaderError.sqlite("open returned \(openResult)")
        }
        defer { sqlite3_close(db) }

        let cutoffMacTime = Date().timeIntervalSince1970
            - Self.macAbsoluteEpochOffset
            - Double(max(days, 1)) * 86400.0

        // ZSTREAMNAME = '/app/usage' → app foreground time
        // ZVALUESTRING → bundle ID
        // ZSTARTDATE / ZENDDATE → Mac absolute time
        let sql = """
        SELECT
          ZVALUESTRING AS bundle_id,
          ZSTARTDATE AS start_mac,
          ZENDDATE AS end_mac
        FROM ZOBJECT
        WHERE ZSTREAMNAME = '/app/usage'
          AND ZVALUESTRING IS NOT NULL
          AND ZSTARTDATE >= ?
          AND ZENDDATE IS NOT NULL
          AND ZENDDATE > ZSTARTDATE
        ORDER BY ZSTARTDATE ASC;
        """

        var stmt: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &stmt, nil) == SQLITE_OK else {
            throw ReaderError.sqlite(String(cString: sqlite3_errmsg(db)))
        }
        defer { sqlite3_finalize(stmt) }
        sqlite3_bind_double(stmt, 1, cutoffMacTime)

        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = calendar.timeZone
        formatter.dateFormat = "yyyy-MM-dd"

        // Aggregate: (date, bundle_id) → seconds
        var totals: [String: Double] = [:]

        while sqlite3_step(stmt) == SQLITE_ROW {
            guard let cBundle = sqlite3_column_text(stmt, 0) else { continue }
            let bundleID = String(cString: cBundle)
            let startMac = sqlite3_column_double(stmt, 1)
            let endMac = sqlite3_column_double(stmt, 2)
            let duration = max(0, endMac - startMac)
            if duration == 0 { continue }

            // Bucket by START day in the user's local timezone. (Sessions that
            // span midnight are charged to their starting day; precise splits
            // can come later if the agent ever cares.)
            let startWallClock = Date(timeIntervalSince1970: startMac + Self.macAbsoluteEpochOffset)
            let dateStr = formatter.string(from: calendar.startOfDay(for: startWallClock))
            let key = "\(dateStr)|\(bundleID)"
            totals[key, default: 0] += duration
        }

        return totals.map { (key, seconds) in
            let parts = key.split(separator: "|", maxSplits: 1)
            return DailyAppUsage(
                date: String(parts[0]),
                bundleID: String(parts[1]),
                seconds: seconds
            )
        }.sorted { lhs, rhs in
            lhs.date == rhs.date ? lhs.seconds > rhs.seconds : lhs.date < rhs.date
        }
    }
}

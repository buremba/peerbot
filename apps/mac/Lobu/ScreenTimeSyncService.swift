import Foundation

/// Reads Apple Screen Time events from knowledgeC.db and returns WorkerStreamItems.
/// The poll/stream/complete cycle is orchestrated by SyncDispatcher in AppState.swift.
enum ScreenTimeSyncService {
    static func runScreenTime(job: WorkerJob) async throws -> [WorkerStreamItem] {
        let backfillDays = job.config?["backfill_days"]?.intValue ?? 14
        let reader = KnowledgeKitReader()
        let usage = try reader.dailyAppUsage(days: backfillDays)
        return usage.map { row in
            let originId = "apple-screen-time:app:\(row.date):\(row.bundleID)"
            let minutes = Int((row.seconds / 60.0).rounded())
            return WorkerStreamItem(
                id: originId,
                title: "\(row.bundleID) — \(minutes) min on \(row.date)",
                payload_text: "Used \(row.bundleID) for \(minutes) min on \(row.date).",
                occurred_at: isoString(parseDate(row.date)),
                semantic_type: "screen_time_daily_app",
                metadata: [
                    "source": AnyEncodable("apple_screen_time"),
                    "origin_id": AnyEncodable(originId),
                    "date": AnyEncodable(row.date),
                    "bundle_id": AnyEncodable(row.bundleID),
                    "seconds": AnyEncodable(row.seconds),
                ]
            )
        }
    }

    private static func parseDate(_ yyyyMMdd: String) -> Date {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = .current
        f.dateFormat = "yyyy-MM-dd"
        return f.date(from: yyyyMMdd) ?? Date()
    }
}

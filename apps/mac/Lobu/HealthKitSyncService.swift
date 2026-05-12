import Foundation
import HealthKit
import Security

/// Result of an `apple.health` sync pass — events to stream plus the new
/// per-feed checkpoint (`last_sync_at` Unix seconds) to persist.
struct HealthKitOutput {
    let items: [WorkerStreamItem]
    let checkpoint: [String: AnyEncodable]
}

/// Handles `apple.health` jobs by querying HealthKit on macOS, which sees the
/// user's HealthKit data synced from iPhone (and Apple Watch) via iCloud
/// Health. Two feed paths gated by `job.feed_key`:
///
/// - `daily_summaries` — per-day totals: steps, distance, active energy,
///   exercise minutes, and resting-heart-rate average.
/// - `workouts` — individual workout sessions.
///
/// Incremental: each feed's checkpoint stores `last_sync_at` (Unix seconds);
/// the next pass queries from `max(now - backfill_days, checkpoint - 2 days)`
/// — re-checking the last 2 days each time so late-arriving Apple Watch syncs
/// (which can backfill hours later) still get picked up. Origin ids are stable
/// per day / per workout uuid, so server-side `onConflictUpdate` dedup absorbs
/// the overlap as no-op upserts.
///
/// NOTE: shipping builds currently omit the `com.apple.developer.healthkit`
/// entitlement (see Lobu.entitlements for why), so `isAvailable()` returns
/// false and this service is dormant. It's kept wired up on purpose —
/// re-adding the entitlement + a Developer ID provisioning profile is all it
/// takes to switch Apple Health back on.
enum HealthKitSyncService {
    enum HealthKitError: LocalizedError {
        case unavailable
        case unsupportedFeed(String)
        var errorDescription: String? {
            switch self {
            case .unavailable: return "HealthKit isn't available on this Mac."
            case let .unsupportedFeed(key): return "Unknown apple.health feed: \(key)"
            }
        }
    }

    /// Persisted once the user has been through the system permission sheet at
    /// least once. HealthKit deliberately doesn't reveal per-type READ-grant
    /// status (to prevent fingerprinting), so this is the best we can do to
    /// gate advertising the `healthkit` capability; a user who denied in the
    /// sheet just gets empty query results, which is a no-op upstream.
    static let userDefaultsKey = "lobu.healthKitRequested"

    private static let store = HKHealthStore()

    static var hasBeenRequested: Bool { UserDefaults.standard.bool(forKey: userDefaultsKey) }

    static func isAvailable() -> Bool {
        HKHealthStore.isHealthDataAvailable() && hasHealthKitEntitlement()
    }

    private static func hasHealthKitEntitlement() -> Bool {
        guard
            let task = SecTaskCreateFromSelf(nil),
            let value = SecTaskCopyValueForEntitlement(
                task,
                "com.apple.developer.healthkit" as CFString,
                nil
            )
        else { return false }
        return (value as? Bool) == true
    }

    /// The READ types the bridge asks for. Apple shows ONE sheet listing all of
    /// these and lets the user grant/deny each individually.
    private static var readTypes: Set<HKObjectType> {
        var types: Set<HKObjectType> = [HKObjectType.workoutType()]
        for id: HKQuantityTypeIdentifier in [
            .stepCount, .distanceWalkingRunning, .activeEnergyBurned,
            .appleExerciseTime, .restingHeartRate,
        ] {
            if let t = HKQuantityType.quantityType(forIdentifier: id) {
                types.insert(t)
            }
        }
        return types
    }

    /// Open the Apple Health permission sheet. The completion only tells us
    /// the UI finished — not which types the user granted — so we persist
    /// `lobu.healthKitRequested = true` and let query results reveal the rest.
    static func requestAuthorization() async throws {
        guard isAvailable() else { throw HealthKitError.unavailable }
        try await store.requestAuthorization(toShare: [], read: readTypes)
        UserDefaults.standard.set(true, forKey: userDefaultsKey)
    }

    static func runHealth(job: WorkerJob) async throws -> HealthKitOutput {
        guard isAvailable() else { throw HealthKitError.unavailable }
        let passStartedAt = Int(Date().timeIntervalSince1970)
        let backfillDays = job.config?["backfill_days"]?.intValue ?? 30

        // The window we actually query — bounded by `backfill_days` so a fresh
        // sync doesn't grind through years of data, and shifted back 2 days on
        // incremental runs to absorb late-arriving Apple Watch backfill.
        let overlapSeconds: TimeInterval = 2 * 24 * 3600
        let backfillStart = Date().addingTimeInterval(-Double(backfillDays) * 24 * 3600)
        let incrementalStart = (job.checkpoint?["last_sync_at"]?.intValue).map {
            Date(timeIntervalSince1970: TimeInterval($0) - overlapSeconds)
        }
        let queryStart = max(backfillStart, incrementalStart ?? backfillStart)

        let items: [WorkerStreamItem]
        switch job.feed_key {
        case "daily_summaries":
            items = try await dailySummaryItems(from: queryStart)
        case "workouts":
            items = try await workoutItems(from: queryStart)
        case let other:
            throw HealthKitError.unsupportedFeed(other ?? "<nil>")
        }

        // If this is the first run and HealthKit returns nothing, do not burn
        // the historical backfill window. This covers both denied read access
        // (HealthKit does not expose read-grant status) and iCloud Health data
        // that has not populated on this Mac yet.
        let hadExistingCheckpoint = job.checkpoint?["last_sync_at"]?.intValue != nil
        return HealthKitOutput(
            items: items,
            checkpoint: items.isEmpty && !hadExistingCheckpoint
                ? [:]
                : ["last_sync_at": AnyEncodable(passStartedAt)]
        )
    }

    // MARK: - daily_summaries

    private static func dailySummaryItems(from start: Date) async throws -> [WorkerStreamItem] {
        let cal = Calendar.current

        // Five quantity types, queried in parallel; merge into per-day rows.
        async let stepsByDay        = dailyTotals(.stepCount,             options: .cumulativeSum,   unit: .count(),                                  from: start)
        async let distanceByDay     = dailyTotals(.distanceWalkingRunning, options: .cumulativeSum,   unit: .meter(),                                  from: start)
        async let activeEnergyByDay = dailyTotals(.activeEnergyBurned,    options: .cumulativeSum,   unit: .kilocalorie(),                            from: start)
        async let exerciseByDay     = dailyTotals(.appleExerciseTime,     options: .cumulativeSum,   unit: .minute(),                                 from: start)
        async let restingHRByDay    = dailyTotals(.restingHeartRate,      options: .discreteAverage, unit: HKUnit.count().unitDivided(by: .minute()), from: start)

        let steps    = try await stepsByDay
        let distance = try await distanceByDay
        let energy   = try await activeEnergyByDay
        let exercise = try await exerciseByDay
        let resting  = try await restingHRByDay

        let dateOnly = DateFormatter()
        dateOnly.calendar = cal
        dateOnly.dateFormat = "yyyy-MM-dd"
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]

        // Union of all dates with any data, sorted ascending.
        var allDays = Set<Date>()
        for byDay in [steps, distance, energy, exercise, resting] {
            for day in byDay.keys { allDays.insert(day) }
        }
        let sortedDays = allDays.sorted()

        var items: [WorkerStreamItem] = []
        for day in sortedDays {
            let dateString = dateOnly.string(from: day)
            let stepsVal    = steps[day]    ?? 0
            let distVal     = distance[day] ?? 0
            let energyVal   = energy[day]   ?? 0
            let exerciseVal = exercise[day] ?? 0
            let restingVal  = resting[day]

            // Skip days with nothing at all — avoids empty rows for past dates
            // before the user wore an Apple Watch.
            if stepsVal == 0 && distVal == 0 && energyVal == 0 && exerciseVal == 0 && restingVal == nil {
                continue
            }

            let originId = "apple-health:daily:\(dateString)"
            var parts: [String] = []
            parts.append("Steps: \(Int(stepsVal))")
            parts.append(String(format: "Distance: %.2f km", distVal / 1000))
            parts.append(String(format: "Active energy: %.0f kcal", energyVal))
            parts.append("Exercise: \(Int(exerciseVal)) min")
            if let restingVal { parts.append(String(format: "Resting HR: %.0f bpm", restingVal)) }
            let payloadText = parts.joined(separator: ". ") + "."

            var metadata: [String: AnyEncodable] = [
                "source":             AnyEncodable("apple_health"),
                "origin_id":          AnyEncodable(originId),
                "date":               AnyEncodable(dateString),
                "steps":              AnyEncodable(stepsVal),
                "distance_m":         AnyEncodable(distVal),
                "active_energy_kcal": AnyEncodable(energyVal),
                "exercise_minutes":   AnyEncodable(exerciseVal),
            ]
            if let restingVal {
                metadata["resting_heart_rate_bpm"] = AnyEncodable(restingVal)
            }

            items.append(WorkerStreamItem(
                id: originId,
                title: "Apple Health · \(dateString)",
                payload_text: payloadText,
                occurred_at: iso.string(from: day),
                semantic_type: "health_daily_summary",
                metadata: metadata
            ))
        }
        return items
    }

    /// `[startOfDay: total]` totals expressed in `unit` for the given quantity
    /// type. `start` bounds the query; the anchor is today's start so bins line
    /// up with the user's local calendar days.
    private static func dailyTotals(
        _ id: HKQuantityTypeIdentifier,
        options: HKStatisticsOptions,
        unit: HKUnit,
        from start: Date
    ) async throws -> [Date: Double] {
        guard let qtype = HKQuantityType.quantityType(forIdentifier: id) else { return [:] }
        let cal = Calendar.current
        let anchor = cal.startOfDay(for: Date())
        let predicate = HKQuery.predicateForSamples(withStart: start, end: nil, options: .strictStartDate)

        return try await withCheckedThrowingContinuation { (cont: CheckedContinuation<[Date: Double], Error>) in
            let query = HKStatisticsCollectionQuery(
                quantityType: qtype,
                quantitySamplePredicate: predicate,
                options: options,
                anchorDate: anchor,
                intervalComponents: DateComponents(day: 1)
            )
            query.initialResultsHandler = { _, collection, error in
                if let error {
                    cont.resume(throwing: error)
                    return
                }
                guard let collection else {
                    cont.resume(returning: [:])
                    return
                }
                var out: [Date: Double] = [:]
                collection.enumerateStatistics(from: start, to: Date()) { stats, _ in
                    let value: Double? = options.contains(.cumulativeSum)
                        ? stats.sumQuantity()?.doubleValue(for: unit)
                        : options.contains(.discreteAverage)
                            ? stats.averageQuantity()?.doubleValue(for: unit)
                            : nil
                    if let value {
                        out[cal.startOfDay(for: stats.startDate)] = value
                    }
                }
                cont.resume(returning: out)
            }
            store.execute(query)
        }
    }

    // MARK: - workouts

    private static func workoutItems(from start: Date) async throws -> [WorkerStreamItem] {
        let predicate = HKQuery.predicateForSamples(withStart: start, end: nil, options: .strictStartDate)
        let workouts: [HKWorkout] = try await withCheckedThrowingContinuation { (cont: CheckedContinuation<[HKWorkout], Error>) in
            let query = HKSampleQuery(
                sampleType: HKObjectType.workoutType(),
                predicate: predicate,
                limit: HKObjectQueryNoLimit,
                sortDescriptors: [NSSortDescriptor(keyPath: \HKSample.startDate, ascending: true)]
            ) { _, samples, error in
                if let error {
                    cont.resume(throwing: error)
                    return
                }
                cont.resume(returning: (samples as? [HKWorkout]) ?? [])
            }
            store.execute(query)
        }

        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let dayFormatter = DateFormatter()
        dayFormatter.dateFormat = "yyyy-MM-dd"

        return workouts.map { workout in
            let typeName = workoutTypeName(workout.workoutActivityType)
            let durationMin = Int(workout.duration / 60)
            let energy = workout.totalEnergyBurned?.doubleValue(for: .kilocalorie())
            let distance = workout.totalDistance?.doubleValue(for: .meter())
            let originId = "apple-health:workout:\(workout.uuid.uuidString)"

            var parts = ["\(typeName) for \(durationMin) min"]
            if let distance { parts.append(String(format: "%.2f km", distance / 1000)) }
            if let energy { parts.append(String(format: "%.0f kcal", energy)) }
            let payloadText = parts.joined(separator: ", ")

            var metadata: [String: AnyEncodable] = [
                "source":       AnyEncodable("apple_health"),
                "origin_id":    AnyEncodable(originId),
                "workout_type": AnyEncodable(typeName),
                "started_at":   AnyEncodable(iso.string(from: workout.startDate)),
                "duration_s":   AnyEncodable(workout.duration),
            ]
            if let energy   { metadata["active_energy_kcal"] = AnyEncodable(energy) }
            if let distance { metadata["distance_m"] = AnyEncodable(distance) }

            return WorkerStreamItem(
                id: originId,
                title: "\(typeName) · \(dayFormatter.string(from: workout.startDate))",
                payload_text: payloadText,
                occurred_at: iso.string(from: workout.startDate),
                semantic_type: "health_workout",
                metadata: metadata
            )
        }
    }

    /// Human-readable label for common Apple Health workout types; falls back
    /// to `other_<rawValue>` for the long tail (HealthKit has 80+ types).
    private static func workoutTypeName(_ type: HKWorkoutActivityType) -> String {
        switch type {
        case .running:                       return "Running"
        case .walking:                       return "Walking"
        case .cycling:                       return "Cycling"
        case .swimming:                      return "Swimming"
        case .traditionalStrengthTraining:   return "Strength training"
        case .functionalStrengthTraining:    return "Functional training"
        case .highIntensityIntervalTraining: return "HIIT"
        case .yoga:                          return "Yoga"
        case .pilates:                       return "Pilates"
        case .dance:                         return "Dance"
        case .hiking:                        return "Hiking"
        case .rowing:                        return "Rowing"
        case .elliptical:                    return "Elliptical"
        case .mixedCardio:                   return "Mixed cardio"
        case .coreTraining:                  return "Core training"
        case .tennis:                        return "Tennis"
        case .basketball:                    return "Basketball"
        case .soccer:                        return "Soccer"
        case .golf:                          return "Golf"
        case .barre:                         return "Barre"
        case .other:                         return "Workout"
        default:                             return "other_\(type.rawValue)"
        }
    }
}

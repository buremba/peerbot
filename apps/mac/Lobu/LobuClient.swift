import Foundation

// Worker-protocol HTTP client. Same wire shapes as the iOS app's
// LobuClient.swift — kept as a verbatim port so server-side changes only
// have to happen in one place. Auth is the user's OAuth access token.

enum LobuWorkerIdentity {
    private static let key = "lobu.workerId"
    static func current() -> String {
        if let existing = UserDefaults.standard.string(forKey: key), !existing.isEmpty {
            return existing
        }
        let generated = "mac-\(UUID().uuidString.lowercased())"
        UserDefaults.standard.set(generated, forKey: key)
        return generated
    }
}

struct WorkerJob: Decodable {
    let run_id: Int
    let run_type: String?
    let connector_key: String
    let feed_key: String?
    let feed_id: Int?
    let connection_id: Int?
    let config: [String: AnyJSONValue]?
    let checkpoint: [String: AnyJSONValue]?
}

enum AnyJSONValue: Decodable {
    case integer(Int)
    case double(Double)
    case string(String)
    case bool(Bool)
    case null
    case other

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() {
            self = .null
        } else if let v = try? c.decode(Bool.self) {
            self = .bool(v)
        } else if let v = try? c.decode(Int.self) {
            self = .integer(v)
        } else if let v = try? c.decode(Double.self) {
            self = .double(v)
        } else if let v = try? c.decode(String.self) {
            self = .string(v)
        } else {
            self = .other
        }
    }

    var intValue: Int? {
        switch self {
        case let .integer(v): return v
        case let .double(v): return Int(v)
        case let .string(s): return Int(s)
        default: return nil
        }
    }

    var stringValue: String? {
        switch self {
        case let .string(s): return s
        case let .integer(v): return String(v)
        case let .double(v): return String(v)
        case let .bool(v): return String(v)
        case .null, .other: return nil
        }
    }
}

struct LobuNotification: Decodable, Identifiable, Equatable {
    let id: Int
    let type: String
    let title: String
    let body: String?
    let resource_url: String?
    let is_read: Bool
    let created_at: String
}

struct LobuNotificationsResponse: Decodable {
    let notifications: [LobuNotification]
    let nextCursor: Int?
}

struct LobuRun: Decodable, Identifiable, Equatable {
    let id: Int
    let connection_id: Int?
    let connector_key: String?
    let operation_key: String?
    let status: String?
    let approval_status: String?
    let error_message: String?
    let created_at: String?
    let completed_at: String?
}

struct LobuRunsResponse: Decodable {
    let runs: [LobuRun]
    let total: Int?
}

struct LobuConnection: Decodable, Identifiable, Equatable {
    let id: Int
    let connector_key: String?
    let connector_name: String?
    let name: String?
    let status: String?
    let event_count: Int?
}

struct LobuConnectionsResponse: Decodable {
    let connections: [LobuConnection]
}

struct LobuSearchHit: Decodable, Identifiable, Equatable {
    let event_id: Int?
    let title: String?
    let snippet: String?
    let url: String?
    let entity_name: String?

    var id: Int { event_id ?? 0 }
}

struct LobuSearchResponse: Decodable {
    let hits: [LobuSearchHit]?
    let results: [LobuSearchHit]?

    var items: [LobuSearchHit] { hits ?? results ?? [] }
}

struct WorkerStreamItem: Encodable {
    let id: String
    let title: String?
    let payload_text: String
    let occurred_at: String
    let semantic_type: String
    let metadata: [String: AnyEncodable]
}

struct AnyEncodable: Encodable {
    private let encodeImpl: (Encoder) throws -> Void
    init<T: Encodable>(_ value: T) { self.encodeImpl = value.encode(to:) }
    init(_ value: Any?) {
        switch value {
        case nil, is NSNull:
            self.encodeImpl = { encoder in var c = encoder.singleValueContainer(); try c.encodeNil() }
        case let v as String:
            self.encodeImpl = { encoder in var c = encoder.singleValueContainer(); try c.encode(v) }
        case let v as Bool:
            self.encodeImpl = { encoder in var c = encoder.singleValueContainer(); try c.encode(v) }
        case let v as Int:
            self.encodeImpl = { encoder in var c = encoder.singleValueContainer(); try c.encode(v) }
        case let v as Double:
            self.encodeImpl = { encoder in var c = encoder.singleValueContainer(); try c.encode(v) }
        default:
            self.encodeImpl = { encoder in var c = encoder.singleValueContainer(); try c.encode(String(describing: value ?? "")) }
        }
    }
    func encode(to encoder: Encoder) throws { try encodeImpl(encoder) }
}

enum WorkerClientError: LocalizedError {
    case http(String, Int, String)
    case decode(String)
    var errorDescription: String? {
        switch self {
        case let .http(path, code, body): return "Worker \(path) failed (\(code)): \(body)"
        case let .decode(message): return "Worker response decode failed: \(message)"
        }
    }
}

final class WorkerClient {
    private let baseURL: String
    private let accessToken: String
    private let session: URLSession
    private let encoder: JSONEncoder
    private let decoder: JSONDecoder

    init(baseURL: String, accessToken: String, session: URLSession = .shared) {
        self.baseURL = baseURL
        self.accessToken = accessToken
        self.session = session
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        self.encoder = encoder
        self.decoder = JSONDecoder()
    }

    func poll(workerId: String, capabilities: [String: Bool]) async throws -> (job: WorkerJob?, nextPollSeconds: Int?) {
        struct Body: Encodable {
            let worker_id: String
            let capabilities: [String: Bool]
            let platform: String
            let app_version: String
            let label: String
        }
        let appVersion = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "unknown"
        let label = Host.current().localizedName ?? "This Mac"
        let data = try await post(
            "/api/workers/poll",
            body: Body(worker_id: workerId, capabilities: capabilities, platform: "macos", app_version: appVersion, label: label)
        )
        struct Empty: Decodable { let next_poll_seconds: Int? }
        if let job = try? decoder.decode(WorkerJob.self, from: data) {
            return (job, nil)
        }
        if let empty = try? decoder.decode(Empty.self, from: data) {
            return (nil, empty.next_poll_seconds)
        }
        throw WorkerClientError.decode("/poll body=\(String(data: data, encoding: .utf8) ?? "<binary>")")
    }

    func heartbeat(workerId: String, runId: Int) async throws {
        struct Body: Encodable { let run_id: Int; let worker_id: String }
        _ = try await post("/api/workers/heartbeat", body: Body(run_id: runId, worker_id: workerId))
    }

    func stream(workerId: String, runId: Int, items: [WorkerStreamItem]) async throws {
        struct Body: Encodable { let type: String; let run_id: Int; let worker_id: String; let items: [WorkerStreamItem] }
        _ = try await post("/api/workers/stream", body: Body(type: "batch", run_id: runId, worker_id: workerId, items: items))
    }

    func complete(
        workerId: String,
        runId: Int,
        itemsCollected: Int,
        checkpoint: [String: AnyEncodable]? = nil,
        error: String?
    ) async throws {
        struct Body: Encodable {
            let run_id: Int; let worker_id: String; let status: String
            let items_collected: Int; let error_message: String?
            // nil → key omitted → server keeps the feed's existing checkpoint.
            let checkpoint: [String: AnyEncodable]?
        }
        _ = try await post(
            "/api/workers/complete",
            body: Body(run_id: runId, worker_id: workerId,
                       status: error == nil ? "success" : "failed",
                       items_collected: itemsCollected, error_message: error,
                       checkpoint: (checkpoint?.isEmpty ?? true) ? nil : checkpoint)
        )
    }

    // MARK: REST — org-scoped endpoints (require mcp:read scope on the token)

    func listNotifications(orgSlug: String, limit: Int = 10, unreadOnly: Bool = false) async throws -> LobuNotificationsResponse {
        var components = URLComponents(string: "\(baseURL.trimmedTrailingSlash())/api/\(orgSlug)/notifications")!
        components.queryItems = [
            URLQueryItem(name: "limit", value: String(limit)),
            URLQueryItem(name: "unread_only", value: unreadOnly ? "true" : "false"),
        ]
        let data = try await getRaw(url: components.url!, path: "/notifications")
        return try decoder.decode(LobuNotificationsResponse.self, from: data)
    }

    func getUnreadCount(orgSlug: String) async throws -> Int {
        let url = URL(string: "\(baseURL.trimmedTrailingSlash())/api/\(orgSlug)/notifications/unread-count")!
        let data = try await getRaw(url: url, path: "/notifications/unread-count")
        struct Response: Decodable { let count: Int }
        return try decoder.decode(Response.self, from: data).count
    }

    func listRuns(orgSlug: String, limit: Int = 10) async throws -> LobuRunsResponse {
        var components = URLComponents(string: "\(baseURL.trimmedTrailingSlash())/api/\(orgSlug)/runs")!
        components.queryItems = [URLQueryItem(name: "limit", value: String(limit))]
        let data = try await getRaw(url: components.url!, path: "/runs")
        return try decoder.decode(LobuRunsResponse.self, from: data)
    }

    func listConnections(orgSlug: String) async throws -> LobuConnectionsResponse {
        let url = URL(string: "\(baseURL.trimmedTrailingSlash())/api/\(orgSlug)/connections")!
        let data = try await getRaw(url: url, path: "/connections")
        return try decoder.decode(LobuConnectionsResponse.self, from: data)
    }

    func searchKnowledge(orgSlug: String, query: String, limit: Int = 5) async throws -> LobuSearchResponse {
        var components = URLComponents(string: "\(baseURL.trimmedTrailingSlash())/api/\(orgSlug)/knowledge/search")!
        components.queryItems = [
            URLQueryItem(name: "q", value: query),
            URLQueryItem(name: "limit", value: String(limit)),
        ]
        let data = try await getRaw(url: components.url!, path: "/knowledge/search")
        return try decoder.decode(LobuSearchResponse.self, from: data)
    }

    func markNotificationRead(orgSlug: String, id: Int) async throws {
        let url = URL(string: "\(baseURL.trimmedTrailingSlash())/api/\(orgSlug)/notifications/\(id)/read")!
        var request = URLRequest(url: url)
        request.httpMethod = "PATCH"
        request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        let (_, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw WorkerClientError.http("/notifications/\(id)/read", (response as? HTTPURLResponse)?.statusCode ?? 0, "")
        }
    }

    private func getRaw(url: URL, path: String) async throws -> Data {
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        guard (200..<300).contains(http.statusCode) else {
            throw WorkerClientError.http(path, http.statusCode, String(data: data, encoding: .utf8) ?? "<binary>")
        }
        return data
    }

    // MARK: - Browser auth profiles (device-bound)

    struct BrowserAuthProfile: Decodable, Identifiable, Equatable {
        let id: Int
        let slug: String
        let display_name: String
        let connector_key: String
        let profile_kind: String
        let status: String
        let browser_kind: String?
        let user_data_dir: String?
        let cdp_url: String?
        let created_at: String?
        let updated_at: String?
    }

    private struct BrowserAuthProfilesList: Decodable {
        let profiles: [BrowserAuthProfile]
    }

    private struct BrowserAuthProfileEnvelope: Decodable {
        let profile: BrowserAuthProfile
    }

    func listMyBrowserAuthProfiles(workerId: String) async throws -> [BrowserAuthProfile] {
        guard var components = URLComponents(string: "\(baseURL.trimmedTrailingSlash())/api/workers/me/auth-profiles") else {
            throw URLError(.badURL)
        }
        components.queryItems = [URLQueryItem(name: "worker_id", value: workerId)]
        guard let url = components.url else { throw URLError(.badURL) }
        let data = try await getRaw(url: url, path: "/api/workers/me/auth-profiles")
        let list = try decoder.decode(BrowserAuthProfilesList.self, from: data)
        return list.profiles
    }

    func createMyBrowserAuthProfile(
        workerId: String,
        connectorKey: String,
        displayName: String,
        browserKind: String,
        userDataDir: String?,
        cdpUrl: String?
    ) async throws -> BrowserAuthProfile {
        struct Body: Encodable {
            let worker_id: String
            let connector_key: String
            let display_name: String
            let browser_kind: String
            let user_data_dir: String?
            let cdp_url: String?
        }
        let data = try await post(
            "/api/workers/me/auth-profiles",
            body: Body(
                worker_id: workerId,
                connector_key: connectorKey,
                display_name: displayName,
                browser_kind: browserKind,
                user_data_dir: userDataDir,
                cdp_url: cdpUrl
            )
        )
        let envelope = try decoder.decode(BrowserAuthProfileEnvelope.self, from: data)
        return envelope.profile
    }

    func deleteMyBrowserAuthProfile(workerId: String, profileId: Int) async throws {
        struct Body: Encodable { let worker_id: String }
        guard let url = URL(string: "\(baseURL.trimmedTrailingSlash())/api/workers/me/auth-profiles/\(profileId)") else {
            throw URLError(.badURL)
        }
        var request = URLRequest(url: url)
        request.httpMethod = "DELETE"
        request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try encoder.encode(Body(worker_id: workerId))
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            let code = (response as? HTTPURLResponse)?.statusCode ?? 0
            throw WorkerClientError.http("/api/workers/me/auth-profiles/\(profileId)", code, String(data: data, encoding: .utf8) ?? "")
        }
    }

    // MARK: - Device feeds

    struct DeviceFeed: Decodable {
        let id: Int
        let feed_key: String?
        let display_name: String?
        let status: String?
        let config: [String: AnyJSONValue]?
    }

    struct DeviceFeedsResponse: Decodable {
        let connection_id: Int?
        let organization_id: String?
        let feeds: [DeviceFeed]
    }

    func listMyDeviceFeeds(workerId: String, connectorKey: String) async throws -> DeviceFeedsResponse {
        guard var components = URLComponents(string: "\(baseURL.trimmedTrailingSlash())/api/workers/me/feeds") else {
            throw URLError(.badURL)
        }
        components.queryItems = [
            URLQueryItem(name: "worker_id", value: workerId),
            URLQueryItem(name: "connector_key", value: connectorKey),
        ]
        guard let url = components.url else { throw URLError(.badURL) }
        let data = try await getRaw(url: url, path: "/api/workers/me/feeds")
        return try decoder.decode(DeviceFeedsResponse.self, from: data)
    }

    func createMyDeviceFeed(
        workerId: String,
        connectorKey: String,
        feedKey: String,
        displayName: String,
        config: [String: AnyEncodable]
    ) async throws -> DeviceFeed {
        struct Body: Encodable {
            let worker_id: String
            let connector_key: String
            let feed_key: String
            let display_name: String
            let config: [String: AnyEncodable]
        }
        struct Envelope: Decodable { let feed: DeviceFeed }
        let data = try await post(
            "/api/workers/me/feeds",
            body: Body(
                worker_id: workerId,
                connector_key: connectorKey,
                feed_key: feedKey,
                display_name: displayName,
                config: config
            )
        )
        return try decoder.decode(Envelope.self, from: data).feed
    }

    struct BrowserConnectorOption: Decodable, Identifiable, Equatable, Hashable {
        let key: String
        let name: String
        let favicon_domain: String?
        var id: String { key }
    }

    private struct BrowserConnectorsResponse: Decodable {
        let connectors: [BrowserConnectorOption]
    }

    func listBrowserConnectors(workerId: String) async throws -> [BrowserConnectorOption] {
        guard var components = URLComponents(string: "\(baseURL.trimmedTrailingSlash())/api/workers/me/browser-connectors") else {
            throw URLError(.badURL)
        }
        components.queryItems = [URLQueryItem(name: "worker_id", value: workerId)]
        guard let url = components.url else { throw URLError(.badURL) }
        let data = try await getRaw(url: url, path: "/api/workers/me/browser-connectors")
        return try decoder.decode(BrowserConnectorsResponse.self, from: data).connectors
    }

    func deleteMyDeviceFeed(workerId: String, connectorKey: String, feedId: Int) async throws {
        struct Body: Encodable { let worker_id: String; let connector_key: String }
        guard let url = URL(string: "\(baseURL.trimmedTrailingSlash())/api/workers/me/feeds/\(feedId)") else {
            throw URLError(.badURL)
        }
        var request = URLRequest(url: url)
        request.httpMethod = "DELETE"
        request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try encoder.encode(Body(worker_id: workerId, connector_key: connectorKey))
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            let code = (response as? HTTPURLResponse)?.statusCode ?? 0
            throw WorkerClientError.http("/api/workers/me/feeds/\(feedId)", code, String(data: data, encoding: .utf8) ?? "")
        }
    }

    private func post<T: Encodable>(_ path: String, body: T) async throws -> Data {
        guard let url = URL(string: "\(baseURL.trimmedTrailingSlash())\(path)") else { throw URLError(.badURL) }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try encoder.encode(body)
        let (data, response) = try await session.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        guard (200..<300).contains(httpResponse.statusCode) else {
            throw WorkerClientError.http(path, httpResponse.statusCode, String(data: data, encoding: .utf8) ?? "<binary>")
        }
        return data
    }
}

func isoString(_ date: Date) -> String { ISO8601DateFormatter().string(from: date) }

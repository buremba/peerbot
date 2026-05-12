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

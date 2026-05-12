import AppKit
import Foundation

// Direct port of the iOS app's OAuthClient. Differences:
//   - imports AppKit (not UIKit) and uses NSWorkspace.shared.open for the
//     device-approve link instead of UIApplication.shared.open.
//   - software_id = "lobu-mac" so server-side telemetry can tell the two
//     surfaces apart.
//   - openVerificationURL appends `return_to=lobu-mac://oauth/...` using the
//     Mac app's URL scheme.

struct OAuthDiscovery: Codable, Equatable {
    let issuer: String?
    let registration_endpoint: String
    let device_authorization_endpoint: String
    let token_endpoint: String
    let userinfo_endpoint: String?
}

struct RegisteredOAuthClient: Codable, Equatable {
    let client_id: String
    let client_secret: String?
}

struct DeviceAuthorizationResponse: Codable, Equatable {
    let device_code: String
    let user_code: String
    let verification_uri: String
    let verification_uri_complete: String?
    /// Seconds the device code stays valid, relative to this response. Callers
    /// must turn it into an absolute deadline once, not re-derive it per poll.
    let expires_in: Int
    let interval: Int?
}

struct OAuthTokenResponse: Codable, Equatable {
    let access_token: String
    let token_type: String
    let expires_in: Int?
    let refresh_token: String?
    let scope: String?
}

struct OAuthUserInfo: Codable, Equatable {
    struct Organization: Codable, Equatable, Identifiable {
        var id: String { slug }
        let slug: String
        let name: String
    }

    let sub: String
    let email: String
    let name: String?
    let organization_slug: String?
    let organizations: [Organization]
}

struct OAuthCredentials: Codable, Equatable {
    let baseURL: String
    let clientID: String
    let clientSecret: String?
    var accessToken: String
    var refreshToken: String?
    var expiresAt: Date?
    var userInfo: OAuthUserInfo?

    var displayName: String {
        userInfo?.name ?? userInfo?.email ?? "Signed in"
    }
}

enum OAuthPollResult {
    case pending(slowDown: Bool)
    case complete(OAuthTokenResponse)
}

enum OAuthClientError: LocalizedError {
    case server(String)

    var errorDescription: String? {
        switch self {
        case let .server(message): return message
        }
    }
}

final class OAuthClient {
    static let scope = "device_worker:run profile:read"

    private let baseURL: URL
    private let session: URLSession
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    init(baseURL: String, session: URLSession = .shared) throws {
        guard let url = URL(string: baseURL.trimmedTrailingSlash()) else { throw URLError(.badURL) }
        self.baseURL = url
        self.session = session
        decoder.dateDecodingStrategy = .iso8601
        encoder.dateEncodingStrategy = .iso8601
    }

    func discover() async throws -> OAuthDiscovery {
        do {
            return try await getJSON(baseURL.appending(path: ".well-known/oauth-authorization-server"))
        } catch {
            // The first network hop — turn a generic failure into something the
            // user can act on (wrong URL / wrong port / server not running).
            throw OAuthClientError.server(
                "Couldn't reach a Lobu server at \(baseURL.absoluteString) — is it running? Check the URL."
            )
        }
    }

    func registerClient(_ discovery: OAuthDiscovery) async throws -> RegisteredOAuthClient {
        try await postJSON(
            URL(string: discovery.registration_endpoint)!,
            body: [
                "client_name": "Lobu for Mac",
                "software_id": "lobu-mac",
                "software_version": "0.1.0",
                "grant_types": ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
                "token_endpoint_auth_method": "none",
                "scope": Self.scope,
            ] as [String: Any]
        )
    }

    func startDeviceAuthorization(_ discovery: OAuthDiscovery, client: RegisteredOAuthClient) async throws -> DeviceAuthorizationResponse {
        try await postJSON(
            URL(string: discovery.device_authorization_endpoint)!,
            body: ["client_id": client.client_id, "scope": Self.scope]
        )
    }

    func pollDeviceToken(_ discovery: OAuthDiscovery, client: RegisteredOAuthClient, deviceCode: String) async throws -> OAuthPollResult {
        let response = try await postRawJSON(
            URL(string: discovery.token_endpoint)!,
            body: [
                "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
                "client_id": client.client_id,
                "device_code": deviceCode,
            ].withClientSecret(client.client_secret)
        )

        if (200..<300).contains(response.statusCode) {
            return .complete(try decoder.decode(OAuthTokenResponse.self, from: response.data))
        }
        let error = (try? decoder.decode(OAuthErrorResponse.self, from: response.data))
        if error?.error == "authorization_pending" || error?.error == "slow_down" {
            return .pending(slowDown: error?.error == "slow_down")
        }
        throw OAuthClientError.server(error?.error_description ?? error?.error ?? "OAuth token request failed")
    }

    func refresh(_ credentials: OAuthCredentials, discovery: OAuthDiscovery) async throws -> OAuthCredentials {
        guard let refreshToken = credentials.refreshToken else { return credentials }
        let response: OAuthTokenResponse = try await postJSON(
            URL(string: discovery.token_endpoint)!,
            body: [
                "grant_type": "refresh_token",
                "client_id": credentials.clientID,
                "refresh_token": refreshToken,
            ].withClientSecret(credentials.clientSecret)
        )
        return OAuthCredentials(
            baseURL: credentials.baseURL,
            clientID: credentials.clientID,
            clientSecret: credentials.clientSecret,
            accessToken: response.access_token,
            refreshToken: response.refresh_token ?? credentials.refreshToken,
            expiresAt: response.expires_in.map { Date().addingTimeInterval(TimeInterval($0)) },
            userInfo: credentials.userInfo
        )
    }

    func fetchUserInfo(_ endpoint: String?, accessToken: String) async throws -> OAuthUserInfo? {
        guard let endpoint, let url = URL(string: endpoint) else { return nil }
        var request = URLRequest(url: url)
        request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        let (data, response) = try await session.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse, (200..<300).contains(httpResponse.statusCode) else {
            return nil
        }
        return try decoder.decode(OAuthUserInfo.self, from: data)
    }

    /// Opens the device-code verification URL in the user's default browser
    /// via NSWorkspace (the Mac equivalent of iOS's UIApplication.shared.open).
    func openVerificationURL(_ authorization: DeviceAuthorizationResponse) {
        guard var components = URLComponents(string: authorization.verification_uri_complete ?? authorization.verification_uri) else { return }
        var queryItems = components.queryItems ?? []
        queryItems.append(URLQueryItem(name: "return_to", value: "lobu-mac://oauth/device-approved"))
        components.queryItems = queryItems
        guard let url = components.url else { return }
        NSWorkspace.shared.open(url)
    }

    // -------------------------------------------------------------------------

    private func getJSON<T: Decodable>(_ url: URL) async throws -> T {
        let (data, response) = try await session.data(from: url)
        guard let httpResponse = response as? HTTPURLResponse, (200..<300).contains(httpResponse.statusCode) else {
            throw OAuthClientError.server("OAuth discovery failed")
        }
        return try decoder.decode(T.self, from: data)
    }

    private func postJSON<T: Decodable>(_ url: URL, body: [String: Any]) async throws -> T {
        let raw = try await postRawJSON(url, body: body)
        guard (200..<300).contains(raw.statusCode) else {
            let error = (try? decoder.decode(OAuthErrorResponse.self, from: raw.data))
            throw OAuthClientError.server(error?.error_description ?? error?.error ?? "OAuth request failed")
        }
        return try decoder.decode(T.self, from: raw.data)
    }

    private func postRawJSON(_ url: URL, body: [String: Any]) async throws -> (statusCode: Int, data: Data) {
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, response) = try await session.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        return (httpResponse.statusCode, data)
    }
}

private struct OAuthErrorResponse: Codable {
    let error: String
    let error_description: String?
}

private extension Dictionary where Key == String, Value == String {
    func withClientSecret(_ secret: String?) -> [String: String] {
        var copy = self
        if let secret { copy["client_secret"] = secret }
        return copy
    }
}

extension String {
    func trimmedTrailingSlash() -> String {
        var value = self
        while value.hasSuffix("/") { value.removeLast() }
        return value
    }
}

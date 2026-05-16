// Chrome native-messaging host for Owletto for Chrome.
//
// Two responsibilities:
//
// 1. `installManifests` — on Mac app launch, write the host manifest JSON
//    into each detected Chromium-family browser's `NativeMessagingHosts`
//    directory. Each manifest points back at this Mac app's executable +
//    declares the Chrome extension IDs allowed to talk to it. Idempotent.
//
// 2. `runHostIfRequested` — when the Mac binary is spawned with the
//    `--owletto-bridge` argument (Chrome launches us as a subprocess of the
//    extension), serve a single native-messaging request/response cycle on
//    stdin/stdout and exit. The protocol is Chrome's standard: 4-byte
//    little-endian length-prefixed UTF-8 JSON frames.
//
// Auth chain: the Mac app's OAuth bearer is read from KeychainTokenStore,
// then handed to the gateway's POST /api/me/devices/mint-child-token to mint
// a fresh PAT bound to a new chrome-extension worker_id. The host hands
// `{gateway_url, worker_id, access_token}` back to the extension, which
// stores them and starts polling. Zero second login.
//
// Xcode wiring (until automated): this file needs to be added to the Lobu
// target. The LobuApp.swift entry point must call
// `ChromeBridgeHost.runHostIfRequested()` BEFORE building any SwiftUI
// scene — Chrome expects a pure stdio child process. The installer should
// be called from AppState's startup (after credentials are loaded so we
// know which user owns the device manifests).

import Foundation

enum ChromeBridgeHost {
    /// Native-messaging host name. Must match the extension's
    /// `chrome.runtime.connectNative()` argument.
    static let hostName = "ai.owletto.bridge"

    /// If the binary was invoked with `--owletto-bridge`, run a single
    /// native-messaging request cycle on stdin/stdout and exit. Otherwise
    /// returns immediately so the normal app launch can proceed.
    static func runHostIfRequested() {
        guard CommandLine.arguments.contains("--owletto-bridge") else { return }
        let exitCode = NativeMessagingLoop.run()
        exit(exitCode)
    }

    /// Drop the host manifest into every detected Chromium-family browser's
    /// NativeMessagingHosts directory. Idempotent; safe to call on every
    /// app launch.
    ///
    /// `extensionIds` is the list of `chrome-extension://<id>/` origins the
    /// host accepts messages from. Today we accept the canonical Owletto
    /// Web Store ID + (when set) the LOBU_OWLETTO_CHROME_EXTENSION_ID env
    /// override so unpacked dev builds work without rebuilding the Mac app.
    static func installManifests(extensionIds: [String]) {
        let executablePath = Bundle.main.executablePath ?? CommandLine.arguments[0]
        let origins = extensionIds.map { "chrome-extension://\($0)/" }
        let manifest: [String: Any] = [
            "name": hostName,
            "description": "Owletto Mac bridge — Chrome native-messaging host",
            "path": executablePath + " --owletto-bridge",
            "type": "stdio",
            "allowed_origins": origins,
        ]
        guard
            let json = try? JSONSerialization.data(
                withJSONObject: manifest,
                options: [.prettyPrinted, .sortedKeys]
            )
        else { return }

        for target in browserTargets() {
            let dir = target.userDataRoot.appendingPathComponent("NativeMessagingHosts", isDirectory: true)
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            let manifestURL = dir.appendingPathComponent("\(hostName).json")
            try? json.write(to: manifestURL, options: .atomic)
        }
    }

    // The directories listed here mirror InstalledBrowser.Kind in
    // BrowserProfileManager.swift. We don't gate by "is browser installed?"
    // because the user may install Chrome after the Mac app — letting the
    // manifest land in an empty dir is harmless and means pairing works the
    // moment they do install + load the extension.
    private static func browserTargets() -> [(name: String, userDataRoot: URL)] {
        let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        return [
            ("Google Chrome", appSupport.appendingPathComponent("Google/Chrome", isDirectory: true)),
            ("Brave", appSupport.appendingPathComponent("BraveSoftware/Brave-Browser", isDirectory: true)),
            ("Arc", appSupport.appendingPathComponent("Arc/User Data", isDirectory: true)),
            ("Microsoft Edge", appSupport.appendingPathComponent("Microsoft Edge", isDirectory: true)),
        ]
    }
}

// MARK: - Native-messaging stdin/stdout loop --------------------------------

private struct BridgeError: Error {
    let message: String
    init(_ message: String) { self.message = message }
}

private enum NativeMessagingLoop {
    /// Returns the process exit code.
    static func run() -> Int32 {
        let input = FileHandle.standardInput
        let output = FileHandle.standardOutput
        guard let frame = readFrame(input) else {
            sendError(output, "missing_request_frame")
            return 1
        }
        guard
            let req = try? JSONSerialization.jsonObject(with: frame) as? [String: Any],
            let op = req["op"] as? String
        else {
            sendError(output, "malformed_request")
            return 1
        }
        switch op {
        case "pair":
            let platform = (req["platform"] as? String) ?? "chrome-extension"
            let result = mintChildToken(platform: platform)
            switch result {
            case .success(let payload):
                writeFrame(output, payload)
            case .failure(let err):
                sendError(output, err.message)
            }
        default:
            sendError(output, "unknown_op")
        }
        return 0
    }

    // MARK: child-token mint over HTTPS

    /// Calls POST /api/me/devices/mint-child-token using the Mac app's
    /// stored OAuth credentials. Synchronous — native-messaging hosts are
    /// short-lived stdio children, not long-running processes.
    private static func mintChildToken(platform: String) -> Result<[String: Any], BridgeError> {
        // Credentials are written by AppState's signin flow into the
        // KeychainTokenStore. Read them back from the same OS keychain item.
        // (Keeping this self-contained vs. importing AppState avoids dragging
        // SwiftUI into the host subprocess.)
        guard let creds = OwlettoBridgeCredentials.load() else {
            return .failure(BridgeError("mac_not_signed_in"))
        }

        let url = creds.baseURL.appendingPathComponent("/api/me/devices/mint-child-token")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("Bearer \(creds.accessToken)", forHTTPHeaderField: "Authorization")
        request.httpBody = try? JSONSerialization.data(
            withJSONObject: ["platform": platform]
        )

        let sem = DispatchSemaphore(value: 0)
        var responseData: Data?
        var responseStatus: Int = 0
        var responseError: Error?
        URLSession.shared.dataTask(with: request) { data, response, err in
            responseData = data
            if let http = response as? HTTPURLResponse { responseStatus = http.statusCode }
            responseError = err
            sem.signal()
        }.resume()
        sem.wait()

        if let err = responseError {
            return .failure(BridgeError("network: \(err.localizedDescription)"))
        }
        guard (200..<300).contains(responseStatus), let data = responseData else {
            return .failure(BridgeError("gateway_status_\(responseStatus)"))
        }
        guard
            let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let workerId = obj["worker_id"] as? String,
            let token = obj["access_token"] as? String,
            let gatewayUrl = obj["gateway_url"] as? String
        else {
            return .failure(BridgeError("malformed_gateway_response"))
        }
        return .success([
            "gateway_url": gatewayUrl,
            "worker_id": workerId,
            "access_token": token,
        ])
    }

    // MARK: framing

    private static func readFrame(_ fh: FileHandle) -> Data? {
        let header = fh.availableData.prefix(4)
        let lenData: Data
        if header.count == 4 {
            lenData = Data(header)
        } else {
            // availableData can return less than 4 — loop to fill.
            var buf = Data(header)
            while buf.count < 4 {
                let chunk = fh.availableData
                if chunk.isEmpty { return nil }
                buf.append(chunk)
            }
            lenData = buf.prefix(4)
        }
        let len = lenData.withUnsafeBytes { $0.loadUnaligned(as: UInt32.self) }
        var payload = Data()
        while payload.count < Int(len) {
            let chunk = fh.availableData
            if chunk.isEmpty { return nil }
            payload.append(chunk)
        }
        return payload.prefix(Int(len))
    }

    private static func writeFrame(_ fh: FileHandle, _ payload: [String: Any]) {
        guard let body = try? JSONSerialization.data(withJSONObject: payload) else { return }
        var len = UInt32(body.count).littleEndian
        let header = Data(bytes: &len, count: 4)
        try? fh.write(contentsOf: header)
        try? fh.write(contentsOf: body)
    }

    private static func sendError(_ fh: FileHandle, _ message: String) {
        writeFrame(fh, ["error": message])
    }
}

// MARK: - Credential loader -------------------------------------------------

/// Wraps KeychainTokenStore for the bridge subprocess. Same keychain item
/// AppState reads/writes — single source of truth for the user's signed-in
/// state. Returns nil when the user hasn't signed into the Mac app yet,
/// which causes the host to reply `{"error":"mac_not_signed_in"}` and the
/// extension falls back to its own OAuth device-authorization flow.
private struct OwlettoBridgeCredentials {
    let baseURL: URL
    let accessToken: String

    static func load() -> OwlettoBridgeCredentials? {
        let store = KeychainCredentialStore()
        guard
            let creds = store.load(),
            let url = URL(string: creds.baseURL)
        else { return nil }
        return OwlettoBridgeCredentials(baseURL: url, accessToken: creds.accessToken)
    }
}

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

    /// If the binary was launched as a Chrome native-messaging child, run a
    /// single request cycle on stdin/stdout and exit. Otherwise returns
    /// immediately so the normal app launch can proceed.
    ///
    /// Detection: Chrome always passes the calling extension's origin
    /// (`chrome-extension://<id>/`) as `argv[1]`. A normal `open Lobu.app`
    /// launch never produces that signature. Keeping the trigger this way
    /// means we don't need a wrapper script — Chrome's native-messaging spec
    /// doesn't allow arguments in `manifest.path`, so a custom `--flag`
    /// approach doesn't work.
    static func runHostIfRequested() {
        let args = CommandLine.arguments
        guard args.count >= 2, args[1].hasPrefix("chrome-extension://") else {
            return
        }
        #if DEBUG
        FileHandle.standardError.write("[bridge] runHostIfRequested entry\n".data(using: .utf8)!)
        #endif
        let exitCode = NativeMessagingLoop.run()
        #if DEBUG
        FileHandle.standardError.write("[bridge] runHostIfRequested exit=\(exitCode)\n".data(using: .utf8)!)
        #endif
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
            "path": executablePath,
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
        debug("readFrame:start")
        guard let frame = readFrame(input) else {
            sendError(output, "missing_request_frame")
            return 1
        }
        debug("readFrame:done(\(frame.count))")
        guard
            let req = try? JSONSerialization.jsonObject(with: frame) as? [String: Any],
            let op = req["op"] as? String
        else {
            sendError(output, "malformed_request")
            return 1
        }
        debug("op=\(op)")
        switch op {
        case "pair":
            let platform = (req["platform"] as? String) ?? "chrome-extension"
            debug("mintChildToken:start")
            let result = mintChildToken(platform: platform)
            debug("mintChildToken:done")
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

    private static func debug(_ message: String) {
        #if DEBUG
        FileHandle.standardError.write("[bridge] \(message)\n".data(using: .utf8)!)
        #endif
    }

    // MARK: child-token mint over HTTPS

    /// Calls POST /api/me/devices/mint-child-token using the Mac app's
    /// stored OAuth credentials. Synchronous — native-messaging hosts are
    /// short-lived stdio children, not long-running processes.
    private static func mintChildToken(platform: String) -> Result<[String: Any], BridgeError> {
        debug("mintChildToken:loadingCreds")
        guard let creds = OwlettoBridgeCredentials.load() else {
            return .failure(BridgeError("mac_not_signed_in"))
        }
        debug("mintChildToken:credsLoaded(\(creds.baseURL.absoluteString))")

        let url = creds.baseURL.appendingPathComponent("/api/me/devices/mint-child-token")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("Bearer \(creds.accessToken)", forHTTPHeaderField: "Authorization")
        // No-auth CSRF middleware requires this on mutations when Origin is
        // absent; harmless on remote/cloud where Origin would already pass.
        request.setValue("menubar", forHTTPHeaderField: "X-Lobu-Client")
        request.httpBody = try? JSONSerialization.data(
            withJSONObject: ["platform": platform]
        )

        // URLSession.shared delivers completion handlers on the main queue
        // by default. The bridge runs synchronously on the main thread, so
        // a sem.wait() on URLSession.shared deadlocks (the completion
        // handler never gets to fire). A dedicated session with its own
        // delegate queue side-steps that.
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 10
        let queue = OperationQueue()
        let session = URLSession(configuration: config, delegate: nil, delegateQueue: queue)
        debug("urlsession:dispatch")
        let sem = DispatchSemaphore(value: 0)
        var responseData: Data?
        var responseStatus: Int = 0
        var responseError: Error?
        session.dataTask(with: request) { data, response, err in
            responseData = data
            if let http = response as? HTTPURLResponse { responseStatus = http.statusCode }
            responseError = err
            sem.signal()
        }.resume()
        debug("urlsession:waiting")
        sem.wait()
        debug("urlsession:returned status=\(responseStatus)")
        session.finishTasksAndInvalidate()

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

    /// Chrome's native-messaging spec caps host→browser messages at 1 MB
    /// and browser→host at 4 GB, but our host only handles a tiny
    /// `{op, platform, label?}` request. Reject anything over 64 KB —
    /// keeps a buggy or compromised extension from making the host hang or
    /// memory-pressure on a malicious length header.
    private static let maxFramePayloadBytes = 64 * 1024

    /// Read one length-prefixed JSON frame from stdin. Accumulates every
    /// chunk `availableData` returns into a single buffer — that call
    /// consumes the bytes, so a "peek 4" approach loses anything that
    /// arrived in the same chunk after the length header. (Chrome usually
    /// writes the whole frame in one go.)
    private static func readFrame(_ fh: FileHandle) -> Data? {
        var buf = Data()
        while buf.count < 4 {
            let chunk = fh.availableData
            if chunk.isEmpty { return nil }
            buf.append(chunk)
        }
        let length = buf.prefix(4).withUnsafeBytes { $0.loadUnaligned(as: UInt32.self) }
        if Int(length) > maxFramePayloadBytes { return nil }
        let payloadEnd = 4 + Int(length)
        while buf.count < payloadEnd {
            let chunk = fh.availableData
            if chunk.isEmpty { return nil }
            buf.append(chunk)
        }
        return buf.subdata(in: 4..<payloadEnd)
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
        #if DEBUG
        // Dev escape hatch: env vars bypass keychain so we can exercise the
        // bridge from an ad-hoc-signed binary without going through the
        // TCC keychain prompt. Production builds (RELEASE) never read these.
        if
            let baseURLString = ProcessInfo.processInfo.environment["LOBU_BRIDGE_TEST_BASE_URL"],
            let token = ProcessInfo.processInfo.environment["LOBU_BRIDGE_TEST_TOKEN"],
            let url = URL(string: baseURLString)
        {
            return OwlettoBridgeCredentials(baseURL: url, accessToken: token)
        }
        #endif
        let store = KeychainCredentialStore()
        guard
            let creds = store.load(),
            let url = URL(string: creds.baseURL)
        else { return nil }
        return OwlettoBridgeCredentials(baseURL: url, accessToken: creds.accessToken)
    }
}

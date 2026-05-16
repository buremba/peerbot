import Foundation

/// Spawns and supervises a local `lobu run` so Lobu can sync into a workspace
/// on this machine without Lobu Cloud or a separate server.
///
/// The project lives at `~/lobu` (created if absent — `lobu run` boots with the
/// bundled PGlite store, no Docker/Postgres, no scaffolding needed; the user can
/// `lobu init --here` there later to add agents). Relies on the `@lobu/cli`
/// being installed (searched on `$PATH`, plus `~/.bun/bin`, Homebrew,
/// `/usr/local/bin`, and a bundled-in-.app slot for later); if it isn't, surfaces
/// `.cliNotFound` so the UI can tell the user how to install it.
///
/// The app is not sandboxed, so spawning a subprocess is allowed. A clean quit
/// SIGTERMs the child; if the app dies uncleanly the leftover process is
/// harmless — `start()` reconnects to it instead of spawning a second one.
final class LocalLobuRunner {
    enum RunnerError: LocalizedError {
        case cliNotFound
        case projectDir(Error)
        case spawn(Error)
        case exitedEarly(logPath: String)
        case notReady(logPath: String)

        var errorDescription: String? {
            switch self {
            case .cliNotFound:
                return "The Lobu CLI isn't installed. Run `npm i -g @lobu/cli` (or `bun add -g @lobu/cli`), then try again."
            case let .projectDir(err):
                return "Couldn't prepare ~/lobu: \(err.localizedDescription)"
            case let .spawn(err):
                return "Couldn't start `lobu run`: \(err.localizedDescription)"
            case let .exitedEarly(logPath):
                return "`lobu run` exited before it was ready — see \(logPath)"
            case let .notReady(logPath):
                return "Lobu didn't come up in time — see \(logPath)"
            }
        }
    }

    static let port = 8787
    static let baseURL = "http://localhost:\(port)"

    private(set) var process: Process?
    /// True iff `start()` actually spawned the server this session (vs.
    /// adopting one that was already listening). The no-auth credential path
    /// uses this to refuse adoption when something else owns the port — a
    /// malicious squatter or someone else's `lobu run` would otherwise
    /// receive our synthesised "Authorization: Bearer noauth" header and
    /// could log it before returning a 401. We're sending a dummy value
    /// today, but the principle still holds.
    private(set) var spawnedThisSession: Bool = false
    private let projectDir: URL
    private let logFile: URL

    init() {
        self.projectDir = URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("lobu", isDirectory: true)
        let logs = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Logs/Lobu", isDirectory: true)
        try? FileManager.default.createDirectory(at: logs, withIntermediateDirectories: true)
        self.logFile = logs.appendingPathComponent("lobu-run.log")
    }

    /// Returns the local gateway URL once it's reachable. If a Lobu is already
    /// listening on the port (left over, or the user started one), connects to
    /// it instead of spawning a second instance.
    func start() async throws -> String {
        if await Self.isLobuReachable(Self.baseURL) { return Self.baseURL }

        guard let lobu = Self.locateLobuCLI() else { throw RunnerError.cliNotFound }

        do {
            try FileManager.default.createDirectory(at: projectDir, withIntermediateDirectories: true)
        } catch {
            throw RunnerError.projectDir(error)
        }

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: lobu)
        proc.arguments = ["run", "--port", String(Self.port)]
        proc.currentDirectoryURL = projectDir
        var env = ProcessInfo.processInfo.environment
        env["LOBU_DATA_DIR"] = projectDir.appendingPathComponent("data").path
        // No-auth mode: server attributes every request to the local user
        // without an OAuth flow, a token, or a sign-in screen. Personal-use
        // model — see docs/plans/personal-mode-auth.md for the threat model.
        env["LOBU_NO_AUTH"] = "1"
        // The server hard-fails to start with LOBU_NO_AUTH=1 on a non-loopback
        // bind. start-local.ts defaults HOST to 0.0.0.0, so we must pin it
        // explicitly here — otherwise the runner just crashes on boot.
        env["HOST"] = "127.0.0.1"
        proc.environment = env
        proc.standardInput = FileHandle.nullDevice  // no TTY — any prompt gets EOF and fails fast

        FileManager.default.createFile(atPath: logFile.path, contents: nil)
        if let handle = try? FileHandle(forWritingTo: logFile) {
            handle.seekToEndOfFile()
            proc.standardOutput = handle
            proc.standardError = handle
        }

        do {
            try proc.run()
            process = proc
            spawnedThisSession = true
            NSLog("[LocalLobuRunner] started \(lobu) run --port \(Self.port) (pid=\(proc.processIdentifier)) log=\(logFile.path)")
        } catch {
            throw RunnerError.spawn(error)
        }

        for _ in 0..<45 {
            if proc.isRunning == false {
                process = nil
                spawnedThisSession = false
                throw RunnerError.exitedEarly(logPath: logFile.path)
            }
            if await Self.isLobuReachable(Self.baseURL) { return Self.baseURL }
            try? await Task.sleep(for: .seconds(1))
        }
        proc.terminate()
        process = nil
        spawnedThisSession = false
        throw RunnerError.notReady(logPath: logFile.path)
    }

    func stop() {
        guard let proc = process, proc.isRunning else {
            process = nil
            spawnedThisSession = false
            return
        }
        proc.terminate()
        process = nil
        spawnedThisSession = false
        NSLog("[LocalLobuRunner] stopped local Lobu")
    }

    /// True if `<baseURL>/.well-known/oauth-authorization-server` returns Lobu's
    /// OAuth metadata — used both to detect an already-running instance and to
    /// validate a URL the user typed.
    static func isLobuReachable(_ baseURL: String) async -> Bool {
        let trimmed = baseURL.trimmedTrailingSlash()
        guard let url = URL(string: "\(trimmed)/.well-known/oauth-authorization-server") else { return false }
        var request = URLRequest(url: url)
        request.timeoutInterval = 2
        guard
            let (data, response) = try? await URLSession.shared.data(for: request),
            let http = response as? HTTPURLResponse, http.statusCode == 200,
            let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            json["device_authorization_endpoint"] != nil
        else { return false }
        return true
    }

    private static func locateLobuCLI() -> String? {
        if let resourceURL = Bundle.main.resourceURL {
            let bundled = resourceURL.appendingPathComponent("lobu-cli/bin/lobu").path
            if FileManager.default.isExecutableFile(atPath: bundled) { return bundled }
        }
        var dirs = (ProcessInfo.processInfo.environment["PATH"] ?? "")
            .split(separator: ":")
            .map(String.init)
        dirs.append("\(NSHomeDirectory())/.bun/bin")
        dirs.append("/opt/homebrew/bin")
        dirs.append("/usr/local/bin")
        for dir in dirs where !dir.isEmpty {
            let candidate = "\(dir)/lobu"
            if FileManager.default.isExecutableFile(atPath: candidate) { return candidate }
        }
        return nil
    }
}

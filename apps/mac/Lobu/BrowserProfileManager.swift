import AppKit
import Foundation

/// Per-browser metadata for the supported Chromium-family browsers Lobu can
/// host as `browser_session` auth profiles. We don't support Firefox yet —
/// its remote-protocol story is different from CDP and connectors all assume
/// Playwright Chromium underneath.
struct InstalledBrowser: Identifiable, Hashable {
    enum Kind: String, CaseIterable, Identifiable, Hashable {
        case chrome
        case brave
        case arc
        case edge
        var id: String { rawValue }

        var displayName: String {
            switch self {
            case .chrome: return "Google Chrome"
            case .brave: return "Brave"
            case .arc: return "Arc"
            case .edge: return "Microsoft Edge"
            }
        }

        var bundleIdentifier: String {
            switch self {
            case .chrome: return "com.google.Chrome"
            case .brave: return "com.brave.Browser"
            case .arc: return "company.thebrowser.Browser"
            case .edge: return "com.microsoft.edgemac"
            }
        }

        /// Path to the browser's user-data root under ~/Library/Application Support.
        /// Each Chromium-family browser writes profiles as subdirectories
        /// ("Default", "Profile 1", "Work", …) plus a `Local State` JSON
        /// listing display names.
        var userDataRootRelativePath: String {
            switch self {
            case .chrome: return "Google/Chrome"
            case .brave: return "BraveSoftware/Brave-Browser"
            case .arc: return "Arc/User Data"
            case .edge: return "Microsoft Edge"
            }
        }
    }

    let kind: Kind
    let applicationURL: URL
    let userDataRoot: URL
    var id: String { kind.rawValue }
}

/// Source profile within an installed browser (the user-visible "Default" /
/// "Profile 1" / "Work" subdirectory). Cookies and localStorage live inside.
struct InstalledBrowserProfile: Identifiable, Hashable {
    let browser: InstalledBrowser
    let directoryName: String
    let displayName: String
    var id: String { "\(browser.kind.rawValue)/\(directoryName)" }
    var sourcePath: URL { browser.userDataRoot.appendingPathComponent(directoryName) }
}

/// Discovers installed Chromium-family browsers + their profiles, and owns
/// the lifecycle of Lobu's managed `--user-data-dir` copies that back each
/// device-bound `browser_session` auth profile. Cookies live inside these
/// dirs and never travel to the server.
enum BrowserProfileManager {
    /// Where Lobu keeps managed profile dirs. One subdirectory per auth_profile
    /// row (keyed by the server-issued id once known; provisional ones live
    /// under a UUID until materialized).
    static var managedRoot: URL {
        let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        return appSupport.appendingPathComponent("Lobu/browser-profiles", isDirectory: true)
    }

    static func hasAnyInstalledBrowser() -> Bool {
        !installedBrowsers().isEmpty
    }

    static func installedBrowsers() -> [InstalledBrowser] {
        let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        return InstalledBrowser.Kind.allCases.compactMap { kind in
            // Use Launch Services to find the app — Chrome can live in /Applications
            // or under ~/Applications, and users on managed Macs sometimes get it
            // sandboxed elsewhere.
            guard let appURL = NSWorkspace.shared.urlForApplication(withBundleIdentifier: kind.bundleIdentifier) else {
                return nil
            }
            let dataRoot = appSupport.appendingPathComponent(kind.userDataRootRelativePath, isDirectory: true)
            guard FileManager.default.fileExists(atPath: dataRoot.path) else {
                // Browser is installed but has never been launched — no profile to
                // capture from yet. Hide it from the picker until first launch.
                return nil
            }
            return InstalledBrowser(kind: kind, applicationURL: appURL, userDataRoot: dataRoot)
        }
    }

    /// Read the browser's `Local State` JSON to enumerate source profiles. The
    /// JSON shape is identical across Chrome/Brave/Edge/Arc — the `profile.info_cache`
    /// map keys directory names ("Default", "Profile 1") to a `{ name: "..." }`
    /// blob with the user's chosen display name.
    static func sourceProfiles(for browser: InstalledBrowser) -> [InstalledBrowserProfile] {
        let localStatePath = browser.userDataRoot.appendingPathComponent("Local State")
        guard
            let data = try? Data(contentsOf: localStatePath),
            let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let profile = json["profile"] as? [String: Any],
            let infoCache = profile["info_cache"] as? [String: [String: Any]]
        else {
            // Fall back to "Default" — every Chromium browser ships with it.
            let defaultPath = browser.userDataRoot.appendingPathComponent("Default")
            guard FileManager.default.fileExists(atPath: defaultPath.path) else { return [] }
            return [InstalledBrowserProfile(browser: browser, directoryName: "Default", displayName: "Default")]
        }
        return infoCache
            .map { (dirName, attrs) in
                let name = (attrs["name"] as? String) ?? dirName
                return InstalledBrowserProfile(browser: browser, directoryName: dirName, displayName: name)
            }
            .sorted { $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending }
    }

    /// Probe localhost for a Chrome (or Chromium-family) instance exposing
    /// CDP. Four discovery paths, in priority order:
    ///   1. `<matchUserDataRoot>/DevToolsActivePort` — the file Chrome
    ///      writes when *either* the M144 toggle is enabled OR Chrome was
    ///      launched with `--remote-debugging-port=<N>`. Always trusted
    ///      when present because both modes produce a working WebSocket
    ///      endpoint, even though M144 also disables HTTP `/json/version`
    ///      discovery. Auto-fill of this port is what makes the picker
    ///      pre-populate without the user knowing the port number.
    ///   2. `lsof` — every TCP port the top-level Chrome process is
    ///      listening on. Catches user-launched Chrome with a debug port
    ///      even if matchUserDataRoot wasn't passed.
    ///   3. `ps` — argv-scraped `--remote-debugging-port=<N>`.
    ///   4. The conventional 9222–9225 range.
    ///
    /// For paths 2–4 we additionally probe `/json/version` to confirm
    /// it's a real CDP listener. Path 1 skips that check (the M144
    /// listener intentionally 404s `/json/version` but still serves the
    /// WebSocket endpoint named in the file). The Mac UI just shows the
    /// port; the connector subprocess reads DevToolsActivePort itself at
    /// sync time to get the full ws:// URL.
    static func autoDetectCdpUrl(matchUserDataRoot: URL? = nil) async -> String? {
        if let root = matchUserDataRoot,
           let port = readDevToolsActivePort(at: root)
        {
            return "http://127.0.0.1:\(port)"
        }
        var candidates: [Int] = []
        var seen: Set<Int> = []
        for port in await detectCdpPortsFromLsof() {
            if seen.insert(port).inserted { candidates.append(port) }
        }
        for port in await detectCdpPortsFromPs(matchUserDataRoot: matchUserDataRoot) {
            if seen.insert(port).inserted { candidates.append(port) }
        }
        for port in [9222, 9223, 9224, 9225] {
            if seen.insert(port).inserted { candidates.append(port) }
        }
        for port in candidates {
            if await isCdpReachable(port: port) {
                return "http://127.0.0.1:\(port)"
            }
        }
        return nil
    }

    /// Read `<root>/DevToolsActivePort` and return the port number if the
    /// file is present and well-formed. The file is two lines: port +
    /// WebSocket path. We only need the port for menu-bar pre-fill — the
    /// connector subprocess re-reads the full file at sync time to get
    /// the ws:// path.
    private static func readDevToolsActivePort(at userDataRoot: URL) -> Int? {
        let path = userDataRoot.appendingPathComponent("DevToolsActivePort")
        guard FileManager.default.fileExists(atPath: path.path),
              let contents = try? String(contentsOf: path, encoding: .utf8)
        else { return nil }
        let lines = contents.split(separator: "\n", omittingEmptySubsequences: true)
        guard let first = lines.first,
              let port = Int(first.trimmingCharacters(in: .whitespaces)),
              port > 0, port < 65536
        else { return nil }
        return port
    }

    /// Ask `lsof` which TCP ports the main Google Chrome process is
    /// listening on. Catches the M144 UI-toggle path (port opened
    /// internally, not in argv) that the ps-based scrape misses.
    ///
    /// Output is filtered to Chrome's top-level binary — Helper / GPU
    /// subprocesses don't own listening sockets we care about. Returns
    /// ports in lsof's natural order (no aliveness check yet — caller
    /// probes `/json/version`).
    private static func detectCdpPortsFromLsof() async -> [Int] {
        // Find the top-level Chrome PIDs first; lsof per-PID is cheaper
        // than scanning every process on the box.
        let pids = await topLevelChromePids()
        guard !pids.isEmpty else { return [] }
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/sbin/lsof")
        task.arguments = ["-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-p", pids.joined(separator: ",")]
        let pipe = Pipe()
        task.standardOutput = pipe
        task.standardError = Pipe()
        do { try task.run() } catch { return [] }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        task.waitUntilExit()
        guard let output = String(data: data, encoding: .utf8) else { return [] }
        // lsof rows look like: "Google   99621 user  131u IPv4 0x... 0t0 TCP 127.0.0.1:51697 (LISTEN)"
        // — pull the port after the colon in the NAME column.
        let portRegex = try? NSRegularExpression(pattern: #"127\.0\.0\.1:(\d+)\s+\(LISTEN\)"#)
        var ports: [Int] = []
        var seen: Set<Int> = []
        for line in output.split(separator: "\n") {
            let lineStr = String(line)
            let range = NSRange(lineStr.startIndex..., in: lineStr)
            guard let match = portRegex?.firstMatch(in: lineStr, range: range),
                  let portRange = Range(match.range(at: 1), in: lineStr),
                  let port = Int(lineStr[portRange]) else { continue }
            if seen.insert(port).inserted { ports.append(port) }
        }
        return ports
    }

    /// Top-level Chrome process PIDs (no Helper / GPU children) as
    /// strings, for passing into `lsof -p`.
    private static func topLevelChromePids() async -> [String] {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/bin/ps")
        task.arguments = ["-axo", "pid,command"]
        let pipe = Pipe()
        task.standardOutput = pipe
        task.standardError = Pipe()
        do { try task.run() } catch { return [] }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        task.waitUntilExit()
        guard let output = String(data: data, encoding: .utf8) else { return [] }
        var pids: [String] = []
        for line in output.split(separator: "\n") {
            let lineStr = String(line)
            if !lineStr.contains("Google Chrome.app/Contents/MacOS/Google Chrome") { continue }
            if lineStr.contains("Helper") { continue }
            let parts = lineStr.trimmingCharacters(in: .whitespaces).split(separator: " ", maxSplits: 1)
            if let pidStr = parts.first { pids.append(String(pidStr)) }
        }
        return pids
    }

    /// Walk `ps` output for `--remote-debugging-port=<N>` Chrome processes.
    /// Filters on the optional user-data-root match when provided. Returns
    /// the unique ports in launch order (most-recently-launched first is
    /// approximated by reverse insertion).
    private static func detectCdpPortsFromPs(matchUserDataRoot: URL?) async -> [Int] {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/bin/ps")
        task.arguments = ["-axo", "command"]
        let pipe = Pipe()
        task.standardOutput = pipe
        task.standardError = Pipe()
        do {
            try task.run()
        } catch {
            return []
        }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        task.waitUntilExit()
        guard let output = String(data: data, encoding: .utf8) else { return [] }
        var ports: [Int] = []
        var seen: Set<Int> = []
        let portRegex = try? NSRegularExpression(pattern: #"--remote-debugging-port=(\d+)"#)
        let dataDirRegex = try? NSRegularExpression(pattern: #"--user-data-dir=([^\s]+)"#)
        for line in output.split(separator: "\n") {
            // Filter to the top-level Chrome process (Helper / GPU subprocesses
            // inherit the flags from the parent and would spam duplicates).
            let lineStr = String(line)
            if !lineStr.contains("Contents/MacOS/Google Chrome") { continue }
            if lineStr.contains("Helper") { continue }
            let range = NSRange(lineStr.startIndex..., in: lineStr)
            guard let portMatch = portRegex?.firstMatch(in: lineStr, range: range),
                  let portRange = Range(portMatch.range(at: 1), in: lineStr),
                  let port = Int(lineStr[portRange]) else { continue }
            if let needle = matchUserDataRoot {
                guard let dirMatch = dataDirRegex?.firstMatch(in: lineStr, range: range),
                      let dirRange = Range(dirMatch.range(at: 1), in: lineStr) else {
                    // No --user-data-dir means Chrome is on its default root,
                    // which IS the needle for Google Chrome's default install.
                    if !lineStr.contains("--user-data-dir=") {
                        // Default root match — accept.
                    } else {
                        continue
                    }
                    if seen.insert(port).inserted { ports.append(port) }
                    continue
                }
                let dirStr = String(lineStr[dirRange])
                if URL(fileURLWithPath: dirStr).standardizedFileURL.path == needle.standardizedFileURL.path {
                    if seen.insert(port).inserted { ports.append(port) }
                }
                continue
            }
            if seen.insert(port).inserted { ports.append(port) }
        }
        return ports
    }

    static func isCdpReachable(port: Int) async -> Bool {
        guard let url = URL(string: "http://127.0.0.1:\(port)/json/version") else { return false }
        var request = URLRequest(url: url)
        request.timeoutInterval = 1.0
        do {
            let (_, response) = try await URLSession.shared.data(for: request)
            return (response as? HTTPURLResponse)?.statusCode == 200
        } catch {
            return false
        }
    }

    private static func slugify(_ value: String) -> String {
        let lowered = value.lowercased()
        let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyz0123456789-")
        let mapped = lowered.unicodeScalars.map { allowed.contains($0) ? Character($0) : "-" }
        let joined = String(mapped)
        // Collapse runs of '-' for a tidy slug.
        var result = ""
        var lastWasDash = false
        for ch in joined {
            if ch == "-" {
                if lastWasDash { continue }
                lastWasDash = true
            } else {
                lastWasDash = false
            }
            result.append(ch)
        }
        return result.trimmingCharacters(in: CharacterSet(charactersIn: "-"))
    }
}

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

    /// Detect a live Chrome CDP endpoint for the given user-data root.
    /// Reads `<root>/DevToolsActivePort` — the file Chrome writes when
    /// either the M144 chrome://inspect toggle is enabled OR Chrome was
    /// launched with `--remote-debugging-port=<N>`. Both modes serve a
    /// standard CDP WebSocket; M144 additionally disables HTTP
    /// `/json/version` discovery, which is why we don't probe that
    /// endpoint here.
    ///
    /// The Mac UI uses this for menu-bar pre-fill; the connector
    /// subprocess re-reads DevToolsActivePort itself at sync time to get
    /// the full ws:// path. Returns nil when Chrome isn't exposing CDP.
    static func autoDetectCdpUrl(matchUserDataRoot: URL? = nil) async -> String? {
        guard let root = matchUserDataRoot,
              let port = readDevToolsActivePort(at: root)
        else { return nil }
        return "http://127.0.0.1:\(port)"
    }

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

}

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

    /// Materialize a managed --user-data-dir by copying the user's source
    /// profile. Returns the absolute path to give to the server (and to
    /// Playwright's launchPersistentContext at run time).
    static func materializeManagedProfile(from source: InstalledBrowserProfile, named name: String) throws -> URL {
        let dirName = "\(source.browser.kind.rawValue)-\(slugify(name))-\(UUID().uuidString.prefix(8))"
        let target = managedRoot.appendingPathComponent(dirName, isDirectory: true)
        try FileManager.default.createDirectory(at: managedRoot, withIntermediateDirectories: true)
        // Copy the full source profile dir. For a fresh-blank profile, callers
        // can skip this and just createDirectory(target) — but most users want
        // to inherit their existing cookies.
        try FileManager.default.copyItem(at: source.sourcePath, to: target)
        return target
    }

    /// Open Chrome (or matching browser) at `url` pointed at the managed
    /// --user-data-dir so the user can complete an interactive login that
    /// writes cookies into the profile dir. Throws if the OS reports the
    /// launch failed — callers should surface to the user instead of
    /// silently leaving the profile in `pending_auth` forever.
    static func launchManaged(browser: InstalledBrowser, managedDir: URL, openingURL url: URL) async throws {
        let config = NSWorkspace.OpenConfiguration()
        config.arguments = ["--user-data-dir=\(managedDir.path)", url.absoluteString]
        config.activates = true
        let target = browser.applicationURL
        _ = try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<NSRunningApplication, Error>) in
            NSWorkspace.shared.openApplication(at: target, configuration: config) { running, error in
                if let error {
                    continuation.resume(throwing: error)
                } else if let running {
                    continuation.resume(returning: running)
                } else {
                    continuation.resume(throwing: NSError(
                        domain: "Lobu.BrowserProfileManager",
                        code: 1,
                        userInfo: [NSLocalizedDescriptionKey: "Browser failed to launch"]
                    ))
                }
            }
        }
    }

    static func removeManagedProfile(at path: URL) {
        try? FileManager.default.removeItem(at: path)
    }

    /// Probe localhost for a Chrome (or any Chromium-family browser) running
    /// with `--remote-debugging-port`. Returns the discovered URL, or nil if
    /// nothing's listening. The default Chrome port is 9222; we also try a few
    /// neighbouring ports the user might've picked.
    static func autoDetectCdpUrl() async -> String? {
        for port in [9222, 9223, 9224, 9225] {
            if await isCdpReachable(port: port) {
                return "http://127.0.0.1:\(port)"
            }
        }
        return nil
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

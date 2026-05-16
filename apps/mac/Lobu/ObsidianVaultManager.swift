import Foundation

/// One Obsidian vault as enumerated from `obsidian.json`. The id is the
/// short hex string Obsidian assigns each vault (also the filename of its
/// per-vault settings JSON in the same directory).
struct ObsidianVault: Identifiable, Equatable {
    let id: String
    let path: String

    /// Friendly label = the vault folder's last path component. Obsidian
    /// uses the same thing in its window title and switcher.
    var displayName: String { URL(fileURLWithPath: path).lastPathComponent }

    var url: URL { URL(fileURLWithPath: path) }

    /// Skip vaults whose folder no longer exists on disk (e.g. user deleted
    /// it). Obsidian leaves stale entries in obsidian.json indefinitely.
    var exists: Bool { FileManager.default.fileExists(atPath: path) }

    /// True when the vault directory is actually readable by this process.
    /// iCloud-backed vaults (`~/Library/Mobile Documents/iCloud~md~obsidian/`)
    /// are TCC-gated even for unsandboxed apps — `exists` says yes but the
    /// first directory enumeration fails. Pre-checking with a directory read
    /// lets us warn the user instead of silently no-syncing.
    var isReadable: Bool {
        (try? FileManager.default.contentsOfDirectory(atPath: path)) != nil
    }
}

/// Reads Obsidian's per-user vault registry. Obsidian persists every vault
/// the user has ever opened to `~/Library/Application Support/obsidian/obsidian.json`
/// in the shape `{"vaults":{"<id>":{"path":"...","ts":...,"open":true}}}`.
enum ObsidianVaultManager {
    /// True when Obsidian is installed on this Mac. We check the bundle path
    /// rather than the config file so we don't show the connector for users
    /// who happen to have a stale obsidian.json from an uninstalled app.
    static func isInstalled() -> Bool {
        FileManager.default.fileExists(atPath: "/Applications/Obsidian.app")
            || FileManager.default.fileExists(
                atPath: NSHomeDirectory() + "/Applications/Obsidian.app"
            )
    }

    static func vaults() -> [ObsidianVault] {
        let configURL = URL(fileURLWithPath: NSHomeDirectory())
            .appendingPathComponent("Library/Application Support/obsidian/obsidian.json")
        guard let data = try? Data(contentsOf: configURL),
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let vaults = root["vaults"] as? [String: Any]
        else { return [] }

        return vaults.compactMap { id, raw -> ObsidianVault? in
            guard let dict = raw as? [String: Any],
                  let path = dict["path"] as? String,
                  !path.isEmpty
            else { return nil }
            return ObsidianVault(id: id, path: path)
        }
        .filter(\.exists)
        // Sort by display name so the menu ordering is stable across launches
        // (the dictionary's insertion order isn't guaranteed).
        .sorted { $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending }
    }
}

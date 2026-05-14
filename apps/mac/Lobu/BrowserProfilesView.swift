import SwiftUI

/// Shared store of device-bound `browser_session` auth profiles so each
/// per-browser row reads the same data and only the first row that appears
/// pays the network cost. Cookies live on this Mac inside a Lobu-owned
/// --user-data-dir; the server only sees metadata.
@MainActor
final class BrowserProfilesHub: ObservableObject {
    @Published var profiles: [WorkerClient.BrowserAuthProfile] = []
    @Published var loadError: String?
    @Published var loading: Bool = false
    private var loaded: Bool = false

    func loadIfNeeded(state: AppState) async {
        guard !loaded else { return }
        await reload(state: state)
    }

    func reload(state: AppState) async {
        guard let client = state.workerClient() else {
            loadError = "Sign in first."
            return
        }
        loading = true
        defer { loading = false }
        do {
            let workerId = LobuWorkerIdentity.current()
            profiles = try await client.listMyBrowserAuthProfiles(workerId: workerId)
            loadError = nil
            // Only mark as loaded on a successful fetch — otherwise the next
            // popover open silently shows an empty list instead of retrying.
            loaded = true
        } catch {
            loadError = error.localizedDescription
        }
    }

    func add(_ profile: WorkerClient.BrowserAuthProfile) {
        profiles.insert(profile, at: 0)
    }

    func remove(_ profile: WorkerClient.BrowserAuthProfile) {
        profiles.removeAll { $0.id == profile.id }
    }
}

/// One row per installed browser, with each of the user's source Chrome
/// profiles rendered inline as its own selectable row (mirrors how the
/// "Local folder" integration lists configured paths inline). Each profile
/// row has a per-profile optional CDP port input + Add/Remove button.
///
/// This pattern replaces the older "Set up → inline create form" flow —
/// users see all their available Chrome profiles at once and can mirror
/// any subset without expanding any sub-form. The CDP port field is
/// auto-detected at view appear time from `ps`, so a Chrome already
/// running with `--remote-debugging-port` pre-fills the input.
struct SingleBrowserRow: View {
    @ObservedObject var state: AppState
    let browser: InstalledBrowser
    @ObservedObject var hub: BrowserProfilesHub

    @State private var sourceProfiles: [InstalledBrowserProfile] = []
    @State private var savingDir: String?
    @State private var confirmingDeleteId: Int?
    /// Detected CDP port via DevToolsActivePort + ps + lsof on view appear.
    /// Surfaced as a one-liner under the browser header so the user can see
    /// "Lobu will use my live Chrome if available" without any input. nil if
    /// Chrome isn't exposing debug (M144 toggle off + no --remote-debugging-port).
    @State private var detectedCdpPort: Int?

    private var myProfiles: [WorkerClient.BrowserAuthProfile] {
        hub.profiles.filter { $0.browser_kind == browser.kind.rawValue }
    }

    private func mirroredProfile(for source: InstalledBrowserProfile)
        -> WorkerClient.BrowserAuthProfile?
    {
        myProfiles.first {
            $0.auth_data?.source_profile_dir == source.directoryName
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 8) {
                Image(systemName: "globe")
                    .foregroundStyle(.blue)
                    .frame(width: 18)
                VStack(alignment: .leading, spacing: 1) {
                    Text(browser.kind.displayName).font(.caption)
                    Text(headerStatus())
                        .font(.caption2).foregroundStyle(.secondary)
                }
                Spacer()
            }
            .padding(.vertical, 4)
            .padding(.horizontal, 6)

            ForEach(sourceProfiles) { src in
                sourceProfileRow(src)
                    .padding(.leading, 32).padding(.trailing, 6)
            }
            if sourceProfiles.isEmpty {
                Text("No \(browser.kind.displayName) profiles found on this Mac.")
                    .font(.caption2).foregroundStyle(.secondary)
                    .padding(.leading, 32).padding(.bottom, 4)
            }
        }
        .task {
            sourceProfiles = BrowserProfileManager.sourceProfiles(for: browser)
            // Detect Chrome's live CDP listener once per view appear. The
            // result is informational — the connector subprocess re-reads
            // DevToolsActivePort at sync time, so a state change after the
            // menu bar opens still works. We surface the port only to
            // confirm "yes, your Chrome is reachable" to the user.
            if let url = await BrowserProfileManager.autoDetectCdpUrl(
                matchUserDataRoot: browser.userDataRoot
            ),
                let port = URL(string: url)?.port
            {
                detectedCdpPort = port
            }
        }
    }

    private func headerStatus() -> String {
        if let port = detectedCdpPort {
            return
                "Live CDP detected on :\(port). Lobu will use it when scraping; mirror cookies as fallback."
        }
        return
            "Cookies mirrored on this Mac. Enable remote debugging at chrome://inspect to also allow CDP attach."
    }

    @ViewBuilder
    private func sourceProfileRow(_ source: InstalledBrowserProfile) -> some View {
        let mirrored = mirroredProfile(for: source)
        let isMirrored = mirrored != nil
        HStack(alignment: .center, spacing: 6) {
            VStack(alignment: .leading, spacing: 0) {
                Text(source.displayName).font(.caption)
                if isMirrored {
                    Text(mirroredStatus(mirrored!))
                        .font(.caption2).foregroundStyle(.secondary)
                }
            }
            Spacer()
            if !isMirrored {
                Button(action: { Task { await mirror(source) } }) {
                    HStack(spacing: 2) {
                        Image(systemName: "plus").font(.caption2)
                        Text("Mirror").font(.caption)
                    }
                    .foregroundStyle(.blue)
                }
                .buttonStyle(.plain)
                .disabled(savingDir == source.directoryName)
            } else if let m = mirrored, confirmingDeleteId == m.id {
                Button("Confirm", role: .destructive) {
                    Task { await delete(m) }
                }
                .buttonStyle(.plain).font(.caption2).foregroundStyle(.red)
                Button("Cancel") { confirmingDeleteId = nil }
                    .buttonStyle(.plain).font(.caption2).foregroundStyle(.secondary)
            } else if let m = mirrored {
                Button(action: { confirmingDeleteId = m.id }) {
                    Image(systemName: "trash").font(.caption2)
                }
                .buttonStyle(.plain).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 1)
    }

    private func mirroredStatus(_ p: WorkerClient.BrowserAuthProfile) -> String {
        if let dir = p.user_data_dir, !dir.isEmpty {
            return "legacy · \(dir)"
        }
        if detectedCdpPort != nil {
            return "mirrored · CDP available"
        }
        return "mirrored"
    }

    @MainActor
    private func mirror(_ source: InstalledBrowserProfile) async {
        guard let client = state.workerClient() else {
            hub.loadError = "Sign in first."
            return
        }
        savingDir = source.directoryName
        defer { savingDir = nil }
        // No per-row port: the connector subprocess auto-detects CDP at sync
        // time via DevToolsActivePort. Mirror profiles always store mirror
        // metadata only; cdp_url stays NULL on the row.
        do {
            let workerId = LobuWorkerIdentity.current()
            let displayName = "\(browser.kind.displayName) — \(source.displayName)"
            let profile = try await client.createMyBrowserAuthProfile(
                workerId: workerId,
                displayName: displayName,
                browserKind: browser.kind.rawValue,
                userDataDir: nil,
                cdpUrl: nil,
                mirror: WorkerClient.BrowserAuthProfileMirrorConfig(
                    source_profile_dir: source.directoryName,
                    source_browser_root: browser.userDataRoot.path,
                    source_browser: browser.kind.rawValue,
                    mode: "mirror"
                )
            )
            hub.add(profile)
        } catch {
            hub.loadError = error.localizedDescription
        }
    }

    @MainActor
    private func delete(_ profile: WorkerClient.BrowserAuthProfile) async {
        guard let client = state.workerClient() else { return }
        let workerId = LobuWorkerIdentity.current()
        do {
            try await client.deleteMyBrowserAuthProfile(workerId: workerId, profileId: profile.id)
            hub.remove(profile)
            confirmingDeleteId = nil
        } catch {
            hub.loadError = error.localizedDescription
        }
    }
}

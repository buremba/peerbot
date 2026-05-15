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
    /// Detected CDP port via DevToolsActivePort on view appear. Surfaced
    /// inline in the "Connect to my Chrome" menu row; nil when Chrome
    /// isn't exposing remote debugging.
    @State private var detectedCdpPort: Int?
    /// Single browser-level opt-in to CDP attach. Chrome runs one CDP
    /// server per user-data root, so the consent is browser-wide — every
    /// profile under this Chrome inherits this setting on the next mirror.
    @State private var allowCdp: Bool = false

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
        let mirroredCount = sourceProfiles.filter { mirroredProfile(for: $0) != nil }.count

        return VStack(alignment: .leading, spacing: 2) {
            Menu {
                // CDP attach row — only when DevToolsActivePort detected a
                // live Chrome listener. One Chrome process = one CDP server,
                // so this is browser-wide, sits above the per-profile
                // section. The label embeds the detected port so the user
                // sees what they're attaching to without a separate textfield
                // (NSMenu can't host one cleanly anyway).
                if let port = detectedCdpPort {
                    Section("Live browser session") {
                        Toggle(
                            "Connect to my Chrome (port \(port))",
                            isOn: $allowCdp
                        )
                        if allowCdp {
                            Button("Disconnect Chrome", role: .destructive) {
                                allowCdp = false
                            }
                        }
                    }
                }

                Section(sourceProfiles.isEmpty ? "" : "Profiles") {
                    ForEach(sourceProfiles) { src in
                        Toggle(
                            isOn: profileBinding(for: src)
                        ) {
                            Text(src.displayName)
                        }
                        .disabled(savingDir == src.directoryName)
                    }
                    if sourceProfiles.isEmpty {
                        Text("No \(browser.kind.displayName) profiles found")
                    }
                }
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: "globe")
                        .foregroundStyle(.blue)
                        .frame(width: 18)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(browser.kind.displayName).font(.caption)
                        Text(headerStatus(
                            mirroredCount: mirroredCount,
                            totalCount: sourceProfiles.count
                        ))
                        .font(.caption2).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Image(systemName: "chevron.right")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
                .padding(.vertical, 4)
                .padding(.horizontal, 6)
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)  // we draw our own chevron to match the other Integration rows

            // Surface any save / fetch failure inline so the user sees
            // what's wrong instead of "I clicked Mirror and nothing
            // happened." Stays as long as hub.loadError is non-nil; the
            // next successful operation clears it.
            if let err = hub.loadError {
                HStack(alignment: .top, spacing: 4) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.caption2).foregroundStyle(.orange)
                    Text(err).font(.caption2).foregroundStyle(.red)
                }
                .padding(.leading, 32).padding(.trailing, 6).padding(.bottom, 4)
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

    private func headerStatus(mirroredCount: Int, totalCount: Int) -> String {
        // When the user already has profiles mirrored, the count is the
        // most useful summary — the descriptive blurbs belong on the
        // first run / discovery experience, not on the steady-state UI.
        if totalCount > 0 {
            let suffix = totalCount == 1 ? "profile" : "profiles"
            return "\(mirroredCount) of \(totalCount) \(suffix) mirrored"
        }
        if detectedCdpPort != nil {
            return
                "Your Chrome is reachable. Check 'Use my Chrome' to let Lobu run inside it for sites that need a live session."
        }
        return
            "Cookies stay on this Mac. Connectors run headless."
    }

    /// Binding wired into a profile-checkbox row. Reads the current
    /// mirror state for `source`; flipping the binding kicks off the
    /// async mirror / delete operation without dismissing the menu.
    /// Errors land in `hub.loadError` and surface as the inline banner
    /// under the row.
    private func profileBinding(for source: InstalledBrowserProfile) -> Binding<Bool> {
        Binding(
            get: { mirroredProfile(for: source) != nil },
            set: { wantsMirror in
                if wantsMirror {
                    Task { await mirror(source) }
                } else if let existing = mirroredProfile(for: source) {
                    Task { await delete(existing) }
                }
            }
        )
    }

    @MainActor
    private func mirror(_ source: InstalledBrowserProfile) async {
        guard let client = state.workerClient() else {
            hub.loadError = "Sign in first."
            return
        }
        savingDir = source.directoryName
        defer { savingDir = nil }
        // allow_cdp_attach is the single browser-level consent. When the
        // user has connected Chrome (`allowCdp`) AND DevToolsActivePort
        // surfaced a live port, pin that port for the new profile so the
        // connector subprocess attaches directly at sync time. When the
        // user is connected but the port wasn't detected at view-appear
        // time, leave cdpUrl nil — the worker re-reads DevToolsActivePort
        // on every sync, so a Chrome that starts later still attaches.
        let cdpUrl: String? = (allowCdp && detectedCdpPort != nil)
            ? "http://127.0.0.1:\(detectedCdpPort!)"
            : nil
        do {
            let workerId = LobuWorkerIdentity.current()
            let displayName = "\(browser.kind.displayName) — \(source.displayName)"
            let profile = try await client.createMyBrowserAuthProfile(
                workerId: workerId,
                displayName: displayName,
                browserKind: browser.kind.rawValue,
                cdpUrl: cdpUrl,
                mirror: WorkerClient.BrowserAuthProfileMirrorConfig(
                    source_profile_dir: source.directoryName,
                    source_browser_root: browser.userDataRoot.path,
                    source_browser: browser.kind.rawValue,
                    mode: "mirror",
                    allow_cdp_attach: allowCdp
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
        } catch {
            hub.loadError = error.localizedDescription
        }
    }
}

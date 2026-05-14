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

/// One row per installed browser, rendered inline in the Integrations
/// disclosure. Each row shows the browser, its existing profiles, and an
/// inline create form — the user picks a source profile + connector + name
/// without leaving the menu bar. Mode defaults to "Copy profile" (managed
/// --user-data-dir, cookies isolated from the user's real browsing).
struct SingleBrowserRow: View {
    @ObservedObject var state: AppState
    let browser: InstalledBrowser
    @ObservedObject var hub: BrowserProfilesHub

    @State private var showCreateForm: Bool = false
    @State private var confirmingDeleteId: Int?

    private var myProfiles: [WorkerClient.BrowserAuthProfile] {
        hub.profiles.filter { $0.browser_kind == browser.kind.rawValue }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 8) {
                Image(systemName: "globe")
                    .foregroundStyle(.blue)
                    .frame(width: 18)
                VStack(alignment: .leading, spacing: 1) {
                    Text(browser.kind.displayName).font(.caption)
                    if myProfiles.isEmpty {
                        Text("No profiles yet. Cookies stay on this Mac.")
                            .font(.caption2).foregroundStyle(.secondary)
                    } else {
                        Text("\(myProfiles.count) profile\(myProfiles.count == 1 ? "" : "s")")
                            .font(.caption2).foregroundStyle(.secondary)
                    }
                }
                Spacer()
                if !showCreateForm {
                    Button(action: { showCreateForm = true }) {
                        HStack(spacing: 2) {
                            Image(systemName: "plus").font(.caption2)
                            Text("Add").font(.caption)
                        }
                        .foregroundStyle(.blue)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.vertical, 4)
            .padding(.horizontal, 6)

            ForEach(myProfiles) { profile in
                profileRow(profile).padding(.leading, 32).padding(.trailing, 6)
            }

            if showCreateForm {
                CreateBrowserProfileInlineForm(
                    state: state,
                    browser: browser,
                    onCreated: { newProfile in
                        hub.add(newProfile)
                        showCreateForm = false
                    },
                    onCancel: { showCreateForm = false }
                )
                .padding(.leading, 32).padding(.trailing, 6).padding(.bottom, 4)
            }
        }
    }

    @ViewBuilder
    private func profileRow(_ profile: WorkerClient.BrowserAuthProfile) -> some View {
        HStack(alignment: .center, spacing: 6) {
            VStack(alignment: .leading, spacing: 0) {
                Text(profile.display_name).font(.caption)
                Text(profile.status)
                    .font(.caption2).foregroundStyle(.secondary)
            }
            Spacer()
            if profile.status == "pending_auth", let dir = profile.user_data_dir {
                Button("Open") {
                    openManagedChrome(dirPath: dir)
                }
                .buttonStyle(.plain).font(.caption2).foregroundStyle(.orange)
            }
            if confirmingDeleteId == profile.id {
                Button("Confirm", role: .destructive) {
                    Task { await delete(profile) }
                }
                .buttonStyle(.plain).font(.caption2).foregroundStyle(.red)
                Button("Cancel") { confirmingDeleteId = nil }
                    .buttonStyle(.plain).font(.caption2).foregroundStyle(.secondary)
            } else {
                Button(action: { confirmingDeleteId = profile.id }) {
                    Image(systemName: "trash").font(.caption2)
                }
                .buttonStyle(.plain).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 1)
    }

    private func openManagedChrome(dirPath: String) {
        let dir = URL(fileURLWithPath: dirPath)
        let landing = URL(string: "about:blank")!
        Task { @MainActor in
            do {
                try await BrowserProfileManager.launchManaged(
                    browser: browser, managedDir: dir, openingURL: landing
                )
            } catch {
                hub.loadError = "Could not launch \(browser.kind.displayName): \(error.localizedDescription)"
            }
        }
    }

    @MainActor
    private func delete(_ profile: WorkerClient.BrowserAuthProfile) async {
        guard let client = state.workerClient() else { return }
        let workerId = LobuWorkerIdentity.current()
        do {
            try await client.deleteMyBrowserAuthProfile(workerId: workerId, profileId: profile.id)
            if let dir = profile.user_data_dir {
                BrowserProfileManager.removeManagedProfile(at: URL(fileURLWithPath: dir))
            }
            hub.remove(profile)
            confirmingDeleteId = nil
        } catch {
            hub.loadError = error.localizedDescription
        }
    }
}

struct CreateBrowserProfileInlineForm: View {
    @ObservedObject var state: AppState
    let browser: InstalledBrowser
    var onCreated: (WorkerClient.BrowserAuthProfile) -> Void
    var onCancel: () -> Void

    enum Mode: String, CaseIterable, Hashable { case copy, cdp }

    @State private var sourceProfiles: [InstalledBrowserProfile] = []
    @State private var selectedSourceProfile: InstalledBrowserProfile?
    @State private var displayName: String = ""
    @State private var mode: Mode = .copy
    @State private var cdpPortText: String = ""
    @State private var detectedCdpUrl: String?
    @State private var saving: Bool = false
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Picker("", selection: $mode) {
                Text("Copy profile").tag(Mode.copy)
                Text("Attach via CDP").tag(Mode.cdp)
            }
            .pickerStyle(.segmented).controlSize(.mini).font(.caption2)
            HStack(spacing: 4) {
                if mode == .copy {
                    Picker("", selection: $selectedSourceProfile) {
                        ForEach(sourceProfiles) { p in
                            Text(p.displayName).tag(Optional(p))
                        }
                    }
                    .labelsHidden().font(.caption2).controlSize(.mini)
                    .disabled(sourceProfiles.isEmpty)
                } else {
                    TextField("port (e.g. 9222)", text: $cdpPortText)
                        .textFieldStyle(.roundedBorder).controlSize(.mini).font(.caption2)
                        .frame(maxWidth: 100)
                    Button("Detect") {
                        Task {
                            if let url = await BrowserProfileManager.autoDetectCdpUrl() {
                                detectedCdpUrl = url
                                if let port = URL(string: url)?.port {
                                    cdpPortText = String(port)
                                }
                            } else {
                                error = "No running Chrome with --remote-debugging-port detected. Falls back to Copy mode if you submit without a port."
                            }
                        }
                    }
                    .buttonStyle(.plain).font(.caption2).foregroundStyle(.blue)
                }
            }
            if mode == .cdp, let url = detectedCdpUrl {
                Text("Detected: \(url)").font(.caption2).foregroundStyle(.green)
            }
            TextField("Name (e.g. Work Chrome)", text: $displayName)
                .textFieldStyle(.roundedBorder).controlSize(.mini).font(.caption2)
            if let error {
                Text(error).font(.caption2).foregroundStyle(.red)
            }
            HStack(spacing: 6) {
                Button("Cancel", action: onCancel)
                    .buttonStyle(.plain).font(.caption2).foregroundStyle(.secondary)
                Spacer()
                Button(mode == .copy ? "Create (copy)" : "Create (attach)") {
                    Task { await create() }
                }
                    .buttonStyle(.plain).font(.caption2).foregroundStyle(.blue)
                    .disabled(saving || !canSubmit)
            }
        }
        .onAppear {
            sourceProfiles = BrowserProfileManager.sourceProfiles(for: browser)
            selectedSourceProfile = sourceProfiles.first
        }
    }

    private var canSubmit: Bool {
        if displayName.trimmingCharacters(in: .whitespaces).isEmpty { return false }
        switch mode {
        case .copy: return selectedSourceProfile != nil
        case .cdp: return parsedCdpPort != nil
        }
    }

    private var parsedCdpPort: Int? {
        let trimmed = cdpPortText.trimmingCharacters(in: .whitespaces)
        guard let port = Int(trimmed), port > 0, port < 65536 else { return nil }
        return port
    }

    @MainActor
    private func create() async {
        guard let client = state.workerClient() else {
            error = "Sign in first."
            return
        }
        saving = true
        error = nil
        defer { saving = false }
        do {
            let workerId = LobuWorkerIdentity.current()
            let profile: WorkerClient.BrowserAuthProfile
            switch mode {
            case .copy:
                guard let source = selectedSourceProfile else { return }
                let target = try BrowserProfileManager.materializeManagedProfile(from: source, named: displayName)
                do {
                    profile = try await client.createMyBrowserAuthProfile(
                        workerId: workerId,
                        displayName: displayName,
                        browserKind: browser.kind.rawValue,
                        userDataDir: target.path,
                        cdpUrl: nil
                    )
                } catch {
                    // Server refused: clean up the managed --user-data-dir we
                    // just materialized so the user isn't stuck with an
                    // orphan profile dir on disk after a failed save.
                    BrowserProfileManager.removeManagedProfile(at: target)
                    throw error
                }
            case .cdp:
                guard let port = parsedCdpPort else {
                    error = "Enter a CDP port (e.g. 9222), or use Copy mode."
                    return
                }
                let cdpUrl = "http://127.0.0.1:\(port)"
                profile = try await client.createMyBrowserAuthProfile(
                    workerId: workerId,
                    displayName: displayName,
                    browserKind: browser.kind.rawValue,
                    userDataDir: nil,
                    cdpUrl: cdpUrl
                )
            }
            onCreated(profile)
        } catch let createError {
            error = createError.localizedDescription
        }
    }
}

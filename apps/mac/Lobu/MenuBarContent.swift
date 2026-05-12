import AppKit
import SwiftUI

/// The popover shown when the user clicks the menu bar icon.
/// Layout (top → bottom):
///   1. Status line
///   2. Recent jobs (last 3–5)
///   3. Integrations section (Screen Time + Local folders)
///   4. Account (name, Open Lobu, Sign out)
///   5. Quit
///
/// The menu-bar glyph already identifies the app, so the popover skips a
/// redundant logo/title header and opens straight at the status line.
struct MenuBarContent: View {
    @ObservedObject var state: AppState

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            statusRow
            if !state.status.isEmpty {
                statusMessageRow
            }
            if state.credentials == nil {
                signInSection
            } else {
                if !state.recentJobs.isEmpty {
                    sectionDivider
                    recentJobsSection
                }
                sectionDivider
                integrationsSection
                sectionDivider
                accountSection
            }
            sectionDivider
            footerRow
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 8)
        .frame(width: 320)
    }

    private var sectionDivider: some View {
        Divider().padding(.vertical, 6).padding(.horizontal, 6)
    }

    // -------------------------------------------------------------------------
    // MARK: 1. Status line
    // -------------------------------------------------------------------------

    private var statusRow: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(statusColor)
                .frame(width: 7, height: 7)
            Text(state.connectionStatusLabel)
                .font(.caption)
                .foregroundStyle(.secondary)
            Spacer()
            if state.isSyncing {
                ProgressView().controlSize(.mini)
            } else if state.credentials != nil {
                Button("Sync now") { Task { await state.syncNow() } }
                    .buttonStyle(.plain)
                    .font(.caption)
                    .disabled(state.isSyncing)
            }
        }
        .menuRow()
    }

    private var statusMessageRow: some View {
        HStack(alignment: .top, spacing: 6) {
            Image(systemName: state.lastPollSuccess ? "info.circle" : "exclamationmark.triangle.fill")
                .font(.caption2)
                .foregroundStyle(state.lastPollSuccess ? Color.secondary : Color.orange)
                .frame(width: 12)
            Text(state.status)
                .font(.caption2)
                .foregroundStyle(state.lastPollSuccess ? Color.secondary : Color.primary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .menuRow(interactive: false)
    }

    private var statusColor: Color {
        guard state.credentials != nil else { return .gray }
        guard state.lastPollDate != nil else { return .yellow }
        return state.lastPollSuccess ? .green : .red
    }

    // -------------------------------------------------------------------------
    // MARK: Sign-in section (when not signed in)
    // -------------------------------------------------------------------------

    private var signInSection: some View {
        VStack(alignment: .leading, spacing: 5) {
            sectionLabel("Connect to Lobu")

            Picker("", selection: $state.serverMode) {
                Text("Lobu Cloud").tag(ServerMode.cloud)
                Text("Self-hosted").tag(ServerMode.custom)
                Text("Run on this Mac").tag(ServerMode.local)
            }
            .pickerStyle(.radioGroup)
            .labelsHidden()
            .padding(.horizontal, 6)
            .disabled(state.isLoggingIn)
            .onChange(of: state.serverMode) { _, mode in
                if mode == .custom { Task { await state.suggestLocalServerIfPresent() } }
            }

            modeDetail
                .padding(.horizontal, 6)

            Button(connectButtonTitle) { Task { await state.connect() } }
                .buttonStyle(.plain)
                .font(.caption)
                .disabled(connectDisabled)
                .menuRow()

            if let code = state.loginCode {
                HStack {
                    Text("Code").foregroundStyle(.secondary)
                    Spacer()
                    Text(code).monospaced()
                }
                .font(.caption)
                .menuRow(interactive: false)
            }
        }
        .task { await state.suggestLocalServerIfPresent() }
    }

    @ViewBuilder private var modeDetail: some View {
        switch state.serverMode {
        case .cloud:
            EmptyView()
        case .custom:
            VStack(alignment: .leading, spacing: 3) {
                TextField("http://localhost:8787", text: $state.customServerDraft)
                    .textFieldStyle(.roundedBorder)
                    .font(.caption)
                    .disabled(state.isLoggingIn)
                    .onSubmit { Task { await state.probeServer() } }
                if let reachable = state.serverReachable, !state.customServerDraft.isEmpty {
                    Label(
                        reachable ? "Reachable" : "Couldn't reach a Lobu there",
                        systemImage: reachable ? "checkmark.circle.fill" : "xmark.circle"
                    )
                    .font(.caption2)
                    .foregroundStyle(reachable ? Color.green : Color.secondary)
                }
            }
        case .local:
            VStack(alignment: .leading, spacing: 3) {
                Text("Starts `lobu run` at ~/lobu — local PGlite, no Docker or setup.")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                switch state.localLobuStatus {
                case .cliMissing:
                    Text("Install the Lobu CLI first: npm i -g @lobu/cli")
                        .font(.caption2)
                        .foregroundStyle(.orange)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                case .starting:
                    HStack(spacing: 4) {
                        ProgressView().controlSize(.mini)
                        Text("Starting…").font(.caption2).foregroundStyle(.secondary)
                    }
                case .running:
                    Label("Running", systemImage: "checkmark.circle.fill")
                        .font(.caption2)
                        .foregroundStyle(.green)
                case let .failed(message):
                    Text(message)
                        .font(.caption2)
                        .foregroundStyle(.orange)
                        .fixedSize(horizontal: false, vertical: true)
                case .stopped:
                    EmptyView()
                }
            }
        }
    }

    private var connectButtonTitle: String {
        if state.isLoggingIn { return "Waiting for approval…" }
        switch state.serverMode {
        case .cloud:  return "Sign in with Lobu"
        case .custom: return "Sign in"
        case .local:  return state.localLobuStatus.isRunning ? "Sign in" : "Start & sign in"
        }
    }

    private var connectDisabled: Bool {
        if state.isLoggingIn || state.localLobuStatus == .starting { return true }
        if state.serverMode == .custom,
           state.customServerDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return true
        }
        return false
    }

    // -------------------------------------------------------------------------
    // MARK: 2. Recent jobs
    // -------------------------------------------------------------------------

    private var recentJobsSection: some View {
        VStack(alignment: .leading, spacing: 2) {
            sectionLabel("Recent jobs")
            ForEach(Array(state.recentJobs.prefix(5).enumerated()), id: \.offset) { _, job in
                Button {
                    if let url = state.recentJobURL(job) { NSWorkspace.shared.open(url) }
                } label: {
                    HStack(spacing: 0) {
                        Text(job.displayLabel).font(.caption)
                        Text(" · \(job.itemsStreamed) items")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Spacer()
                        Text(job.timeAgoString)
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                        Image(systemName: "chevron.right")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                            .padding(.leading, 4)
                    }
                }
                .buttonStyle(.plain)
                .menuRow()
            }
        }
    }

    // -------------------------------------------------------------------------
    // MARK: 3. Integrations
    // -------------------------------------------------------------------------

    private var integrationsSection: some View {
        VStack(alignment: .leading, spacing: 2) {
            sectionLabel("Integrations")
            screenTimeRow
            localFolderRows
            healthKitRow
        }
    }

    private var healthKitRow: some View {
        HStack(spacing: 8) {
            Image(systemName: "heart.fill")
                .foregroundStyle(.pink)
                .frame(width: 18)
            VStack(alignment: .leading, spacing: 1) {
                Text("Apple Health").font(.caption)
                if !state.healthKitAvailable {
                    Text("Not available on this Mac.")
                        .font(.caption2).foregroundStyle(.secondary)
                } else if !state.hasHealthKit {
                    Text("Daily activity + workouts, synced from iPhone via iCloud Health.")
                        .font(.caption2).foregroundStyle(.secondary)
                }
            }
            Spacer()
            if !state.healthKitAvailable {
                EmptyView()
            } else if state.hasHealthKit {
                Label("Requested", systemImage: "checkmark.circle.fill")
                    .labelStyle(.iconOnly)
                    .foregroundStyle(.green)
                    .font(.caption)
            } else {
                Button("Grant access") { Task { await state.requestHealthKitAccess() } }
                    .buttonStyle(.plain).font(.caption).foregroundStyle(.orange)
            }
        }
        .menuRow()
    }

    private var screenTimeRow: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 8) {
                Image(systemName: "clock.fill")
                    .foregroundStyle(.purple)
                    .frame(width: 18)
                VStack(alignment: .leading, spacing: 1) {
                    Text("Screen Time").font(.caption)
                    if !state.hasFDA {
                        Text("Enable Full Disk Access, then recheck.")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
                Spacer()
                if state.hasFDA {
                    Label("Granted", systemImage: "checkmark.circle.fill")
                        .labelStyle(.iconOnly)
                        .foregroundStyle(.green)
                        .font(.caption)
                } else {
                    HStack(spacing: 8) {
                        Button("Settings") {
                            if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles") {
                                NSWorkspace.shared.open(url)
                            }
                        }
                        .buttonStyle(.plain)
                        .font(.caption)
                        .foregroundStyle(.orange)
                        Button("Recheck") { state.refreshFDAStatus() }
                            .buttonStyle(.plain)
                            .font(.caption)
                    }
                }
            }
        }
        .menuRow()
    }

    private var localFolderRows: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 8) {
                Image(systemName: "folder.fill")
                    .foregroundStyle(.blue)
                    .frame(width: 18)
                VStack(alignment: .leading, spacing: 1) {
                    Text("Local folder").font(.caption)
                    Text("Syncs txt, md, json, csv, and html files.")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Button("Add folder…") { openFolderPanel() }
                    .buttonStyle(.plain)
                    .font(.caption)
            }
            .menuRow()
            ForEach(Array(state.localFolderBookmarks.enumerated()), id: \.offset) { idx, _ in
                if let url = state.resolvedURLForBookmark(at: idx) {
                    HStack(spacing: 4) {
                        Image(systemName: "folder")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .frame(width: 18)
                        Text(url.path.replacingOccurrences(of: NSHomeDirectory(), with: "~"))
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                        Spacer()
                        Button {
                            state.removeFolderBookmark(at: idx)
                        } label: {
                            Image(systemName: "xmark")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                        .buttonStyle(.plain)
                    }
                    .menuRow()
                }
            }
        }
    }

    // -------------------------------------------------------------------------
    // MARK: 4. Account
    // -------------------------------------------------------------------------

    private var accountSection: some View {
        VStack(alignment: .leading, spacing: 2) {
            sectionLabel("Account")
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Signed in as \(state.displayName)").font(.caption)
                    if let orgName = state.activeOrgName {
                        Text(orgName).font(.caption2).foregroundStyle(.secondary)
                    }
                }
                Spacer()
            }
            .menuRow(interactive: false)
            if state.serverMode == .local {
                HStack(spacing: 8) {
                    Text("Local Lobu").font(.caption2).foregroundStyle(.secondary)
                    Spacer()
                    switch state.localLobuStatus {
                    case .running:
                        Text("running").font(.caption2).foregroundStyle(.secondary)
                        Button("Stop") { state.stopLocalLobu() }.buttonStyle(.plain).font(.caption2)
                    case .starting:
                        ProgressView().controlSize(.mini)
                    default:
                        Text("stopped").font(.caption2).foregroundStyle(.secondary)
                        Button("Start") { Task { await state.startLocalLobu() } }
                            .buttonStyle(.plain).font(.caption2)
                    }
                }
                .menuRow(interactive: false)
            }
            HStack(spacing: 10) {
                Button("Open Lobu \u{2197}") {
                    if let url = URL(string: state.baseURL) { NSWorkspace.shared.open(url) }
                }
                .buttonStyle(.plain)
                .font(.caption)
                Spacer()
                Button("Sign out", role: .destructive) { state.signOut() }
                    .buttonStyle(.plain)
                    .font(.caption)
                    .foregroundStyle(.red)
            }
            .menuRow()
        }
    }

    // -------------------------------------------------------------------------
    // MARK: Footer
    // -------------------------------------------------------------------------

    private var footerRow: some View {
        HStack {
            Button("Quit Lobu") {
                state.stopLocalLobu()
                NSApplication.shared.terminate(nil)
            }
                .buttonStyle(.plain)
                .font(.caption)
            Spacer()
            Text(state.baseURL.replacingOccurrences(of: "https://", with: ""))
                .font(.caption2)
                .foregroundStyle(.tertiary)
                .lineLimit(1)
                .truncationMode(.middle)
        }
        .menuRow()
    }

    // -------------------------------------------------------------------------
    // MARK: Helpers
    // -------------------------------------------------------------------------

    private func sectionLabel(_ text: String) -> some View {
        Text(text.uppercased())
            .font(.caption2)
            .foregroundStyle(.tertiary)
            .fontWeight(.semibold)
            .tracking(0.4)
            .padding(.horizontal, 6)
            .padding(.bottom, 1)
    }

    private func openFolderPanel() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.canCreateDirectories = false
        panel.prompt = "Add"
        panel.message = "Choose a folder for Lobu to read"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        state.addFolderBookmark(url: url)
    }
}

// -----------------------------------------------------------------------------
// MARK: Native-feeling row highlight
// -----------------------------------------------------------------------------

private struct MenuRowStyle: ViewModifier {
    let interactive: Bool
    @State private var hovering = false

    func body(content: Content) -> some View {
        content
            .padding(.horizontal, 6)
            .padding(.vertical, 4)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 5, style: .continuous)
                    .fill(interactive && hovering ? Color.primary.opacity(0.09) : Color.clear)
            )
            .contentShape(Rectangle())
            .onHover { if interactive { hovering = $0 } }
    }
}

private extension View {
    /// Wrap a popover row so it gets consistent padding and a native-style
    /// hover highlight. Pass `interactive: false` for purely informational rows.
    func menuRow(interactive: Bool = true) -> some View {
        modifier(MenuRowStyle(interactive: interactive))
    }
}

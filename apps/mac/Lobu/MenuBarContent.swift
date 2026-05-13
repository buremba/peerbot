import AppKit
import SwiftUI

/// The popover shown when the user clicks the menu bar icon. Layout (top → bottom):
///   1. Header — "Lobu" title with sync toggle, status line below
///   2. User row — avatar + name + email (signed in only)
///   3. Search bar — small TextField; results take over the body when active
///   4. Inbox — unread + recent notifications
///   5. Recent runs — agent runs across the org
///   6. Sign-in section — only when signed out
///   7. Integrations — collapsible disclosure (with per-row health dots)
///   8. Footer — Open Lobu / Sign out / Quit / Updates
struct MenuBarContent: View {
    @ObservedObject var state: AppState
    @State private var integrationsExpanded = false
    @State private var accountExpanded = false
    @StateObject private var browserHub = BrowserProfilesHub()
    @FocusState private var searchFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            sectionDivider

            if state.credentials == nil {
                signInSection
            } else {
                userRow
                sectionDivider
                searchBar
                if !state.searchQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    sectionDivider
                    searchResultsSection
                } else {
                    if !state.notifications.isEmpty {
                        sectionDivider
                        notificationsSection
                    }
                    if !state.recentRuns.isEmpty {
                        sectionDivider
                        recentRunsSection
                    }
                    sectionDivider
                    integrationsDisclosure
                }
            }

            sectionDivider
            footerRow
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 8)
        .frame(width: 340)
    }

    private var sectionDivider: some View {
        Divider().padding(.vertical, 6).padding(.horizontal, 6)
    }

    // -------------------------------------------------------------------------
    // MARK: 1. Header
    // -------------------------------------------------------------------------

    private var header: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text("Lobu")
                    .font(.headline)
                Text(Host.current().localizedName ?? "This Mac")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer()
                if state.credentials != nil {
                    Toggle("", isOn: Binding(
                        get: { !state.syncPaused },
                        set: { _ in state.togglePauseSync() }
                    ))
                    .labelsHidden()
                    .toggleStyle(.switch)
                    .controlSize(.small)
                }
            }
            HStack(spacing: 6) {
                Circle()
                    .fill(statusColor)
                    .frame(width: 6, height: 6)
                Text(state.connectionStatusLabel)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer()
                if state.isSyncing {
                    ProgressView().controlSize(.mini)
                } else if state.credentials != nil && !state.syncPaused {
                    Button("Sync now") { Task { await state.syncNow() } }
                        .buttonStyle(.plain)
                        .font(.caption)
                        .disabled(state.isSyncing)
                }
            }
            if !state.status.isEmpty {
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
                .padding(.top, 2)
            }
        }
        .padding(.horizontal, 6)
        .padding(.top, 2)
    }

    private var statusColor: Color {
        guard state.credentials != nil else { return .gray }
        if state.syncPaused { return .gray }
        guard state.lastPollDate != nil else { return .yellow }
        return state.lastPollSuccess ? .green : .red
    }

    // -------------------------------------------------------------------------
    // MARK: 2. User row
    // -------------------------------------------------------------------------

    private var userRow: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(.easeInOut(duration: 0.15)) { accountExpanded.toggle() }
            } label: {
                HStack(spacing: 10) {
                    avatar
                    VStack(alignment: .leading, spacing: 1) {
                        Text(state.displayName).font(.callout).fontWeight(.medium)
                        if let email = state.credentials?.userInfo?.email, email != state.displayName {
                            Text(email).font(.caption2).foregroundStyle(.secondary)
                        }
                        if let orgName = state.activeOrgName {
                            Text(orgName).font(.caption2).foregroundStyle(.secondary)
                        }
                    }
                    Spacer()
                    Image(systemName: "chevron.right")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                        .rotationEffect(.degrees(accountExpanded ? 90 : 0))
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
            .modifier(NativeRowHover())
            if accountExpanded {
                nativeMenuRow(title: "Sign out") { state.signOut() }
                    .padding(.leading, 36)
            }
        }
    }

    private var avatar: some View {
        let initials = state.displayName.split(separator: " ").prefix(2)
            .compactMap { $0.first }.map { String($0) }.joined().uppercased()
        let url = state.credentials?.userInfo?.picture.flatMap { URL(string: $0) }
        return ZStack {
            Circle().fill(Color.secondary.opacity(0.2))
            if let url {
                AsyncImage(url: url) { phase in
                    if let image = phase.image {
                        image.resizable().scaledToFill()
                    } else {
                        Text(initials.isEmpty ? "?" : initials)
                            .font(.caption2).fontWeight(.semibold)
                            .foregroundStyle(.secondary)
                    }
                }
                .clipShape(Circle())
            } else {
                Text(initials.isEmpty ? "?" : initials)
                    .font(.caption2).fontWeight(.semibold)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(width: 32, height: 32)
    }

    // -------------------------------------------------------------------------
    // MARK: Search
    // -------------------------------------------------------------------------

    private var searchBar: some View {
        HStack(spacing: 6) {
            Image(systemName: "magnifyingglass")
                .font(.caption)
                .foregroundStyle(.secondary)
            TextField("Search Lobu memory…", text: Binding(
                get: { state.searchQuery },
                set: { state.updateSearch($0) }
            ))
            .textFieldStyle(.plain)
            .font(.caption)
            .focused($searchFocused)
            if !state.searchQuery.isEmpty {
                Button { state.updateSearch("") } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                }
                .buttonStyle(.plain)
            }
            if state.isSearching {
                ProgressView().controlSize(.mini)
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .background(
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .fill(Color.secondary.opacity(0.12))
        )
        .padding(.horizontal, 6)
    }

    private var searchResultsSection: some View {
        VStack(alignment: .leading, spacing: 2) {
            sectionLabel("Results")
            if state.searchResults.isEmpty && !state.isSearching {
                Text("No matches.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .menuRow(interactive: false)
            }
            ForEach(state.searchResults) { hit in
                Button {
                    if let urlString = hit.url, let url = URL(string: urlString) {
                        NSWorkspace.shared.open(url)
                    }
                } label: {
                    VStack(alignment: .leading, spacing: 1) {
                        if let title = hit.title, !title.isEmpty {
                            Text(title).font(.caption).fontWeight(.medium).lineLimit(1)
                        }
                        if let snippet = hit.snippet, !snippet.isEmpty {
                            Text(snippet).font(.caption2).foregroundStyle(.secondary).lineLimit(2)
                        }
                        if let entity = hit.entity_name {
                            Text(entity).font(.caption2).foregroundStyle(.tertiary)
                        }
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .menuRow()
            }
        }
    }

    // -------------------------------------------------------------------------
    // MARK: Notifications
    // -------------------------------------------------------------------------

    private var notificationsSection: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                Text("INBOX")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .fontWeight(.semibold)
                    .tracking(0.4)
                if state.unreadCount > 0 {
                    Text("\(state.unreadCount)")
                        .font(.caption2)
                        .foregroundStyle(.white)
                        .padding(.horizontal, 5)
                        .padding(.vertical, 1)
                        .background(Capsule().fill(Color.red))
                }
                Spacer()
            }
            .padding(.horizontal, 6)
            .padding(.bottom, 1)
            ForEach(state.notifications.prefix(5)) { notification in
                Button { handleNotificationTap(notification) } label: {
                    HStack(alignment: .top, spacing: 8) {
                        Circle()
                            .fill(notification.is_read ? Color.clear : Color.accentColor)
                            .frame(width: 6, height: 6)
                            .padding(.top, 5)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(notification.title)
                                .font(.caption)
                                .fontWeight(notification.is_read ? .regular : .medium)
                                .lineLimit(1)
                            if let body = notification.body, !body.isEmpty {
                                Text(body)
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(2)
                            }
                        }
                        Spacer()
                        Text(relativeTime(notification.created_at))
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .menuRow()
            }
        }
    }

    private func handleNotificationTap(_ notification: LobuNotification) {
        Task { await state.markNotificationRead(notification) }
        // Prefer the notification's own URL; otherwise drop the user into the
        // org's notifications page on the web so a click *always* takes them
        // somewhere visible.
        if let urlString = notification.resource_url, let url = URL(string: urlString) {
            NSWorkspace.shared.open(url)
            return
        }
        let orgSlug = state.credentials?.userInfo?.organization_slug
        let fallback = orgSlug.map { "\(state.baseURL)/\($0)/notifications" } ?? state.baseURL
        if let url = URL(string: fallback) {
            NSWorkspace.shared.open(url)
        }
    }

    private static let iso8601: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    private static let iso8601NoFraction: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    private func relativeTime(_ iso: String) -> String {
        let date = Self.iso8601.date(from: iso) ?? Self.iso8601NoFraction.date(from: iso)
        guard let date else { return "" }
        let secs = Int(-date.timeIntervalSinceNow)
        if secs < 60 { return "\(secs)s" }
        let mins = secs / 60
        if mins < 60 { return "\(mins)m" }
        let hrs = mins / 60
        if hrs < 24 { return "\(hrs)h" }
        return "\(hrs / 24)d"
    }

    // -------------------------------------------------------------------------
    // MARK: 3. Recent agent runs (org-wide)
    // -------------------------------------------------------------------------

    private var recentRunsSection: some View {
        VStack(alignment: .leading, spacing: 2) {
            sectionLabel("Recent activity")
            ForEach(state.recentRuns.prefix(5)) { run in
                Button { openRun(run) } label: {
                    HStack(spacing: 8) {
                        Circle()
                            .fill(runStatusColor(run.status))
                            .frame(width: 6, height: 6)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(runDisplayLabel(run)).font(.caption).lineLimit(1)
                            if let err = run.error_message, !err.isEmpty {
                                Text(err)
                                    .font(.caption2)
                                    .foregroundStyle(.orange)
                                    .lineLimit(1)
                            }
                        }
                        Spacer()
                        if let ts = run.completed_at ?? run.created_at {
                            Text(relativeTime(ts))
                                .font(.caption2)
                                .foregroundStyle(.tertiary)
                        }
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .menuRow()
            }
        }
    }

    private func runDisplayLabel(_ run: LobuRun) -> String {
        if let op = run.operation_key, !op.isEmpty {
            if let conn = run.connector_key, !conn.isEmpty { return "\(conn) · \(op)" }
            return op
        }
        return run.connector_key ?? "run #\(run.id)"
    }

    private func runStatusColor(_ status: String?) -> Color {
        switch status {
        case "completed", "success": return .green
        case "failed", "error":      return .red
        case "running":              return .yellow
        case "pending":              return .gray
        default:                     return .secondary
        }
    }

    private func openRun(_ run: LobuRun) {
        guard let slug = state.credentials?.userInfo?.organization_slug, !slug.isEmpty else { return }
        var base = state.baseURL
        while base.hasSuffix("/") { base.removeLast() }
        if let url = URL(string: "\(base)/\(slug)/runs/\(run.id)") {
            NSWorkspace.shared.open(url)
        }
    }

    // -------------------------------------------------------------------------
    // MARK: 4. Sign-in
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
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .frame(maxWidth: .infinity)
                .disabled(connectDisabled)
                .padding(.horizontal, 6)
                .padding(.top, 2)

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
    // MARK: 5. Integrations (collapsible)
    // -------------------------------------------------------------------------

    private var integrationsDisclosure: some View {
        VStack(alignment: .leading, spacing: 2) {
            disclosureHeader(title: "Integrations", expanded: $integrationsExpanded)
            if integrationsExpanded {
                ForEach(BrowserProfileManager.installedBrowsers()) { browser in
                    SingleBrowserRow(state: state, browser: browser, hub: browserHub)
                }
                localFolderRows
                screenTimeRow
                healthKitRow
                whatsAppLocalRow
            }
        }
        .task { await browserHub.loadIfNeeded(state: state) }
    }

    private var healthKitRow: some View {
        let enabled = state.healthKitAvailable && state.hasHealthKit && !state.healthKitDisabled
        return VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 8) {
                Image(systemName: "heart.fill")
                    .foregroundStyle(.pink)
                    .frame(width: 18)
                VStack(alignment: .leading, spacing: 1) {
                    Text("Apple Health").font(.caption)
                    if !state.healthKitAvailable {
                        Text("Not available on this Mac.")
                            .font(.caption2).foregroundStyle(.secondary)
                    } else {
                        Text("Daily activity + workouts, synced via iCloud Health.")
                            .font(.caption2).foregroundStyle(.secondary)
                    }
                }
                Spacer()
                if !state.healthKitAvailable {
                    Text("Unavailable").font(.caption2).foregroundStyle(.secondary)
                } else if !enabled {
                    Button(action: {
                        if state.hasHealthKit { state.healthKitDisabled = false }
                        else { Task { await state.requestHealthKitAccess() } }
                    }) {
                        HStack(spacing: 2) {
                            Image(systemName: "plus").font(.caption2)
                            Text("Add").font(.caption)
                        }
                        .foregroundStyle(.blue)
                    }
                    .buttonStyle(.plain)
                }
            }
            .menuRow()
            if enabled {
                integrationSourceRow(
                    path: "iCloud Health",
                    onRemove: { state.healthKitDisabled = true }
                )
            }
        }
    }

    private var screenTimeRow: some View {
        let enabled = state.hasFDA && !state.screenTimeDisabled
        return VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 8) {
                Image(systemName: "clock.fill")
                    .foregroundStyle(.purple)
                    .frame(width: 18)
                VStack(alignment: .leading, spacing: 1) {
                    Text("Screen Time").font(.caption)
                    if !state.hasFDA {
                        Text("Per-app usage. Needs Full Disk Access.")
                            .font(.caption2).foregroundStyle(.secondary)
                    } else {
                        Text("Per-app usage, synced from your Mac.")
                            .font(.caption2).foregroundStyle(.secondary)
                    }
                }
                Spacer()
                if !enabled {
                    Button(action: { if state.hasFDA { state.screenTimeDisabled = false } else { openFDASettings() } }) {
                        HStack(spacing: 2) {
                            Image(systemName: "plus").font(.caption2)
                            Text("Add").font(.caption)
                        }
                        .foregroundStyle(.blue)
                    }
                    .buttonStyle(.plain)
                }
            }
            .menuRow()
            if enabled {
                integrationSourceRow(
                    path: "~/Library/Application Support/Knowledge/",
                    onRemove: { state.screenTimeDisabled = true }
                )
            }
        }
    }

    private var whatsAppLocalRow: some View {
        let available = WhatsAppLocalSyncService.isAvailable()
        let enabled = state.hasFDA && available && !state.whatsAppDisabled
        return VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 8) {
                Image(systemName: "message.fill")
                    .foregroundStyle(.green)
                    .frame(width: 18)
                VStack(alignment: .leading, spacing: 1) {
                    Text("WhatsApp").font(.caption)
                    if !available {
                        Text("Install WhatsApp Desktop to enable.")
                            .font(.caption2).foregroundStyle(.secondary)
                    } else if !state.hasFDA {
                        Text("Reads from WhatsApp Desktop. Needs Full Disk Access.")
                            .font(.caption2).foregroundStyle(.secondary)
                    } else {
                        Text("Reads messages directly from WhatsApp Desktop.")
                            .font(.caption2).foregroundStyle(.secondary)
                    }
                }
                Spacer()
                if !available {
                    Text("Not installed").font(.caption2).foregroundStyle(.secondary)
                } else if !enabled {
                    Button(action: { if state.hasFDA { state.whatsAppDisabled = false } else { openFDASettings() } }) {
                        HStack(spacing: 2) {
                            Image(systemName: "plus").font(.caption2)
                            Text("Add").font(.caption)
                        }
                        .foregroundStyle(.blue)
                    }
                    .buttonStyle(.plain)
                }
            }
            .menuRow()
            if enabled {
                integrationSourceRow(
                    path: "~/Library/Group Containers/group.net.whatsapp.WhatsAppMac.shared/",
                    onRemove: { state.whatsAppDisabled = true }
                )
            }
        }
    }

    private func integrationSourceRow(path: String, onRemove: @escaping () -> Void) -> some View {
        HStack(spacing: 4) {
            Image(systemName: "folder")
                .font(.caption2)
                .foregroundStyle(.secondary)
                .frame(width: 18)
            Text(path)
                .font(.caption2)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer()
            Button(action: onRemove) {
                Image(systemName: "xmark")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
        }
        .padding(.leading, 26)
        .menuRow()
    }

    private func openFDASettings() {
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles") {
            NSWorkspace.shared.open(url)
        }
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
                Button(action: { openFolderPanel() }) {
                    HStack(spacing: 2) {
                        Image(systemName: "plus").font(.caption2)
                        Text("Add").font(.caption)
                    }
                    .foregroundStyle(.blue)
                }
                .buttonStyle(.plain)
            }
            .menuRow()
            ForEach(Array(state.localFolders.enumerated()), id: \.element.folderId) { idx, folder in
                let path = state.resolvedURLForBookmark(at: idx)?
                    .path.replacingOccurrences(of: NSHomeDirectory(), with: "~")
                    ?? folder.displayName
                HStack(spacing: 4) {
                    Image(systemName: "folder")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .frame(width: 18)
                    Text(path)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    if folder.feedId == nil {
                        Text("(syncing…)")
                            .font(.caption2).foregroundStyle(.secondary)
                    }
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
                .padding(.leading, 26)
                .menuRow()
            }
        }
    }

    // -------------------------------------------------------------------------
    // MARK: 6. Footer
    // -------------------------------------------------------------------------

    /// Where new builds are published by the `mac-release` CI job.
    private static let releasesURL = URL(string: "https://github.com/lobu-ai/lobu/releases/latest")!

    private var appVersion: String {
        let v = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String
        return v.map { "v\($0)" } ?? ""
    }

    private var footerRow: some View {
        VStack(alignment: .leading, spacing: 0) {
            if state.credentials != nil {
                nativeMenuRow(
                    title: "Open Lobu",
                    accessory: .externalLink,
                    shortcut: "⌘O"
                ) {
                    if let url = URL(string: state.baseURL) { NSWorkspace.shared.open(url) }
                }
                .keyboardShortcut("o", modifiers: .command)
            }
            nativeMenuRow(title: "Quit Lobu", shortcut: "⌘Q") {
                state.stopLocalLobu()
                NSApplication.shared.terminate(nil)
            }
            .keyboardShortcut("q", modifiers: .command)
            updateStatusRow
        }
    }

    @ViewBuilder
    private var updateStatusRow: some View {
        if state.updateAvailable, let latest = state.latestVersion {
            nativeMenuRow(title: "Update to v\(latest)") {
                state.triggerUpdateCheck()
            }
        } else {
            HStack(spacing: 6) {
                Text(appVersion.isEmpty ? "—" : appVersion)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                Text("·")
                    .font(.callout)
                    .foregroundStyle(.tertiary)
                Text(state.latestVersion == nil ? "Checking…" : "Up to date")
                    .font(.callout)
                    .foregroundStyle(.tertiary)
                Spacer()
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private enum RowAccessory { case none, externalLink, chevron }

    @ViewBuilder
    private func nativeMenuRow(
        title: String,
        titleColor: Color = .primary,
        accessory: RowAccessory = .none,
        shortcut: String? = nil,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Text(title)
                    .font(.callout)
                    .foregroundStyle(titleColor)
                switch accessory {
                case .externalLink:
                    Image(systemName: "arrow.up.right")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                case .chevron:
                    Image(systemName: "chevron.right")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                case .none:
                    EmptyView()
                }
                Spacer()
                if let shortcut {
                    Text(shortcut)
                        .font(.callout)
                        .foregroundStyle(.tertiary)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
        .modifier(NativeRowHover())
    }

    // -------------------------------------------------------------------------
    // MARK: Helpers
    // -------------------------------------------------------------------------

    /// 6-pt dot reflecting the most recent server-side run status for a
    /// connector (green = success, red = failed, yellow = running, gray when
    /// unknown). Falls back to the connection's own status when no run yet.
    @ViewBuilder
    private func connectorHealthDot(forKey key: String) -> some View {
        let raw = state.lastRunStatus(forConnectorKey: key) ?? state.connectionStatus(forConnectorKey: key)
        let color: Color = {
            switch raw {
            case "completed", "success", "active": return .green
            case "failed", "error", "revoked":     return .red
            case "running", "pending":             return .yellow
            case "paused":                         return .gray
            default:                               return .clear
            }
        }()
        Circle().fill(color).frame(width: 6, height: 6)
    }

    private func sectionLabel(_ text: String) -> some View {
        Text(text.uppercased())
            .font(.caption2)
            .foregroundStyle(.tertiary)
            .fontWeight(.semibold)
            .tracking(0.4)
            .padding(.horizontal, 6)
            .padding(.bottom, 1)
    }

    private func disclosureHeader(title: String, expanded: Binding<Bool>) -> some View {
        Button {
            withAnimation(.easeInOut(duration: 0.15)) { expanded.wrappedValue.toggle() }
        } label: {
            HStack {
                Text(title.uppercased())
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .fontWeight(.semibold)
                    .tracking(0.4)
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .rotationEffect(.degrees(expanded.wrappedValue ? 90 : 0))
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
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

private struct NativeRowHover: ViewModifier {
    @State private var hovering = false
    func body(content: Content) -> some View {
        content
            .background(
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .fill(hovering ? Color.accentColor.opacity(0.85) : Color.clear)
            )
            .onHover { hovering = $0 }
    }
}

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

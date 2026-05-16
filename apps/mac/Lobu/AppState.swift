import AppKit
import Combine
import CryptoKit
import Foundation

// MARK: - Local folder ---------------------------------------------------------

/// One local folder the user has added as a sync source. The opaque
/// `folderId` is the link between this Mac and the server-side feed (it
/// lands in `feeds.config.folder_id`); the security-scoped `bookmark` stays
/// on disk. `feedId` is `nil` until reconcileFolderFeeds() has created the
/// feed on the server (typically after the next poll auto-wires the
/// connection).
///
/// `folderId` is **deterministic** — `SHA256(bookmark).prefix(6).hex` (12 hex
/// chars, same shape as the legacy `folderKey` used in `origin_id`s). Two
/// consequences: (a) migrating a pre-feed user keeps the same id their old
/// events used, so deduplication just works and there's no re-ingest storm;
/// (b) a user who removes + re-adds the same folder gets event continuity
/// instead of a duplicate history.
struct LocalFolder: Codable, Hashable, Identifiable {
    let folderId: String
    let bookmark: Data
    let displayName: String
    var feedId: Int?
    var id: String { folderId }

    static func folderId(for bookmark: Data) -> String {
        SHA256.hash(data: bookmark).prefix(6).map { String(format: "%02x", $0) }.joined()
    }
}

// MARK: - Recent job record --------------------------------------------------

struct RecentJob: Codable {
    let connectorKey: String
    let runId: Int
    let itemsStreamed: Int
    let finishedAt: Date
    var displayLabel: String {
        switch connectorKey {
        case "apple.screen_time": return "Screen Time"
        case "local.directory":   return "Local folder"
        case "apple.health":      return "Apple Health"
        case "apple.photos":      return "Apple Photos"
        case "whatsapp.local":    return "WhatsApp (this Mac)"
        default:                  return connectorKey
        }
    }
    var timeAgoString: String {
        let secs = Int(-finishedAt.timeIntervalSinceNow)
        if secs < 60 { return "\(secs) sec ago" }
        let mins = secs / 60
        if mins < 60 { return "\(mins) min ago" }
        let hrs = mins / 60
        return "\(hrs) h ago"
    }
}

private struct PersistedRecentJob: Decodable {
    let connectorKey: String
    let runId: Int?
    let itemsStreamed: Int
    let finishedAt: Date

    var current: RecentJob? {
        guard let runId else { return nil }
        return RecentJob(
            connectorKey: connectorKey,
            runId: runId,
            itemsStreamed: itemsStreamed,
            finishedAt: finishedAt
        )
    }
}

// MARK: - Connect mode --------------------------------------------------------

/// Which Lobu the bridge talks to. Chosen on the sign-in screen, persisted.
/// Where the menu bar is pointing the gateway at. **Derived from the URL** the
/// user typed (`connect()` parses it), not a picker selection — there is no
/// signed-out picker anymore. Kept as a typed mode because several runtime
/// paths (auto-restart of the local runner, stop-on-quit) only fire in `.local`.
enum ServerMode: String, CaseIterable {
    /// A `lobu run` the menu bar started on this Mac (URL is loopback).
    case local
    /// Any non-loopback URL — Lobu Cloud, self-hosted, tailscale, etc.
    case remote
}

/// State of the bridge-managed local `lobu run` (only meaningful in `.local` mode).
enum LocalLobuStatus: Equatable {
    case stopped
    case starting
    case running          // started by us, or adopted an instance already on the port
    case cliMissing
    case failed(message: String)

    var isRunning: Bool { self == .running }
}

// MARK: - AppState ------------------------------------------------------------

/// Top-level observable state for the menu bar app. One source of truth for
/// sign-in status, sync state, last result, the server/connect mode, and
/// integrations.
@MainActor
final class AppState: ObservableObject {
    @Published var credentials: OAuthCredentials?
    @Published var isLoggingIn: Bool = false
    @Published var loginCode: String?
    @Published var status: String = ""
    @Published var isSyncing: Bool = false
    @Published var lastPollDate: Date?
    @Published var lastPollSuccess: Bool = true
    @Published var recentJobs: [RecentJob] = []
    @Published var notifications: [LobuNotification] = []
    @Published var unreadCount: Int = 0
    @Published var recentRuns: [LobuRun] = []
    @Published var connections: [LobuConnection] = []
    @Published var searchQuery: String = ""
    @Published var searchResults: [LobuSearchHit] = []
    @Published var isSearching: Bool = false
    private var searchTask: Task<Void, Never>?
    @Published var latestVersion: String?
    @Published var updateAvailable: Bool = false
    @Published var syncPaused: Bool = UserDefaults.standard.bool(forKey: "lobu.syncPaused") {
        didSet { UserDefaults.standard.set(syncPaused, forKey: "lobu.syncPaused") }
    }

    // Integrations state
    @Published var hasFDA: Bool = false
    /// One per local folder the user has added. The security-scoped bookmark
    /// stays on this Mac; only the display name + opaque folder id flow up to
    /// the server (one feed per folder).
    @Published var localFolders: [LocalFolder] = []
    /// True once the user has been through the Apple Health permission sheet
    /// (mirrored from UserDefaults — HealthKit hides actual READ-grant status).
    @Published var hasHealthKit: Bool = HealthKitSyncService.hasBeenRequested
    /// True once the user has granted Photos library access. Unlike HealthKit,
    /// PhotoKit exposes the real authorization status — `hasPhotos` is just a
    /// cached read of `PhotosSyncService.isAuthorized` so the UI doesn't have
    /// to call into the framework on every render.
    @Published var hasPhotos: Bool = PhotosSyncService.isAuthorized

    /// Per-integration soft-disable flags. macOS permissions (FDA, HealthKit)
    /// are coarse — revoking FDA kills three integrations at once. These
    /// give the user a per-integration off switch without touching OS perms.
    @Published var screenTimeDisabled: Bool = UserDefaults.standard.bool(forKey: "lobu.screenTimeDisabled") {
        didSet { UserDefaults.standard.set(screenTimeDisabled, forKey: "lobu.screenTimeDisabled") }
    }
    @Published var whatsAppDisabled: Bool = UserDefaults.standard.bool(forKey: "lobu.whatsAppDisabled") {
        didSet { UserDefaults.standard.set(whatsAppDisabled, forKey: "lobu.whatsAppDisabled") }
    }
    @Published var healthKitDisabled: Bool = UserDefaults.standard.bool(forKey: "lobu.healthKitDisabled") {
        didSet { UserDefaults.standard.set(healthKitDisabled, forKey: "lobu.healthKitDisabled") }
    }
    @Published var photosDisabled: Bool = UserDefaults.standard.bool(forKey: "lobu.photosDisabled") {
        didSet { UserDefaults.standard.set(photosDisabled, forKey: "lobu.photosDisabled") }
    }

    @Published var baseURL: String = {
        UserDefaults.standard.string(forKey: "lobuBaseURL")
            ?? "https://app.lobu.ai"
    }()

    // Sign-in screen state.
    @Published var serverMode: ServerMode = {
        // Migrate the old "cloud" / "custom" values to the merged "remote" mode
        // so existing installs don't get bounced back to a default they didn't
        // choose. `.local` stays as-is.
        switch UserDefaults.standard.string(forKey: "lobuServerMode") {
        case "local": return .local
        case "cloud", "custom", "remote": return .remote
        default: return .local
        }
    }() { didSet { UserDefaults.standard.set(serverMode.rawValue, forKey: "lobuServerMode") } }
    /// URL the user is pointing the menu bar at (text field next to Connect).
    /// Persisted so it survives restarts. Default cascade:
    ///   1. `lobuCustomServerURL` if non-empty (the canonical field today).
    ///   2. `lobuBaseURL` if non-empty (legacy field used before the merge —
    ///      ex-custom users persisted the URL here).
    ///   3. The Lobu Cloud URL if the old `lobuServerMode` was `"cloud"` /
    ///      `"custom"` / `"remote"`, so ex-cloud users aren't silently
    ///      pointed at localhost on first launch after the merge.
    ///   4. Otherwise `http://localhost:8787` (fresh install / ex-local).
    @Published var customServerDraft: String = {
        if let stored = UserDefaults.standard.string(forKey: "lobuCustomServerURL"),
           !stored.isEmpty {
            return stored
        }
        if let legacy = UserDefaults.standard.string(forKey: "lobuBaseURL"),
           !legacy.isEmpty {
            return legacy
        }
        switch UserDefaults.standard.string(forKey: "lobuServerMode") {
        case "cloud", "custom", "remote": return "https://app.lobu.ai"
        default:                          return "http://localhost:8787"
        }
    }() {
        didSet { UserDefaults.standard.set(customServerDraft, forKey: "lobuCustomServerURL") }
    }
    /// Result of the last reachability probe of `customServerDraft` — nil = not checked yet.
    @Published var serverReachable: Bool?
    @Published var localLobuStatus: LocalLobuStatus = .stopped

    private let cloudURL = "https://app.lobu.ai"
    private let localRunner = LocalLobuRunner()
    private let credentialStore = KeychainCredentialStore()

    /// Background poll timer.
    private var pollTimer: Timer?
    private static let autoPollInterval: TimeInterval = 600  // 10 min
    private static let recentJobsKey = "lobu.recentJobs"
    private static let folderBookmarksKey = "lobu.localFolderBookmarks"

    init() {
        credentials = credentialStore.load()
        loadPersistedState()
        refreshFDAStatus()
        if serverMode == .local && credentials != nil {
            // Bring the bridge-managed Lobu back up before polling — `start()`
            // reconnects if it's still running from a previous session.
            Task { @MainActor in
                await startLocalLobu()
                startAutoPollIfSignedIn()
            }
        } else {
            startAutoPollIfSignedIn()
        }
        // Mirror Sparkle's observable state so MenuBarContent only depends on
        // AppState. The updater itself owns scheduling + the actual update flow.
        updater.$updateAvailable
            .receive(on: DispatchQueue.main)
            .assign(to: \.updateAvailable, on: self)
            .store(in: &updaterCancellables)
        updater.$latestVersion
            .receive(on: DispatchQueue.main)
            .assign(to: \.latestVersion, on: self)
            .store(in: &updaterCancellables)
    }

    private let updater = LobuUpdater.shared
    private var updaterCancellables = Set<AnyCancellable>()

    /// Triggered by the "Update to vX.Y.Z" menu row — hands off to Sparkle's
    /// standard user driver (download, EdDSA-verify, relaunch).
    func triggerUpdateCheck() { updater.checkForUpdates() }

    var displayName: String {
        credentials?.displayName ?? "Not signed in"
    }

    var activeOrgName: String? {
        guard let info = credentials?.userInfo else { return nil }
        guard let chosenSlug = info.organization_slug, !chosenSlug.isEmpty else {
            return nil
        }
        if let match = info.organizations.first(where: { $0.slug == chosenSlug }) {
            return match.name
        }
        return chosenSlug
    }

    /// The org slug runs land in (the user's personal org — that's where the
    /// auto-wired connectors live). Used to build "open this run" links.
    private var personalOrgSlug: String? {
        guard let info = credentials?.userInfo else { return nil }
        if let slug = info.organization_slug, !slug.isEmpty { return slug }
        return info.organizations.first?.slug
    }

    /// Web URL for a recent job's connector, with the run id so the page can
    /// focus it. nil when we don't know the org slug yet.
    func recentJobURL(_ job: RecentJob) -> URL? {
        guard let slug = personalOrgSlug, !slug.isEmpty else { return nil }
        var base = baseURL
        while base.hasSuffix("/") { base.removeLast() }
        return URL(string: "\(base)/\(slug)/connectors/\(job.connectorKey)?run=\(job.runId)")
    }

    func setBaseURL(_ value: String) {
        baseURL = value
        UserDefaults.standard.set(value, forKey: "lobuBaseURL")
    }

    // MARK: - Status line -------------------------------------------------------

    var connectionStatusLabel: String {
        guard credentials != nil else { return "Sign in to connect" }
        if syncPaused { return "Paused" }
        guard let lastPoll = lastPollDate else { return "Connecting…" }
        if !lastPollSuccess { return "Sync failed — see details" }
        let secs = Int(-lastPoll.timeIntervalSinceNow)
        if secs < 60 { return "Connected · last poll \(secs)s ago" }
        let mins = secs / 60
        return "Idle · last poll \(mins)m ago"
    }

    // MARK: - Capabilities -------------------------------------------------------

    /// Capabilities advertised on the next poll.
    /// Whether Apple Health querying is even possible on this Mac.
    var healthKitAvailable: Bool { HealthKitSyncService.isAvailable() }

    var currentCapabilities: [String: Bool] {
        var caps: [String: Bool] = [:]
        if hasFDA && !screenTimeDisabled { caps["screentime"] = true }
        if !localFolders.isEmpty { caps["local_directory"] = true }
        if hasHealthKit && healthKitAvailable && !healthKitDisabled { caps["healthkit"] = true }
        if hasPhotos && !photosDisabled { caps["photos"] = true }
        // Reading another app's Group Container requires Full Disk Access — the
        // same TCC grant Screen Time already needs. Gate the capability so the
        // worker doesn't claim runs it will only fail with a permission error.
        if hasFDA && WhatsAppLocalSyncService.isAvailable() && !whatsAppDisabled { caps["whatsapp_local"] = true }
        // Advertise `browser` whenever at least one supported browser is
        // installed locally — Mac becomes eligible to host browser_session
        // auth profiles with cookies on disk (no fleet credentials).
        if BrowserProfileManager.hasAnyInstalledBrowser() { caps["browser"] = true }
        return caps
    }

    // MARK: - Sign in / out -----------------------------------------------------

    func signIn() async {
        isLoggingIn = true
        loginCode = nil
        defer { isLoggingIn = false }
        do {
            let oauth = try OAuthClient(baseURL: baseURL)
            setStatus("Discovering Lobu OAuth…")
            let discovery = try await oauth.discover()
            let client = try await oauth.registerClient(discovery)
            let authorization = try await oauth.startDeviceAuthorization(discovery, client: client)
            loginCode = authorization.user_code
            setStatus("Approve the login in your browser. Code: \(authorization.user_code)")
            oauth.openVerificationURL(authorization)

            // Absolute deadline captured once — `expires_in` is relative to the
            // device-auth response, so re-deriving it each loop iteration would
            // never expire.
            let deadline = Date().addingTimeInterval(TimeInterval(authorization.expires_in))
            var interval = max(authorization.interval ?? 5, 1)
            while Date() < deadline {
                switch try await oauth.pollDeviceToken(discovery, client: client, deviceCode: authorization.device_code) {
                case let .pending(slowDown):
                    if slowDown { interval += 5 }
                    try await Task.sleep(for: .seconds(interval))
                case let .complete(tokens):
                    let userInfo = try await oauth.fetchUserInfo(discovery.userinfo_endpoint, accessToken: tokens.access_token)
                    let saved = OAuthCredentials(
                        baseURL: baseURL.trimmedTrailingSlash(),
                        clientID: client.client_id,
                        clientSecret: client.client_secret,
                        accessToken: tokens.access_token,
                        refreshToken: tokens.refresh_token,
                        expiresAt: tokens.expires_in.map { Date().addingTimeInterval(TimeInterval($0)) },
                        userInfo: userInfo
                    )
                    try credentialStore.save(saved)
                    credentials = saved
                    loginCode = nil
                    setStatus("")
                    startAutoPollIfSignedIn()
                    return
                }
            }
            setStatus("Login request expired before approval.")
        } catch {
            setStatus(error.localizedDescription)
        }
    }

    func signOut() {
        stopAutoPoll()
        credentialStore.clear()
        credentials = nil
        loginCode = nil
        lastPollDate = nil
        lastPollSuccess = true
        if serverMode == .local { stopLocalLobu() }
        setStatus("")
    }

    // MARK: - Connect (URL-driven sign-in) --------------------------------------

    /// The connection card's primary action. Auto-starts the embedded server
    /// when the URL is the exact one our runner manages; otherwise just OAuths
    /// against the typed URL.
    func connect() async {
        let raw = customServerDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        let urlString = raw.isEmpty ? cloudURL : raw
        guard let url = URL(string: urlString),
              let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https",
              let host = url.host, !host.isEmpty
        else {
            setStatus("Enter an http(s) URL with a host (e.g. http://localhost:8787).")
            return
        }
        let autoStart = AppState.matchesManagedRunner(url)
        if autoStart && !localLobuStatus.isRunning {
            await startLocalLobu()
            guard localLobuStatus.isRunning else { return }
        }
        // serverMode = .local ONLY when this URL is the runner we manage. Other
        // loopback URLs (someone else's localhost dev server, custom ports) get
        // .remote so we don't auto-spawn our runner on next launch.
        serverMode = autoStart ? .local : .remote
        setBaseURL(urlString)
        await signIn()
    }

    /// True iff this URL targets the embedded server the menu bar manages.
    /// Requires an exact scheme + host + effective-port match against
    /// `LocalLobuRunner.baseURL`. Treats `localhost`, `127.0.0.1`, `::1`, and
    /// `[::1]` as equivalent loopback hosts. Case-insensitive on the host.
    static func matchesManagedRunner(_ url: URL) -> Bool {
        guard let runnerURL = URL(string: LocalLobuRunner.baseURL),
              let runnerScheme = runnerURL.scheme?.lowercased(),
              let urlScheme = url.scheme?.lowercased(),
              runnerScheme == urlScheme
        else { return false }
        let urlPort = url.port ?? defaultPort(for: urlScheme)
        let runnerPort = runnerURL.port ?? defaultPort(for: runnerScheme)
        guard urlPort == runnerPort else { return false }
        return normalizedLoopback(url.host) != nil
            && normalizedLoopback(url.host) == normalizedLoopback(runnerURL.host)
    }

    /// Map every loopback alias to one canonical form so `127.0.0.1:8787` and
    /// `localhost:8787` and `[::1]:8787` all compare equal. Returns nil for
    /// non-loopback hosts.
    private static func normalizedLoopback(_ host: String?) -> String? {
        let lowered = host?.lowercased()
        switch lowered {
        case "localhost", "127.0.0.1", "::1", "[::1]": return "localhost"
        default: return nil
        }
    }

    private static func defaultPort(for scheme: String) -> Int? {
        switch scheme {
        case "http":  return 80
        case "https": return 443
        default:      return nil
        }
    }

    /// Start (or reconnect to) the bridge-managed `lobu run`. Idempotent: if it's
    /// already up on the port, just adopts it. Updates `baseURL` + status.
    func startLocalLobu() async {
        guard localLobuStatus != .starting else { return }
        localLobuStatus = .starting
        setStatus("Starting Lobu on this Mac…")
        do {
            let url = try await localRunner.start()
            setBaseURL(url)
            localLobuStatus = .running
            setStatus("Lobu is running on this Mac (~/lobu).")
        } catch LocalLobuRunner.RunnerError.cliNotFound {
            localLobuStatus = .cliMissing
            setStatus(LocalLobuRunner.RunnerError.cliNotFound.errorDescription ?? "Lobu CLI not installed.")
        } catch {
            localLobuStatus = .failed(message: error.localizedDescription)
            setStatus(error.localizedDescription)
        }
    }

    func stopLocalLobu() {
        localRunner.stop()
        localLobuStatus = .stopped
    }

    /// Probe whatever's currently in `customServerDraft` and update
    /// `serverReachable` for the "✓ Reachable" hint. No-op if it's blank.
    func probeServer() async {
        let url = customServerDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !url.isEmpty else { serverReachable = nil; return }
        serverReachable = await LocalLobuRunner.isLobuReachable(url)
    }


    // MARK: - Auto-poll ---------------------------------------------------------

    func togglePauseSync() {
        syncPaused.toggle()
        if syncPaused {
            stopAutoPoll()
        } else {
            startAutoPollIfSignedIn()
        }
    }

    private func startAutoPollIfSignedIn() {
        guard credentials != nil, !syncPaused, pollTimer == nil else { return }
        pollTimer = Timer.scheduledTimer(withTimeInterval: Self.autoPollInterval, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self, !self.isSyncing else { return }
                await self.syncNow()
            }
        }
        Task { @MainActor [weak self] in
            guard let self else { return }
            try? await Task.sleep(for: .seconds(2))
            if !self.isSyncing { await self.syncNow() }
        }
    }

    private func stopAutoPoll() {
        pollTimer?.invalidate()
        pollTimer = nil
    }

    // MARK: - Sync now ----------------------------------------------------------

    /// Upper bound on jobs drained in one pass — a safety stop in case the
    /// server keeps handing back claimable runs (it shouldn't for a device).
    private static let maxJobsPerPass = 25

    func syncNow() async {
        guard !isSyncing, !syncPaused else { return }
        isSyncing = true
        defer { isSyncing = false }
        refreshFDAStatus()
        do {
            // Make sure each local folder has a matching server-side feed
            // before we start claiming runs. Always runs (even with no
            // local folders) so orphaned server feeds get cleaned up when
            // the user removed their last folder before its feed id was
            // learned, and so a best-effort delete that failed on remove
            // gets retried.
            await reconcileFolderFeeds()

            var handled = 0
            var lastJob: RecentJob?
            // Drain the queue: keep claiming until the server has nothing left,
            // so a backlog (e.g. the first sync after granting two capabilities)
            // clears in one pass instead of one job per 10-minute timer tick.
            while handled < Self.maxJobsPerPass {
                let result = try await SyncDispatcher.runOneCycle(
                    baseURL: baseURL,
                    capabilities: currentCapabilities
                )
                guard result.claimedJob, let key = result.connectorKey, let runId = result.runId else {
                    break
                }
                let job = RecentJob(
                    connectorKey: key,
                    runId: runId,
                    itemsStreamed: result.itemsStreamed,
                    finishedAt: Date()
                )
                appendRecentJob(job)
                lastJob = job
                handled += 1
            }
            lastPollDate = Date()
            lastPollSuccess = true
            if let lastJob {
                setStatus(
                    handled == 1
                        ? "Synced \(lastJob.itemsStreamed) items from \(lastJob.displayLabel)."
                        : "Synced \(handled) jobs (last: \(lastJob.displayLabel))."
                )
            } else {
                setStatus("")
            }
            await refreshNotifications()
        } catch {
            lastPollDate = Date()
            lastPollSuccess = false
            setStatus(error.localizedDescription)
        }
    }

    // MARK: - Notifications -----------------------------------------------------

    /// Authenticated WorkerClient for the signed-in user, or nil if not yet
    /// signed in. Caller should treat nil as "show a sign-in hint".
    func workerClient() -> WorkerClient? {
        guard let credentials else { return nil }
        return WorkerClient(baseURL: credentials.baseURL, accessToken: credentials.accessToken)
    }

    /// Pulls the user's recent notifications, recent agent runs, and the
    /// connector health list from the org-scoped REST API. Silently no-ops when
    /// we don't yet know the org slug (e.g. the token wasn't issued with
    /// `mcp:read` so /userinfo has no organization).
    func refreshNotifications() async {
        guard let credentials, let info = credentials.userInfo,
              let slug = info.organization_slug, !slug.isEmpty else { return }
        let client = WorkerClient(baseURL: credentials.baseURL, accessToken: credentials.accessToken)
        do {
            async let listTask = client.listNotifications(orgSlug: slug, limit: 10)
            async let countTask = client.getUnreadCount(orgSlug: slug)
            async let runsTask = client.listRuns(orgSlug: slug, limit: 8)
            async let connectionsTask = client.listConnections(orgSlug: slug)
            let (list, count, runs, conns) = try await (listTask, countTask, runsTask, connectionsTask)
            notifications = list.notifications
            unreadCount = count
            recentRuns = runs.runs
            connections = conns.connections
        } catch {
            NSLog("[Lobu] feed fetch failed: \(error.localizedDescription)")
        }
    }

    /// Debounced search. Cancels any in-flight task and schedules a new one
    /// after 300ms. Clears results when the query is empty.
    func updateSearch(_ query: String) {
        searchQuery = query
        searchTask?.cancel()
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            searchResults = []
            isSearching = false
            return
        }
        guard let credentials, let info = credentials.userInfo,
              let slug = info.organization_slug, !slug.isEmpty else { return }
        let client = WorkerClient(baseURL: credentials.baseURL, accessToken: credentials.accessToken)
        searchTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(300))
            if Task.isCancelled { return }
            self?.isSearching = true
            do {
                let response = try await client.searchKnowledge(orgSlug: slug, query: trimmed, limit: 5)
                if Task.isCancelled { return }
                self?.searchResults = response.items
            } catch {
                NSLog("[Lobu] search failed: \(error.localizedDescription)")
                if !Task.isCancelled { self?.searchResults = [] }
            }
            self?.isSearching = false
        }
    }

    /// Returns the most recent server-side run for a given connector_key, used
    /// for the green/red health dot on integration rows.
    func lastRunStatus(forConnectorKey key: String) -> String? {
        recentRuns.first(where: { $0.connector_key == key })?.status
    }

    /// Returns the most recent server-side connection status for a connector,
    /// used as the fallback when no runs have happened yet.
    func connectionStatus(forConnectorKey key: String) -> String? {
        connections.first(where: { $0.connector_key == key })?.status
    }

    func markNotificationRead(_ notification: LobuNotification) async {
        guard let credentials, let info = credentials.userInfo,
              let slug = info.organization_slug, !slug.isEmpty else { return }
        let client = WorkerClient(baseURL: credentials.baseURL, accessToken: credentials.accessToken)
        // Optimistic update so the badge clears immediately.
        if let idx = notifications.firstIndex(where: { $0.id == notification.id }), !notifications[idx].is_read {
            unreadCount = max(0, unreadCount - 1)
        }
        do { try await client.markNotificationRead(orgSlug: slug, id: notification.id) } catch {
            NSLog("[Lobu] markRead failed: \(error.localizedDescription)")
            await refreshNotifications()
        }
    }

    // MARK: - Recent jobs -------------------------------------------------------

    private func appendRecentJob(_ job: RecentJob) {
        recentJobs.insert(job, at: 0)
        if recentJobs.count > 10 { recentJobs = Array(recentJobs.prefix(10)) }
        persistRecentJobs()
    }

    private func persistRecentJobs() {
        if let data = try? JSONEncoder().encode(recentJobs) {
            UserDefaults.standard.set(data, forKey: Self.recentJobsKey)
        }
    }

    // MARK: - Local folders -----------------------------------------------------
    //
    // Each folder is a server-side feed of the `local.directory` connector,
    // identified by an opaque `folderId` we mint on this Mac. The security-
    // scoped bookmark + Lobu-minted UUID live here in UserDefaults; the
    // server only sees `{folder_id, display_name}` as the feed config. Feed
    // creation happens via /api/workers/me/feeds — see reconcileFolderFeeds()
    // below, which runs after each poll once the connection is auto-wired.

    func addFolderBookmark(url: URL) {
        do {
            let bookmark = try url.bookmarkData(
                options: .withSecurityScope,
                includingResourceValuesForKeys: nil,
                relativeTo: nil
            )
            let folderId = LocalFolder.folderId(for: bookmark)
            // Re-adding a folder we already track? Just no-op — the feed (and
            // its event history) already exist server-side; keep continuity.
            if localFolders.contains(where: { $0.folderId == folderId }) {
                setStatus("Folder is already added.")
                return
            }
            let folder = LocalFolder(
                folderId: folderId,
                bookmark: bookmark,
                displayName: url.lastPathComponent,
                feedId: nil
            )
            localFolders.append(folder)
            persistFolders()
            setStatus("Folder added. Lobu will sync supported text files from it.")
            // Reconcile on the next poll cycle; the connection may not be
            // auto-wired yet on first add. We don't try to call the server
            // synchronously here.
        } catch {
            setStatus("Could not bookmark folder: \(error.localizedDescription)")
        }
    }

    func removeFolderBookmark(at index: Int) {
        guard localFolders.indices.contains(index) else { return }
        let removed = localFolders.remove(at: index)
        persistFolders()
        setStatus("Folder removed.")
        // Delete the server-side feed if we knew about it. Best-effort —
        // failure here just leaves an orphan feed the next reconcile will
        // catch (it won't have a matching local folder).
        if let feedId = removed.feedId {
            Task { await deleteFolderFeed(feedId: feedId) }
        }
    }

    private func persistFolders() {
        if let data = try? JSONEncoder().encode(localFolders) {
            UserDefaults.standard.set(data, forKey: Self.folderBookmarksKey)
        }
    }

    /// Resolve a folder's bookmark to a display URL (best-effort; not security-scoped access).
    func resolvedURLForBookmark(at index: Int) -> URL? {
        guard localFolders.indices.contains(index) else { return nil }
        var isStale = false
        return try? URL(
            resolvingBookmarkData: localFolders[index].bookmark,
            options: .withSecurityScope, relativeTo: nil,
            bookmarkDataIsStale: &isStale
        )
    }

    /// After every successful poll, reconcile our local folder list with the
    /// server's feed list. Local-only folders → create a feed. Server-only
    /// feeds (folder removed on this Mac while offline, say) → delete on
    /// server. Best-effort; never throws into the poll loop.
    func reconcileFolderFeeds() async {
        guard let client = workerClient() else { return }
        let workerId = LobuWorkerIdentity.current()
        do {
            let serverFeeds = try await client.listMyDeviceFeeds(
                workerId: workerId, connectorKey: "local.directory"
            )
            // Pre-feed-refactor orphans: auto-wire used to create a default
            // `files` feed with NULL config the first time the device
            // advertised `local_directory`. Those have no folder_id and would
            // generate failing runs forever — clean them up unconditionally.
            for feed in serverFeeds.feeds where feed.feed_key == "files" && feed.config?["folder_id"]?.stringValue == nil {
                _ = try? await client.deleteMyDeviceFeed(
                    workerId: workerId,
                    connectorKey: "local.directory",
                    feedId: feed.id
                )
            }
            let serverByFolderId = Dictionary(uniqueKeysWithValues: serverFeeds.feeds.compactMap {
                feed -> (String, WorkerClient.DeviceFeed)? in
                guard let fid = feed.config?["folder_id"]?.stringValue else { return nil }
                return (fid, feed)
            })
            // Local → server: create missing feeds, repair feedId mappings.
            var changed = false
            for i in localFolders.indices {
                let folder = localFolders[i]
                if let serverFeed = serverByFolderId[folder.folderId] {
                    if folder.feedId != serverFeed.id {
                        localFolders[i].feedId = serverFeed.id
                        changed = true
                    }
                } else {
                    if let created = try? await client.createMyDeviceFeed(
                        workerId: workerId,
                        connectorKey: "local.directory",
                        feedKey: "files",
                        displayName: folder.displayName,
                        config: [
                            "folder_id": AnyEncodable(folder.folderId),
                            "display_name": AnyEncodable(folder.displayName),
                        ]
                    ) {
                        localFolders[i].feedId = created.id
                        changed = true
                    }
                }
            }
            // Server → local: drop feeds whose folder_id we no longer hold.
            let localIds = Set(localFolders.map(\.folderId))
            for (fid, feed) in serverByFolderId where !localIds.contains(fid) {
                _ = try? await client.deleteMyDeviceFeed(
                    workerId: workerId,
                    connectorKey: "local.directory",
                    feedId: feed.id
                )
            }
            if changed { persistFolders() }
        } catch {
            NSLog("[Lobu] reconcileFolderFeeds failed: \(error.localizedDescription)")
        }
    }

    private func deleteFolderFeed(feedId: Int) async {
        guard let client = workerClient() else { return }
        let workerId = LobuWorkerIdentity.current()
        _ = try? await client.deleteMyDeviceFeed(
            workerId: workerId, connectorKey: "local.directory", feedId: feedId
        )
    }

    // MARK: - Apple Health ------------------------------------------------------

    /// Open the system permission sheet for Apple Health. After it closes (we
    /// can't tell whether the user actually granted anything — Apple hides
    /// READ-grant status), we treat the app as "requested" and start
    /// advertising the `healthkit` capability; a deny just means the next sync
    /// gets empty results.
    func requestHealthKitAccess() async {
        do {
            try await HealthKitSyncService.requestAuthorization()
            hasHealthKit = true
            setStatus("Apple Health access requested.")
        } catch {
            setStatus("Apple Health: \(error.localizedDescription)")
        }
    }

    // MARK: - Apple Photos ------------------------------------------------------

    /// Open the system Photos permission sheet. PhotoKit returns the real
    /// authorization status post-prompt (unlike HealthKit), so `hasPhotos` is
    /// trusted not just speculative. When TCC has a cached `.denied` decision
    /// the framework refuses to re-prompt — `.blocked` means we deep-link the
    /// user straight to System Settings → Privacy & Security → Photos instead
    /// of just showing them a tooltip telling them to find it themselves.
    func requestPhotosAccess() async {
        // The Photos prompt is a system-modal sheet. For an LSUIElement app
        // it appears with no owning window if we don't first promote to a
        // regular activation policy — clicks did nothing because the sheet
        // rendered behind the menu-bar popover host and got dismissed when
        // the popover closed. Promote → request → drop back to accessory.
        let priorPolicy = NSApp.activationPolicy()
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
        let outcome = await PhotosSyncService.requestAuthorization()
        NSApp.setActivationPolicy(priorPolicy)
        hasPhotos = PhotosSyncService.isAuthorized
        switch outcome {
        case .granted:
            setStatus("Apple Photos access granted.")
        case .prompted:
            setStatus("Apple Photos access declined. Click Add again to retry.")
        case .blocked:
            setStatus("Opening System Settings → Privacy → Photos…")
            openPhotosPrivacyPane()
        }
    }

    /// Deep-link to the macOS Privacy & Security → Photos pane. macOS 13+
    /// uses the `x-apple.systempreferences:` scheme; earlier we'd build a
    /// `Privacy_PhotosLibrary` anchor URL but only the newer scheme survives
    /// on Ventura+ where this app actually runs.
    private func openPhotosPrivacyPane() {
        let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Photos")!
        NSWorkspace.shared.open(url)
    }

    // MARK: - Full Disk Access -------------------------------------------------

    func refreshFDAStatus() {
        let path = "\(NSHomeDirectory())/Library/Application Support/Knowledge/knowledgeC.db"
        // Actually *open* the file rather than stat it. A real open() is what
        // makes macOS register this app in System Settings → Privacy & Security
        // → Full Disk Access (so the user just flips a toggle, no "+" digging).
        // `fileExists` / `isReadableFile` don't count as "access" and never
        // surface the app in that list.
        if let handle = FileHandle(forReadingAtPath: path) {
            try? handle.close()
            hasFDA = true
        } else {
            hasFDA = false
        }
    }

    // MARK: - Persistence helpers ----------------------------------------------

    private func loadPersistedState() {
        if let data = UserDefaults.standard.data(forKey: Self.recentJobsKey) {
            if let jobs = try? JSONDecoder().decode([RecentJob].self, from: data) {
                recentJobs = jobs
            } else if let legacyJobs = try? JSONDecoder().decode([PersistedRecentJob].self, from: data) {
                recentJobs = legacyJobs.compactMap(\.current)
                persistRecentJobs()
            }
        }
        // New format: [LocalFolder] persisted as JSON.
        if let json = UserDefaults.standard.data(forKey: Self.folderBookmarksKey),
           let folders = try? JSONDecoder().decode([LocalFolder].self, from: json) {
            localFolders = folders
        } else if let legacy = UserDefaults.standard.array(forKey: Self.folderBookmarksKey) as? [Data] {
            // Pre-feed format: bare [Data] bookmarks. Migrate by minting a
            // folder id per bookmark and resolving the display name from the
            // current URL. Feeds are created lazily by reconcileFolderFeeds()
            // once the connection is auto-wired.
            var migrated: [LocalFolder] = []
            for bookmark in legacy {
                var isStale = false
                let resolved = try? URL(
                    resolvingBookmarkData: bookmark,
                    options: .withSecurityScope, relativeTo: nil,
                    bookmarkDataIsStale: &isStale
                )
                let name = resolved?.lastPathComponent ?? "Folder"
                migrated.append(LocalFolder(
                    folderId: LocalFolder.folderId(for: bookmark),
                    bookmark: bookmark,
                    displayName: name,
                    feedId: nil
                ))
            }
            localFolders = migrated
            persistFolders()
        }
    }

    // MARK: -

    func setStatus(_ message: String) {
        status = message
        NSLog("[Lobu] \(message)")
    }
}

// MARK: - SyncDispatcher -------------------------------------------------------

/// Dispatches a single poll cycle, routing the claimed job to the appropriate
/// sync service based on connector_key.
@MainActor
enum SyncDispatcher {
    struct CycleResult {
        let claimedJob: Bool
        let itemsStreamed: Int
        let connectorKey: String?
        let runId: Int?
    }

    static func runOneCycle(baseURL: String, capabilities: [String: Bool]) async throws -> CycleResult {
        let credentialStore = KeychainCredentialStore()
        guard var credentials = credentialStore.load() else {
            throw NSError(domain: "Lobu", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "Sign in to Lobu first."])
        }
        let oauth = try OAuthClient(baseURL: credentials.baseURL)
        if let expiresAt = credentials.expiresAt, expiresAt < Date().addingTimeInterval(60) {
            credentials = try await oauth.refresh(credentials, discovery: try await oauth.discover())
            try credentialStore.save(credentials)
        }

        let worker = WorkerClient(baseURL: credentials.baseURL, accessToken: credentials.accessToken)
        let workerId = LobuWorkerIdentity.current()

        let (job, _) = try await worker.poll(workerId: workerId, capabilities: capabilities)
        guard let job else {
            return CycleResult(claimedJob: false, itemsStreamed: 0, connectorKey: nil, runId: nil)
        }

        let heartbeatBaseURL = credentials.baseURL
        let heartbeatAccessToken = credentials.accessToken
        let heartbeatTask = Task.detached {
            let heartbeatClient = WorkerClient(baseURL: heartbeatBaseURL, accessToken: heartbeatAccessToken)
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(60))
                if Task.isCancelled { break }
                try? await heartbeatClient.heartbeat(workerId: workerId, runId: job.run_id)
            }
        }
        defer { heartbeatTask.cancel() }

        do {
            let items: [WorkerStreamItem]
            var checkpoint: [String: AnyEncodable]?
            switch job.connector_key {
            case "apple.screen_time":
                items = try await ScreenTimeSyncService.runScreenTime(job: job)
            case "local.directory":
                let out = try LocalDirectorySyncService.runLocalDirectory(job: job)
                items = out.items
                checkpoint = out.checkpoint
            case "apple.health":
                let out = try await HealthKitSyncService.runHealth(job: job)
                items = out.items
                checkpoint = out.checkpoint
            case "apple.photos":
                let out = try await PhotosSyncService.runPhotos(job: job)
                items = out.items
                checkpoint = out.checkpoint
            case "whatsapp.local":
                let out = try WhatsAppLocalSyncService.runWhatsAppLocal(job: job)
                items = out.items
                checkpoint = out.checkpoint
            default:
                try await worker.complete(workerId: workerId, runId: job.run_id, itemsCollected: 0,
                                          error: "Mac bridge cannot run connector \(job.connector_key)")
                return CycleResult(claimedJob: true, itemsStreamed: 0, connectorKey: job.connector_key, runId: job.run_id)
            }

            if !items.isEmpty {
                try await worker.stream(workerId: workerId, runId: job.run_id, items: items)
            }
            try await worker.complete(workerId: workerId, runId: job.run_id,
                                      itemsCollected: items.count, checkpoint: checkpoint, error: nil)
            return CycleResult(claimedJob: true, itemsStreamed: items.count, connectorKey: job.connector_key, runId: job.run_id)
        } catch {
            // On failure, leave the checkpoint untouched so the next run re-scans
            // from where it was.
            try? await worker.complete(workerId: workerId, runId: job.run_id,
                                       itemsCollected: 0, error: error.localizedDescription)
            throw error
        }
    }
}

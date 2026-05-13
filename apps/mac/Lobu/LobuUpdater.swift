import Combine
import Foundation
import Sparkle

/// SwiftUI-friendly wrapper around `SPUStandardUpdaterController`. Sparkle's
/// own controller is an `NSObject` and exposes its state via `@objc` properties
/// — wrap it as an `@MainActor` `ObservableObject` so the menubar view can
/// observe `canCheckForUpdates`, `updateAvailable`, and `latestVersion`.
///
/// Auto-checks fire silently in the background; the standard user driver shows
/// a small "Update available" prompt that users can accept or defer. When the
/// user clicks the menu row, `checkForUpdates()` triggers an explicit check.
@MainActor
final class LobuUpdater: NSObject, ObservableObject {
    @Published private(set) var canCheckForUpdates = false
    @Published private(set) var updateAvailable = false
    @Published private(set) var latestVersion: String?

    private var controller: SPUStandardUpdaterController!

    /// Singleton because Sparkle holds a long-lived XPC connection per process
    /// and the standard user driver wires itself to the main menu / dock.
    static let shared = LobuUpdater()

    private override init() {
        super.init()
        // Delegate must be wired at construction time — `SPUUpdater.delegate`
        // is read-only in Sparkle 2.x.
        self.controller = SPUStandardUpdaterController(
            startingUpdater: true, updaterDelegate: self, userDriverDelegate: nil
        )
        // Mirror Sparkle's KVO state through @Published.
        controller.updater.publisher(for: \.canCheckForUpdates)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] in self?.canCheckForUpdates = $0 }
            .store(in: &cancellables)
    }

    private var cancellables = Set<AnyCancellable>()

    /// Triggered by the menubar "Update to vX.Y.Z" row. Falls back to a silent
    /// `checkForUpdates()` so Sparkle's UI takes over (download + relaunch).
    func checkForUpdates() {
        controller.checkForUpdates(nil)
    }
}

// MARK: - SPUUpdaterDelegate

extension LobuUpdater: SPUUpdaterDelegate {
    nonisolated func updater(_ updater: SPUUpdater, didFindValidUpdate item: SUAppcastItem) {
        Task { @MainActor in
            self.updateAvailable = true
            self.latestVersion = item.displayVersionString
        }
    }

    nonisolated func updaterDidNotFindUpdate(_ updater: SPUUpdater) {
        Task { @MainActor in
            self.updateAvailable = false
        }
    }
}

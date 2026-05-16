import SwiftUI

@main
struct LobuApp: App {
    @StateObject private var state = AppState()

    init() {
        // Owletto Chrome native-messaging host: when Chrome spawns this
        // binary as a subprocess (extension calls chrome.runtime.connectNative),
        // we ship a single request cycle on stdin/stdout and exit before any
        // SwiftUI scene gets a chance to draw. Otherwise: install / refresh
        // the host manifest in every Chromium-family browser's
        // NativeMessagingHosts dir, idempotently, then continue normal launch.
        ChromeBridgeHost.runHostIfRequested()
        let envId = ProcessInfo.processInfo.environment["LOBU_OWLETTO_CHROME_EXTENSION_ID"]
        var extensionIds: [String] = []
        if let envId, !envId.isEmpty { extensionIds.append(envId) }
        // TODO: append the Web Store extension ID once Owletto for Chrome is
        // published. For now the env override is the only entry — unpacked
        // dev builds set LOBU_OWLETTO_CHROME_EXTENSION_ID before launch.
        if !extensionIds.isEmpty {
            ChromeBridgeHost.installManifests(extensionIds: extensionIds)
        }
    }

    var body: some Scene {
        MenuBarExtra {
            MenuBarContent(state: state)
        } label: {
            // Lobu lobster mark — vector SVG, rendered as a template so it
            // tints to the menu bar's light/dark appearance. The asset is a
            // square 18pt SVG with built-in padding (the claw mark sits at ~70%
            // of the canvas) so it reads like a normal menu-bar glyph. No
            // .resizable()/.frame() — MenuBarExtra ignores the label's frame,
            // so the size has to live in the asset itself.
            //
            // Dimmed until the user signs in, so the menu bar gives a quiet
            // "nothing connected yet" cue without an extra badge.
            HStack(spacing: 2) {
                Image("MenuBarIcon")
                    .renderingMode(.template)
                    .opacity(state.credentials == nil ? 0.4 : 1)
                if state.unreadCount > 0 {
                    Text("\(state.unreadCount)")
                        .font(.system(size: 10, weight: .semibold))
                }
            }
            .accessibilityLabel(
                state.credentials == nil ? "Lobu — not signed in"
                : state.unreadCount > 0 ? "Lobu — \(state.unreadCount) unread"
                : "Lobu"
            )
        }
        .menuBarExtraStyle(.window)
    }
}

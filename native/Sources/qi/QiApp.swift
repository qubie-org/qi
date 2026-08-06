import AppKit
import SwiftUI

/**
 The shell.

 qi is a web page and this is the window it lives in — nothing more. No
 toolbar, no title bar, no tabs, no sidebar. The three stoplights, because a
 window with no way to close it is a hostage situation, and a thin strip along
 the top to pick it up by. Everything else is the page.

 `Window` rather than `WindowGroup`: this is a single-instance app, and as the
 primary scene closing it quits, which is the behaviour anyone would expect from
 something with one window.

 `.hiddenTitleBar` is what leaves the stoplights floating over the content with
 no bar behind them. It is a real WindowStyle — unlike `.utility`, which agents
 reach for constantly and which does not exist.
 */
@main
struct QiApp: App {
  @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate

  var body: some Scene {
    Window("Qi", id: "qi") {
      Shell()
        // The page draws its own background to the edges, including under the
        // stoplights. Any container background here would sit on top of it.
        .ignoresSafeArea()
    }
    .windowStyle(.hiddenTitleBar)
    .defaultSize(width: 1240, height: 880)
  }
}

/**
 A thin delegate, which the house rule says to wire even when it looks empty.

 It is not empty here: a single-window app that has been closed to the Dock has
 to be able to come back, and there is no scene-level hook for the reopen Apple
 Event.
 */
final class AppDelegate: NSObject, NSApplicationDelegate {
  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.regular)
    NSApp.activate(ignoringOtherApps: true)
    // The window is styled once it exists. Doing this in `applicationDidFinishLaunching`
    // rather than in the scene means it runs after SwiftUI has made the window
    // but before anyone has seen it.
    DispatchQueue.main.async { Self.style(NSApp.windows.first) }
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool {
    if !hasVisibleWindows { NSApp.windows.first?.makeKeyAndOrderFront(nil) }
    return true
  }

  /// The parts of chromelessness SwiftUI has no modifier for.
  static func style(_ window: NSWindow?) {
    guard let window else { return }
    window.titlebarAppearsTransparent = true
    window.titleVisibility = .hidden
    // Full-size content: the web view runs the entire height of the window, so
    // the page's own gradient reaches the top edge instead of stopping under an
    // invisible bar.
    window.styleMask.insert(.fullSizeContentView)
    // Dragging is the header's job, not the whole background's. Making the
    // whole window movable means a click-drag that starts on a word moves the
    // window instead of selecting the word.
    window.isMovableByWindowBackground = false
    window.backgroundColor = .white
    window.minSize = NSSize(width: 520, height: 420)
  }
}

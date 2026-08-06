import SwiftUI
import WebKit

/**
 The window's contents: the page, and a strip to pick the window up by.

 The strip is deliberately almost nothing. It has no title, no buttons and no
 line under it; it appears only as a faint wash when the pointer is over it, so
 that the affordance exists for anyone looking for it and is invisible to
 everyone else. Its whole job is to be somewhere you can press without pressing
 the page.

 Its leading edge starts clear of the stoplights. Those are the window's own
 views and sit above this one, so they would keep working regardless — but a
 drag region that begins under them invites a press that lands on neither.
 */
struct Shell: View {
  /// Enough room for three buttons and the space they sit in.
  private static let stoplightInset: CGFloat = 82
  private static let headerHeight: CGFloat = 34

  @State private var hovering = false

  var body: some View {
    ZStack(alignment: .top) {
      Web()

      HStack(spacing: 0) {
        Color.clear
          .frame(width: Self.stoplightInset)
          .allowsHitTesting(false)

        Rectangle()
          .fill(.black.opacity(hovering ? 0.028 : 0))
          .contentShape(.rect)
          // WindowDragGesture is the supported way to move a window from a
          // SwiftUI view (macOS 15+). It is not a DragGesture that repositions
          // a frame — the window server does the move, so it stays smooth
          // across displays and snaps to edges like any other window.
          .gesture(WindowDragGesture())
          .onHover { hovering = $0 }
          // Double-click a title bar zooms, and this is standing in for one.
          .onTapGesture(count: 2) { NSApp.keyWindow?.zoom(nil) }
      }
      .frame(height: Self.headerHeight)
      .animation(.easeOut(duration: 0.18), value: hovering)
    }
    // Resizing needs no code: the window keeps `.resizable` from its style mask,
    // so every edge and corner already works. Only the title bar was removed.
  }
}

/**
 The page itself.

 It points at whatever is serving qi — the dev server by default, overridable
 with QI_URL. The host still answers `/llm`, `/packs` and `/otel`, so the
 shell is genuinely only a window for now; when those move into Swift this is
 the file that stops needing a URL.
 */
private struct Web: NSViewRepresentable {
  func makeNSView(context: Context) -> WKWebView {
    let config = WKWebViewConfiguration()
    // The page runs a wasm sandbox behind SharedArrayBuffer, which needs
    // cross-origin isolation. The COOP/COEP headers come from the server; all
    // this side has to do is not get in the way.
    config.defaultWebpagePreferences.allowsContentJavaScript = true

    // Mirror the page's console out to the control server, so the app can be
    // debugged without a person driving the Web Inspector. Injected at document
    // start, because the interesting failures happen during boot.
    let bridge = ConsoleBridge()
    config.userContentController.add(bridge, name: "qiConsole")
    config.userContentController.addUserScript(
      WKUserScript(source: ConsoleBridge.source, injectionTime: .atDocumentStart, forMainFrameOnly: true)
    )
    context.coordinator.bridge = bridge

    let view = WKWebView(frame: .zero, configuration: config)
    // The page paints its own background to every edge; letting the web view
    // draw one too puts an opaque white rectangle under it that shows through
    // as a seam while the first paint lands.
    view.setValue(false, forKey: "drawsBackground")
    // Web Inspector, because this is a development shell for a page that is
    // still being built.
    view.isInspectable = true

    // The control server answers against this exact view — the real one, in
    // the real window — which is the entire point of it existing.
    Control.shared.attach(view)
    Control.shared.start()

    view.load(URLRequest(url: Self.target))
    return view
  }

  func updateNSView(_ view: WKWebView, context: Context) {}

  func makeCoordinator() -> Coordinator { Coordinator() }

  /// Holds the console bridge, which WKUserContentController does not retain.
  final class Coordinator {
    var bridge: ConsoleBridge?
  }

  /**
   Where the page comes from.

   Three answers, in the order they are trusted. `QI_URL` wins because that is
   what it is for. Otherwise, if this build carries a page inside it, the app
   serves its own — that is the shipped case, and it is what makes the bundle
   standalone. Failing both, the dev server, which is what a developer running
   `swift build` without a bundled page is expecting.
   */
  private static var target: URL {
    if let raw = ProcessInfo.processInfo.environment["QI_URL"], let url = URL(string: raw) {
      return url
    }
    if let web = Bundle.main.resourceURL?.appendingPathComponent("web/index.html"),
       FileManager.default.fileExists(atPath: web.path) {
      // The page comes up first, always. A first run has two and a half
      // gigabytes to fetch before the model can start, and a window that stays
      // black until that finishes is indistinguishable from one that has hung —
      // so the page is served immediately and asks `/packs/state` what is
      // happening.
      try? Serve.shared.start()

      // Completeness, not presence. `Packs.directory` answers "is there a
      // folder", and after a cancelled download there is — containing four
      // part-files and no model. Asking the wrong question here left the
      // installer unrun and the app permanently half-installed.
      if Install.shared.complete(byId: "core") {
        Model.shared.start()
      } else {
        Task.detached {
          await Install.shared.ensure()
          // Only once the weights are actually here. Starting the server on a
          // half-downloaded file is how you get an error about a corrupt GGUF
          // that is really an error about timing.
          if Install.shared.complete(byId: "core") { await MainActor.run { Model.shared.start() } }
        }
      }

      if Serve.shared.port != 0 { return URL(string: Serve.shared.origin)! }
    }
    return URL(string: "http://localhost:8322")!
  }
}

import AppKit
import Foundation
import Network
import WebKit

/**
 A way to ask the running app questions.

 Almost everything here is `nonisolated`: the module compiles with
 `defaultIsolation(MainActor.self)`, but Network.framework delivers on its own
 queue, so leaving the transport on the main actor would mean either hopping for
 every byte read or — what the compiler actually warned about — calling main-
 actor methods from a background queue and hoping. The rule this file follows is
 that parsing and replying are nonisolated, and the three operations that touch
 WebKit hop to the main actor explicitly and only then.

 Everything about qi that is worth debugging happens inside a WKWebView, and
 until now the only way to see in was Safari's Web Inspector — which is a person
 clicking, not something a tool can drive. So verification kept happening in
 Chrome instead, against a page that is *nearly* the app: different engine,
 different window, no native shell, and a JavaScript module registry that
 reloads on its own schedule. Several hours of this session were spent measuring
 the wrong process, and one bug — audio never starting because a listener had
 already been consumed — was invisible in Chrome precisely because Chrome's
 module reloading kept handing back a fresh copy.

 This is the other end: a loopback HTTP server inside the real app, so the real
 web view can be evaluated against, screenshotted and read.

 Deliberately small and deliberately local. It binds 127.0.0.1 only, it is
 compiled in only when QI_CONTROL is set, and it speaks just enough HTTP/1.1
 to be talked to by curl or by `tools/mcp-qi.mjs`. It is a development door,
 and it is shaped so that shipping it open would still not expose anything off
 the machine.
 */
final class Control: NSObject, @unchecked Sendable {
  static let shared = Control()

  /// Set once the web view exists. Everything here is a no-op until then.
  nonisolated(unsafe) private weak var web: WKWebView?
  nonisolated(unsafe) private var listener: NWListener?

  /// Recent console output, oldest first.
  nonisolated(unsafe) private var console: [[String: String]] = []
  private let consoleLimit = 400
  private let lock = NSLock()

  // MARK: - Wiring

  /// Called by the web view once, at creation.
  nonisolated func attach(_ view: WKWebView) {
    web = view
  }

  nonisolated func record(level: String, text: String) {
    lock.lock()
    defer { lock.unlock() }
    console.append(["level": level, "text": text, "at": String(Int(Date().timeIntervalSince1970 * 1000))])
    if console.count > consoleLimit { console.removeFirst(console.count - consoleLimit) }
  }

  /**
   Start listening, if asked to.

   Off unless `QI_CONTROL` is set, so a normally-launched app has no open
   port at all. The port itself is `QI_CONTROL_PORT` or 8777.
   */
  nonisolated func start() {
    let env = ProcessInfo.processInfo.environment
    guard env["QI_CONTROL"] != nil else { return }
    let port = UInt16(env["QI_CONTROL_PORT"] ?? "") ?? 8777

    do {
      let params = NWParameters.tcp
      // Loopback only. This is the security boundary, and it is one line
      // rather than a token scheme because a token on a port that anyone on
      // the network can reach is a worse answer than not being reachable.
      params.requiredLocalEndpoint = NWEndpoint.hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: port)!)
      params.allowLocalEndpointReuse = true

      let l = try NWListener(using: params)
      l.newConnectionHandler = { [weak self] conn in self?.accept(conn) }
      l.start(queue: .global(qos: .utility))
      listener = l
      FileHandle.standardError.write("qi control on http://127.0.0.1:\(port)\n".data(using: .utf8)!)
    } catch {
      FileHandle.standardError.write("qi control failed: \(error)\n".data(using: .utf8)!)
    }
  }

  // MARK: - HTTP

  nonisolated private func accept(_ conn: NWConnection) {
    conn.start(queue: .global(qos: .utility))
    read(conn, buffer: Data())
  }

  /// Reads until the headers are complete and the declared body has arrived.
  nonisolated private func read(_ conn: NWConnection, buffer: Data) {
    conn.receive(minimumIncompleteLength: 1, maximumLength: 1 << 20) { [weak self] chunk, _, done, _ in
      guard let self else { return }
      var buf = buffer
      if let chunk { buf.append(chunk) }

      guard let headEnd = buf.range(of: Data("\r\n\r\n".utf8)) else {
        if done { conn.cancel() } else { self.read(conn, buffer: buf) }
        return
      }

      let head = String(decoding: buf[..<headEnd.lowerBound], as: UTF8.self)
      let body = buf[headEnd.upperBound...]
      let length = Self.contentLength(head)

      // A POST body can arrive in a later packet than its headers.
      if body.count < length {
        if done { conn.cancel() } else { self.read(conn, buffer: buf) }
        return
      }

      let lines = head.split(separator: "\r\n", omittingEmptySubsequences: false)
      let request = lines.first.map(String.init) ?? ""
      let parts = request.split(separator: " ")
      let method = parts.first.map(String.init) ?? "GET"
      let path = parts.count > 1 ? String(parts[1]) : "/"

      self.route(method: method, path: path, body: Data(body.prefix(length)), conn: conn)
    }
  }

  nonisolated private static func contentLength(_ head: String) -> Int {
    for line in head.split(separator: "\r\n") where line.lowercased().hasPrefix("content-length:") {
      return Int(line.split(separator: ":")[1].trimmingCharacters(in: .whitespaces)) ?? 0
    }
    return 0
  }

  nonisolated private func route(method: String, path: String, body: Data, conn: NWConnection) {
    switch (method, path) {
    case ("GET", "/health"):
      Task { @MainActor in
        let view = self.web
        self.json(conn, [
          "ok": view != nil,
          "url": view?.url?.absoluteString ?? "",
          "title": view?.title ?? "",
          "loading": view?.isLoading ?? false,
        ])
      }

    case ("POST", "/eval"):
      let source = String(decoding: body, as: UTF8.self)
      Task { @MainActor in await self.eval(source, conn) }

    case ("GET", "/console"):
      lock.lock()
      let out = console
      lock.unlock()
      json(conn, ["messages": out])

    case ("POST", "/console/clear"):
      lock.lock()
      console.removeAll()
      lock.unlock()
      json(conn, ["ok": true])

    case ("GET", "/shot"):
      Task { @MainActor in await self.shot(conn) }

    case ("POST", "/reload"):
      Task { @MainActor in
        self.web?.reload()
        self.json(conn, ["ok": true])
      }

    default:
      send(conn, status: "404 Not Found", type: "application/json", body: Data("{\"error\":\"no such route\"}".utf8))
    }
  }

  // MARK: - Operations

  /**
   Evaluate JavaScript in the page and return whatever it produced.

   `callAsyncJavaScript` rather than `evaluateJavaScript`, so the argument can
   be an async function body and `await` works — which matters because almost
   everything worth asking this app is asynchronous: dynamic imports, audio
   state, anything behind a promise.
   */
  @MainActor
  private func eval(_ source: String, _ conn: NWConnection) async {
    guard let web else {
      json(conn, ["error": "no web view yet"])
      return
    }
    do {
      let result = try await web.callAsyncJavaScript(
        source,
        arguments: [:],
        in: nil,
        contentWorld: .page
      )
      json(conn, ["ok": true, "result": Self.plain(result)])
    } catch {
      json(conn, ["ok": false, "error": String(describing: error)])
    }
  }

  /// WKWebView hands back Obj-C bridged values; JSONSerialization wants plain ones.
  nonisolated private static func plain(_ value: Any?) -> Any {
    guard let value, !(value is NSNull) else { return NSNull() }
    if JSONSerialization.isValidJSONObject([value]) { return value }
    return String(describing: value)
  }

  @MainActor
  private func shot(_ conn: NWConnection) async {
    guard let web else {
      json(conn, ["error": "no web view yet"])
      return
    }
    let config = WKSnapshotConfiguration()
    config.afterScreenUpdates = true
    do {
      let image = try await web.takeSnapshot(configuration: config)
      guard let tiff = image.tiffRepresentation,
            let rep = NSBitmapImageRep(data: tiff),
            let png = rep.representation(using: .png, properties: [:])
      else {
        json(conn, ["error": "could not encode png"])
        return
      }
      send(conn, status: "200 OK", type: "image/png", body: png)
    } catch {
      json(conn, ["error": String(describing: error)])
    }
  }

  // MARK: - Replies

  nonisolated private func json(_ conn: NWConnection, _ object: Any) {
    let data = (try? JSONSerialization.data(withJSONObject: object)) ?? Data("{}".utf8)
    send(conn, status: "200 OK", type: "application/json", body: data)
  }

  nonisolated private func send(_ conn: NWConnection, status: String, type: String, body: Data) {
    var head = "HTTP/1.1 \(status)\r\n"
    head += "content-type: \(type)\r\n"
    head += "content-length: \(body.count)\r\n"
    head += "connection: close\r\n\r\n"
    var out = Data(head.utf8)
    out.append(body)
    conn.send(content: out, completion: .contentProcessed { _ in conn.cancel() })
  }
}

/**
 Console, forwarded.

 The page's own console is invisible from outside the web view, so it is
 mirrored: a script injected before the document runs wraps each console method
 and posts a copy out. The original is still called, so the Web Inspector shows
 exactly what it always did.
 */
final class ConsoleBridge: NSObject, WKScriptMessageHandler {
  static let source = """
  (() => {
    const post = (level, args) => {
      try {
        window.webkit.messageHandlers.qiConsole.postMessage({
          level,
          text: args.map((a) => {
            if (a instanceof Error) return a.stack || String(a)
            if (typeof a === 'object' && a !== null) { try { return JSON.stringify(a) } catch { return String(a) } }
            return String(a)
          }).join(' '),
        })
      } catch {}
    }
    for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
      const original = console[level].bind(console)
      console[level] = (...args) => { post(level, args); original(...args) }
    }
    // Unhandled failures never reach console.error on their own, and they are
    // the ones worth having.
    addEventListener('error', (e) => post('error', [e.message, e.filename + ':' + e.lineno]))
    addEventListener('unhandledrejection', (e) => post('error', ['unhandled rejection:', e.reason]))
  })()
  """

  func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
    guard let body = message.body as? [String: Any] else { return }
    Control.shared.record(
      level: body["level"] as? String ?? "log",
      text: body["text"] as? String ?? ""
    )
  }
}

import Foundation
import Network

/**
 The page, served from inside the app.

 In development the page comes from Vite, which does six jobs beyond handing
 over files: it sets the cross-origin isolation headers, proxies the model
 server, serves the packs the browser loads for itself, fetches on the page's
 behalf, renders a page in a real browser, and swallows telemetry. A shipped app
 has no Vite, so it has to do all six or it is a window onto a connection error.

 ── Why an HTTP server rather than file:// ──────────────────────────────────

 The page runs a wasm sandbox over a SharedArrayBuffer, which the browser only
 hands out to a cross-origin-isolated document. Isolation is granted on the
 strength of two response headers, and `file://` has no responses to put headers
 on. A custom `WKURLSchemeHandler` can carry them, but isolation over a custom
 scheme is a thin and under-specified path; a loopback HTTP server is the same
 shape as the dev server that already works, which makes it the boring choice
 and therefore the right one.

 ── Why the port is not a constant ──────────────────────────────────────────

 It is whatever the kernel hands out. A fixed port is one `EADDRINUSE` away from
 an app that will not start — and the most likely thing occupying it is the dev
 server for this very project. Nobody types this address, so nothing is lost by
 letting it be arbitrary, and `Serve.shared.origin` is the only thing that needs
 to know.
 */
final class Serve {
  static let shared = Serve()
  private init() {}

  nonisolated(unsafe) private var listener: NWListener?
  nonisolated(unsafe) private(set) var port: UInt16 = 0

  /// Where the web view should point. Only valid after `start()` returns.
  var origin: String { "http://127.0.0.1:\(port)" }

  /// The built page, inside the bundle.
  nonisolated private var web: URL? { Bundle.main.resourceURL?.appendingPathComponent("web") }

  /// The packs the browser loads for itself — bundled, or downloaded once.
  nonisolated private var packs: URL? {
    Packs.bundled ?? (FileManager.default.fileExists(atPath: Packs.installed.path) ? Packs.installed : nil)
  }

  /**
   Cross-origin isolation, on every response.

   Not only on the document. A page is isolated only if everything it loads
   agrees to be embedded, so the resource policy has to travel with each asset —
   miss it on the wasm and the SharedArrayBuffer is simply absent, with no error
   that names the cause.
   */
  nonisolated private static let isolate = [
    "Cross-Origin-Opener-Policy: same-origin",
    "Cross-Origin-Embedder-Policy: require-corp",
    "Cross-Origin-Resource-Policy: cross-origin",
  ]

  func start() throws {
    let params = NWParameters.tcp
    params.requiredLocalEndpoint = NWEndpoint.hostPort(host: "127.0.0.1", port: .any)
    params.allowLocalEndpointReuse = true

    let l = try NWListener(using: params)
    l.newConnectionHandler = { [weak self] conn in self?.accept(conn) }

    let ready = DispatchSemaphore(value: 0)
    l.stateUpdateHandler = { [weak self] state in
      if case .ready = state {
        self?.port = l.port?.rawValue ?? 0
        ready.signal()
      }
    }
    l.start(queue: .global(qos: .userInitiated))
    listener = l
    _ = ready.wait(timeout: .now() + 5)
    FileHandle.standardError.write("qi serving on \(origin)\n".data(using: .utf8)!)
  }

  // ── the connection ────────────────────────────────────────────────────────

  nonisolated private func accept(_ conn: NWConnection) {
    conn.start(queue: .global(qos: .userInitiated))
    read(conn, buffer: Data())
  }

  /**
   Read until the headers are complete, then until the body is.

   `Content-Length` is honoured because the two POST routes need their bodies
   whole. Anything without a length is treated as complete at the blank line,
   which covers every GET the page makes.
   */
  nonisolated private func read(_ conn: NWConnection, buffer: Data) {
    conn.receive(minimumIncompleteLength: 1, maximumLength: 1 << 16) { [weak self] chunk, _, done, error in
      guard let self else { return }
      var buf = buffer
      if let chunk { buf.append(chunk) }

      if let split = Self.headerEnd(buf) {
        let head = String(decoding: buf[..<split.0], as: UTF8.self)
        let length = Self.contentLength(head) ?? 0
        let body = buf[split.1...]
        if body.count >= length {
          self.route(head: head, body: Data(body.prefix(length)), conn: conn)
          return
        }
      }
      if error != nil || done { conn.cancel(); return }
      self.read(conn, buffer: buf)
    }
  }

  nonisolated private static func headerEnd(_ d: Data) -> (Data.Index, Data.Index)? {
    let marker = Data("\r\n\r\n".utf8)
    guard let r = d.range(of: marker) else { return nil }
    return (r.lowerBound, r.upperBound)
  }

  nonisolated private static func contentLength(_ head: String) -> Int? {
    for line in head.split(separator: "\r\n") where line.lowercased().hasPrefix("content-length:") {
      return Int(line.split(separator: ":", maxSplits: 1)[1].trimmingCharacters(in: .whitespaces))
    }
    return nil
  }

  // ── routing ───────────────────────────────────────────────────────────────

  nonisolated private func route(head: String, body: Data, conn: NWConnection) {
    let first = head.split(separator: "\r\n").first.map(String.init) ?? ""
    let parts = first.split(separator: " ")
    guard parts.count >= 2 else { return send(conn, status: "400 Bad Request", type: "text/plain", body: Data()) }
    let method = String(parts[0])
    let target = String(parts[1])
    let path = String(target.split(separator: "?").first ?? "")

    switch true {
    // The model server, forwarded whole. See `proxy` for why nothing is parsed.
    case path == "/llm" || path.hasPrefix("/llm/"):
      proxy(head: head, body: body, conn: conn, to: 8082, strip: "/llm")

    // Optional packs. Not installed in this build; saying so is better than a
    // connection refused, which the page would report as a crash.
    case path.hasPrefix("/pack/"):
      send(conn, status: "503 Service Unavailable", type: "application/json", body: Data(#"{"error":"pack not installed"}"#.utf8))

    case path == "/net/fetch" && method == "POST":
      Task { await self.netFetch(body: body, conn: conn) }

    case path == "/net/render" && method == "POST":
      Task { await self.netRender(body: body, conn: conn) }

    // Telemetry, accepted and dropped. 200 regardless: a failed export must
    // never make the page retry forever, and least of all must it surface to
    // whoever is talking.
    case path.hasPrefix("/otel/"):
      send(conn, status: "200 OK", type: "application/json", body: Data("{}".utf8))

    case path == "/packs/installed":
      let json = try? JSONSerialization.data(withJSONObject: Packs.ready())
      send(conn, status: "200 OK", type: "application/json", body: json ?? Data("[]".utf8))

    // What the first run is doing, so the page can say so rather than looking
    // frozen for the twenty minutes a first download takes.
    case path == "/packs/state":
      let json = try? JSONSerialization.data(withJSONObject: Install.shared.snapshot())
      send(conn, status: "200 OK", type: "application/json", body: json ?? Data("{}".utf8))

    case path.hasPrefix("/packs/"):
      serveFile(under: packs, relative: String(path.dropFirst("/packs/".count)), conn: conn)

    default:
      // Everything else is the page. Unknown paths fall back to index.html so a
      // deep link is the app's problem rather than a 404.
      let rel = path == "/" ? "index.html" : String(path.dropFirst())
      serveFile(under: web, relative: rel, conn: conn, fallback: "index.html")
    }
  }

  // ── static files ──────────────────────────────────────────────────────────

  nonisolated private func serveFile(under root: URL?, relative: String, conn: NWConnection, fallback: String? = nil) {
    guard let root else { return send(conn, status: "404 Not Found", type: "text/plain", body: Data()) }
    // `..` cannot escape the bundle: the path is resolved and then required to
    // still be inside the directory it came from.
    let target = root.appendingPathComponent(relative).standardizedFileURL
    let inside = target.path.hasPrefix(root.standardizedFileURL.path)

    if inside, let data = try? Data(contentsOf: target, options: .mappedIfSafe), !target.hasDirectoryPath {
      return send(conn, status: "200 OK", type: Self.mime(target.pathExtension), body: data)
    }
    if let fallback, let data = try? Data(contentsOf: root.appendingPathComponent(fallback)) {
      return send(conn, status: "200 OK", type: "text/html; charset=utf-8", body: data)
    }
    send(conn, status: "404 Not Found", type: "text/plain", body: Data())
  }

  /**
   Content types that actually matter.

   `.wasm` is the one worth being careful about: served as anything else,
   `instantiateStreaming` refuses it, and the failure reads as a corrupt module
   rather than a wrong header. `.js` as `text/javascript` for the same class of
   reason — a module script with the wrong type is simply not executed.
   */
  nonisolated private static func mime(_ ext: String) -> String {
    switch ext.lowercased() {
    case "html": return "text/html; charset=utf-8"
    case "js", "mjs": return "text/javascript; charset=utf-8"
    case "css": return "text/css; charset=utf-8"
    case "json": return "application/json; charset=utf-8"
    case "wasm": return "application/wasm"
    case "svg": return "image/svg+xml"
    case "png": return "image/png"
    case "jpg", "jpeg": return "image/jpeg"
    case "webp": return "image/webp"
    case "woff2": return "font/woff2"
    case "onnx", "gguf", "bin": return "application/octet-stream"
    default: return "application/octet-stream"
    }
  }

  // ── the model server ──────────────────────────────────────────────────────

  /**
   Forward the request, then forward whatever comes back, verbatim.

   Nothing is parsed in either direction and that is deliberate. Replies stream —
   the river shows tokens as they arrive — so the response is a sequence of
   server-sent events with no length, arriving over an indefinite period. A
   proxy that understood HTTP would have to understand chunked encoding, event
   framing and back-pressure to hand that through; a proxy that understands only
   bytes hands it through by doing nothing, and cannot get it wrong.

   The single edit is the request line, because llama-server does not know it is
   mounted under `/llm`.
   */
  nonisolated private func proxy(head: String, body: Data, conn: NWConnection, to port: UInt16, strip: String) {
    let upstream = NWConnection(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: port)!, using: .tcp)

    var lines = head.components(separatedBy: "\r\n")
    if let first = lines.first {
      let parts = first.split(separator: " ", maxSplits: 2).map(String.init)
      if parts.count >= 3 {
        var target = parts[1]
        if target.hasPrefix(strip) { target = String(target.dropFirst(strip.count)) }
        if target.isEmpty { target = "/" }
        lines[0] = "\(parts[0]) \(target) \(parts[2])"
      }
    }
    // Keep-alive would leave this socket open waiting for a second request that
    // never comes, and the page would sit on a reply it already had.
    lines = lines.filter { !$0.lowercased().hasPrefix("connection:") }
    var request = Data(lines.joined(separator: "\r\n").utf8)
    request.append(Data("\r\n\r\n".utf8))
    request.append(body)

    upstream.stateUpdateHandler = { state in
      if case .failed = state {
        self.send(conn, status: "502 Bad Gateway", type: "application/json",
                  body: Data(#"{"error":"the model server is not running"}"#.utf8))
      }
    }
    upstream.start(queue: .global(qos: .userInitiated))
    upstream.send(content: request, completion: .contentProcessed { _ in })
    Self.pump(from: upstream, to: conn)
  }

  /// Byte pump, until one end stops.
  nonisolated private static func pump(from: NWConnection, to: NWConnection) {
    from.receive(minimumIncompleteLength: 1, maximumLength: 1 << 16) { chunk, _, done, error in
      if let chunk, !chunk.isEmpty {
        to.send(content: chunk, completion: .contentProcessed { _ in })
      }
      if done || error != nil {
        to.send(content: nil, contentContext: .finalMessage, isComplete: true, completion: .contentProcessed { _ in to.cancel() })
        from.cancel()
        return
      }
      pump(from: from, to: to)
    }
  }

  // ── fetching, on the page's behalf ────────────────────────────────────────

  nonisolated private func netFetch(body: Data, conn: NWConnection) async {
    guard let req = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
          let raw = req["url"] as? String, let url = URL(string: raw),
          let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https"
    else {
      return send(conn, status: "400 Bad Request", type: "application/json",
                  body: Data(#"{"error":"a http(s) url is required"}"#.utf8))
    }

    var request = URLRequest(url: url, timeoutInterval: 20)
    request.setValue("qi", forHTTPHeaderField: "user-agent")
    do {
      let (data, response) = try await URLSession.shared.data(for: request)
      let type = (response as? HTTPURLResponse)?.value(forHTTPHeaderField: "content-type") ?? "text/plain"
      let code = (response as? HTTPURLResponse)?.statusCode ?? 200
      let payload: [String: Any] = ["ok": (200..<300).contains(code), "status": code,
                                    "type": type, "text": String(decoding: data, as: UTF8.self)]
      send(conn, status: "200 OK", type: "application/json",
           body: (try? JSONSerialization.data(withJSONObject: payload)) ?? Data("{}".utf8))
    } catch {
      let payload: [String: Any] = ["ok": false, "status": 0, "why": String(describing: error)]
      send(conn, status: "200 OK", type: "application/json",
           body: (try? JSONSerialization.data(withJSONObject: payload)) ?? Data("{}".utf8))
    }
  }

  /**
   A page rendered by the bundled browser.

   Spawned per request, exactly as the dev server does it — a page that hangs or
   segfaults takes its own process down and nothing else, which has already
   happened once and is the reason this is not a long-lived browser.
   */
  nonisolated private func netRender(body: Data, conn: NWConnection) async {
    guard let req = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
          let raw = req["url"] as? String, let url = URL(string: raw),
          let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https",
          let browser = Bundle.main.executableURL?.deletingLastPathComponent()
            .appendingPathComponent("lightpanda"),
          FileManager.default.isExecutableFile(atPath: browser.path)
    else {
      return send(conn, status: "200 OK", type: "application/json",
                  body: Data(#"{"ok":false,"why":"no renderer"}"#.utf8))
    }

    let task = Process()
    task.executableURL = browser
    task.arguments = ["fetch", url.absoluteString, "--dump", "markdown",
                      "--strip-mode", "js,css", "--http-timeout", "10000",
                      "--block-private-networks", "--obey-robots"]
    let out = Pipe()
    task.standardOutput = out
    task.standardError = Pipe()

    do { try task.run() } catch {
      return send(conn, status: "200 OK", type: "application/json",
                  body: Data(#"{"ok":false,"why":"renderer would not start"}"#.utf8))
    }

    // A hard deadline, because the browser hangs on roughly a third of pages
    // and the caller is waiting on this socket.
    let deadline = DispatchWorkItem { if task.isRunning { task.terminate() } }
    DispatchQueue.global().asyncAfter(deadline: .now() + 12, execute: deadline)
    let data = out.fileHandleForReading.readDataToEndOfFile()
    task.waitUntilExit()
    deadline.cancel()

    let text = String(decoding: data, as: UTF8.self)
    let payload: [String: Any] = text.isEmpty
      ? ["ok": false, "url": url.absoluteString, "why": "nothing rendered"]
      : ["ok": true, "url": url.absoluteString, "text": text]
    send(conn, status: "200 OK", type: "application/json",
         body: (try? JSONSerialization.data(withJSONObject: payload)) ?? Data("{}".utf8))
  }

  // ── writing ───────────────────────────────────────────────────────────────

  nonisolated private func send(_ conn: NWConnection, status: String, type: String, body: Data) {
    var head = "HTTP/1.1 \(status)\r\nContent-Type: \(type)\r\nContent-Length: \(body.count)\r\n"
    head += Self.isolate.joined(separator: "\r\n") + "\r\n"
    head += "Cache-Control: no-store\r\nConnection: close\r\n\r\n"
    var out = Data(head.utf8)
    out.append(body)
    conn.send(content: out, completion: .contentProcessed { _ in conn.cancel() })
  }
}

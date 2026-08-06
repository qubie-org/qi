import Foundation

/**
 The model server, started by the app that needs it.

 In development this is `tools/serve.sh` in another terminal. A shipped app has
 no terminal and no shell script, so it starts its own — the same binary, the
 same flags, the same two corrections that script had to learn, because every
 one of them was learned from a failure that would otherwise happen again here.

 It is a subprocess rather than a library. Linking llama.cpp into the app would
 mean reimplementing the HTTP surface the page already speaks to — `/completion`,
 `/apply-template`, `/lora-adapters`, `/props` — and every one of those is a
 place to introduce a difference between the shipped app and the one that was
 developed against. A subprocess is the same server in both.
 */
final class Model {
  static let shared = Model()
  private init() {}

  private var task: Process?

  /// Where the weights are — bundled in this build, or downloaded once.
  private var packs: URL? { Packs.directory("core")?.deletingLastPathComponent() }

  /// The port the page's `/llm` proxy forwards to. Matches the dev catalogue.
  static let port: UInt16 = 8082

  /**
   Start it, unless something is already answering.

   The check matters during development, where `tools/serve.sh` may already be
   running: starting a second server on the same port produces a bind error, an
   app with no model, and no obvious connection between the two.
   */
  func start() {
    if reachable() {
      FileHandle.standardError.write("qi: a model server is already running on \(Self.port)\n".data(using: .utf8)!)
      return
    }
    guard let core = try? FileManager.default
            .contentsOfDirectory(atPath: Packs.directory("core")?.path ?? "")
            .first(where: { $0.hasSuffix(".gguf") }),
          let packs,
          let server = Bundle.main.executableURL?.deletingLastPathComponent()
            .appendingPathComponent("llama-server"),
          FileManager.default.isExecutableFile(atPath: server.path)
    else {
      FileHandle.standardError.write("qi: no bundled model server or core pack\n".data(using: .utf8)!)
      return
    }

    var args = ["-m", packs.appendingPathComponent("core/\(core)").path]
    args += adapters().flatMap { ["--lora", $0.path] }
    args += [
      "--port", String(Self.port), "--host", "127.0.0.1",
      // Without --jinja the model's own chat template is not applied, and
      // Granite cannot emit a tool call at all.
      "--jinja",
      "-c", "32768", "-ngl", "99", "--no-webui",
      // The 8-bit KV cache is the difference between a long conversation and an
      // out-of-memory kill; the quality cost at q8_0 is not measurable here.
      "-ctk", "q8_0", "-ctv", "q8_0",
    ]

    let p = Process()
    p.executableURL = server
    p.arguments = args
    // Its own log, not the app's stderr, so a crash leaves something to read.
    let log = FileManager.default.temporaryDirectory.appendingPathComponent("qi-llama.log")
    FileManager.default.createFile(atPath: log.path, contents: nil)
    if let handle = try? FileHandle(forWritingTo: log) {
      p.standardOutput = handle
      p.standardError = handle
    }

    do { try p.run() } catch {
      FileHandle.standardError.write("qi: model server would not start — \(error)\n".data(using: .utf8)!)
      return
    }
    task = p
    silence()
  }

  /**
   Every adapter, once.

   The same union the installer performs: a name appearing in both `rag/` and
   `rag/alora/` is the *same* intrinsic in two forms, and the activated one
   wins. Loading both would put two copies of one adapter on the shelf under
   different ids, and a request naming the plain one would silently get
   different weights than intended — which `check.sh` caught exactly once, which
   is the argument for the rule existing.
   */
  private func adapters() -> [URL] {
    guard let rag = Packs.directory("rag") else { return [] }
    let fm = FileManager.default
    let plain = (try? fm.contentsOfDirectory(atPath: rag.path)) ?? []
    let activated = (try? fm.contentsOfDirectory(atPath: rag.appendingPathComponent("alora").path)) ?? []
    let names = Set(plain + activated).filter { $0.hasSuffix(".gguf") }.sorted()

    return names.map { name in
      let a = rag.appendingPathComponent("alora/\(name)")
      return fm.fileExists(atPath: a.path) ? a : rag.appendingPathComponent(name)
    }
  }

  /**
   Put every adapter back to zero.

   `--lora-init-without-apply` is documented to load adapters without applying
   them. In b10250 it does not: `/lora-adapters` reports every one of them at
   scale 1.0, and five rank-32 deltas stacked on top of each other turn the
   model into a machine that emits `<tool_call></tool_response>` forever. It
   passes no test and fails no startup check — the server comes up fine and the
   weights are quietly wrong.

   So the scales are zeroed once the server answers. After this the base model
   is the base model, and a request naming an adapter gets that one only.
   */
  private func silence() {
    let count = adapters().count
    guard count > 0 else { return }
    DispatchQueue.global(qos: .utility).async {
      for _ in 0..<60 {
        if self.reachable() { break }
        Thread.sleep(forTimeInterval: 2)
      }
      let body = (0..<count).map { ["id": $0, "scale": 0] }
      guard let data = try? JSONSerialization.data(withJSONObject: body),
            let url = URL(string: "http://127.0.0.1:\(Self.port)/lora-adapters")
      else { return }
      var req = URLRequest(url: url)
      req.httpMethod = "POST"
      req.setValue("application/json", forHTTPHeaderField: "Content-Type")
      req.httpBody = data
      let done = DispatchSemaphore(value: 0)
      URLSession.shared.dataTask(with: req) { _, response, _ in
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        if !(200..<300).contains(code) {
          FileHandle.standardError.write(
            "qi: WARNING could not zero adapter scales — replies will be garbage\n".data(using: .utf8)!)
        }
        done.signal()
      }.resume()
      _ = done.wait(timeout: .now() + 10)
    }
  }

  private func reachable() -> Bool {
    guard let url = URL(string: "http://127.0.0.1:\(Self.port)/props") else { return false }
    var req = URLRequest(url: url)
    req.timeoutInterval = 1.5
    var alive = false
    let done = DispatchSemaphore(value: 0)
    URLSession.shared.dataTask(with: req) { _, response, _ in
      alive = (200..<300).contains((response as? HTTPURLResponse)?.statusCode ?? 0)
      done.signal()
    }.resume()
    _ = done.wait(timeout: .now() + 2)
    return alive
  }

  /// Stop it when the app goes. A left-behind server holds 2 GB and the port.
  func stop() {
    task?.terminate()
    task = nil
  }
}

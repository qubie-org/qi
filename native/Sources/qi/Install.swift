import CryptoKit
import Foundation

/**
 Getting the weights, once, without lying about it.

 Two and a half gigabytes over somebody's hotel wifi is not a download, it is a
 sequence of interrupted downloads, and every property here exists because of
 something that has already gone wrong in this project:

   resume        a 2 GB file that restarts from zero on a dropped connection
                 never finishes on a bad link
   verify        a corrupt GGUF was downloaded once and `llama-bench`
                 benchmarked it happily; nothing noticed until the server
                 refused to load it
   retry         transient 5xx and connection resets are the normal case at
                 this size, not the exception
   parallel      one stream does not saturate a link; the difference on a
                 2 GB file is minutes against tens of minutes
   state         written to disk, because the app will be quit mid-download and
                 relaunching must continue rather than begin

 ── On Xet ──────────────────────────────────────────────────────────────────

 Hugging Face's fast path is Xet, a content-addressed chunked protocol, and its
 client is Python. `HF_XET_HIGH_PERFORMANCE=1` is what makes it quick and it
 does nothing here, because nothing here is huggingface_hub — this is
 URLSession against `/resolve/main/`, which is a plain CDN redirect.

 What actually gets the throughput on that path is asking for several byte
 ranges at once, which is what `chunks` below does. It is not Xet and does not
 pretend to be: no deduplication, no cross-file chunk reuse. It is the part of
 the benefit that is available without reimplementing a protocol, and on a
 single 2 GB file — which is what this downloads — dedup would have bought
 nothing anyway.
 */
nonisolated final class Install: @unchecked Sendable {
  static let shared = Install()
  private init() {}

  enum State: Equatable {
    case absent
    case fetching(done: Int64, total: Int64)
    case verifying
    case ready
    case failed(String)
  }

  /// Per-pack state, as the page should see it.
  private var states: [String: State] = [:]
  private let lock = NSLock()

  /// Where our own converted artefacts live, since HF does not host them.
  /// The activated adapters were produced by a local conversion; there is no
  /// upstream to mirror, so they travel with the release that needs them.
  static let releases = "https://github.com/shinyobjectz/qi/releases/download"
  static let releaseTag = "weights-v1"

  func state(of pack: String) -> State {
    lock.lock(); defer { lock.unlock() }
    return states[pack] ?? (complete(byId: pack) ? .ready : .absent)
  }

  private func set(_ pack: String, _ s: State) {
    lock.lock(); states[pack] = s; lock.unlock()
  }

  /// Every pack's state, for `/packs/state`.
  func snapshot() -> [String: [String: Any]] {
    var out: [String: [String: Any]] = [:]
    for pack in Catalog.load() {
      switch state(of: pack.id) {
      case .absent: out[pack.id] = ["state": "absent", "bytes": pack.bytes ?? 0]
      case .fetching(let d, let t): out[pack.id] = ["state": "fetching", "done": d, "total": t]
      case .verifying: out[pack.id] = ["state": "verifying"]
      case .ready: out[pack.id] = ["state": "ready"]
      case .failed(let why): out[pack.id] = ["state": "failed", "why": why]
      }
    }
    return out
  }

  // ── what is already here ──────────────────────────────────────────────────

  func complete(_ pack: Pack) -> Bool {
    guard let dir = Packs.directory(pack.id) else { return false }
    let fm = FileManager.default
    for file in pack.files {
      let plain = dir.appendingPathComponent(file.to)
      let activated = dir.appendingPathComponent("alora/\(file.to)")
      if !fm.fileExists(atPath: plain.path) && !fm.fileExists(atPath: activated.path) { return false }
    }
    return !pack.files.isEmpty
  }

  /// Whether a pack is present *and finished*. Not the same question as
  /// whether its directory exists — an interrupted download leaves a directory
  /// full of `.partN` files, and treating that as installed is how a first run
  /// that was cancelled once never resumes.
  func complete(byId id: String) -> Bool {
    guard let pack = Catalog.load().first(where: { $0.id == id }) else { return false }
    return complete(pack)
  }

  // ── the run ───────────────────────────────────────────────────────────────

  /**
   Fetch everything required that is not already here.

   Only `required` packs. The optional ones are optional precisely so that a
   first launch is not gated on downloading a vision model nobody asked for.
   */
  func ensure(_ onChange: @escaping @Sendable () -> Void = {}) async {
    for pack in Catalog.load() where (pack.required ?? false) {
      if complete(pack) { set(pack.id, .ready); onChange(); continue }
      do {
        try await fetch(pack, onChange)
        set(pack.id, .ready)
      } catch {
        set(pack.id, .failed(String(describing: error)))
      }
      onChange()
    }
  }

  private func fetch(_ pack: Pack, _ onChange: @escaping @Sendable () -> Void) async throws {
    let dir = Packs.installed.appendingPathComponent(pack.id)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)

    let total = Int64(pack.bytes ?? 0)
    var done: Int64 = 0
    set(pack.id, .fetching(done: 0, total: total))

    for file in pack.files {
      // An activated adapter sits in `alora/` and is a different file from its
      // plain twin — same name, different weights. Keeping them apart on disk
      // is what lets the server prefer one without a second naming scheme.
      let isDerived = pack.derived?.contains(file.to) ?? false
      let target = isDerived
        ? dir.appendingPathComponent("alora/\(file.to)")
        : dir.appendingPathComponent(file.to)
      try FileManager.default.createDirectory(
        at: target.deletingLastPathComponent(), withIntermediateDirectories: true)

      if FileManager.default.fileExists(atPath: target.path) {
        done += size(target)
        set(pack.id, .fetching(done: done, total: total))
        continue
      }

      let source = isDerived
        ? URL(string: "\(Self.releases)/\(Self.releaseTag)/\(pack.id)-alora-\(file.to)")!
        : URL(string: "https://huggingface.co/\(pack.repo ?? "")/resolve/main/\(file.from)")!

      let alreadyDone = done
      try await download(source, to: target) { got in
        self.set(pack.id, .fetching(done: alreadyDone + got, total: total))
        onChange()
      }
      done += size(target)

      if let want = pack.sha256?[file.to] {
        set(pack.id, .verifying)
        onChange()
        let got = try digest(target)
        guard got == want else {
          try? FileManager.default.removeItem(at: target)
          throw Failure("\(file.to) arrived corrupt — expected \(want.prefix(12))…, got \(got.prefix(12))…")
        }
      }
    }
  }

  private func size(_ url: URL) -> Int64 {
    let attrs = try? FileManager.default.attributesOfItem(atPath: url.path)
    return (attrs?[.size] as? NSNumber)?.int64Value ?? 0
  }

  struct Failure: LocalizedError {
    let why: String
    init(_ why: String) { self.why = why }
    var errorDescription: String? { why }
  }

  // ── one file ──────────────────────────────────────────────────────────────

  /// How many ranges to ask for at once on a large file.
  private static let streams = 4
  /// Below this, one stream is faster than the bookkeeping for several.
  private static let parallelAbove: Int64 = 256 << 20
  private static let attempts = 5

  /**
   Download, in as many pieces as is useful, resuming whatever survived.

   Each range lands in its own `.partN` beside the target, so an interrupted run
   leaves the finished ranges finished. Restarting re-asks only for the bytes
   that are missing, which is the property that makes a 2 GB file survivable on
   a link that drops.
   */
  private func download(_ url: URL, to target: URL, _ progress: @escaping @Sendable (Int64) -> Void) async throws {
    let length = try await contentLength(url)
    let parallel = length > Self.parallelAbove && length > 0

    if !parallel {
      try await range(url, to: target.appendingPathExtension("part0"), from: 0, to: nil, progress: progress)
      try? FileManager.default.removeItem(at: target)
      try FileManager.default.moveItem(at: target.appendingPathExtension("part0"), to: target)
      return
    }

    let span = length / Int64(Self.streams)
    let counters = Counters()
    try await withThrowingTaskGroup(of: Void.self) { group in
      for i in 0..<Self.streams {
        let start = Int64(i) * span
        let end = i == Self.streams - 1 ? length - 1 : start + span - 1
        let part = target.appendingPathExtension("part\(i)")
        group.addTask {
          try await self.range(url, to: part, from: start, to: end) { got in
            progress(counters.add(i, got))
          }
        }
      }
      try await group.waitForAll()
    }

    // Join, in order. Streaming rather than loading: 2 GB does not want to be
    // in memory to be concatenated.
    try? FileManager.default.removeItem(at: target)
    FileManager.default.createFile(atPath: target.path, contents: nil)
    let out = try FileHandle(forWritingTo: target)
    defer { try? out.close() }
    for i in 0..<Self.streams {
      let part = target.appendingPathExtension("part\(i)")
      let handle = try FileHandle(forReadingFrom: part)
      while let block = try handle.read(upToCount: 8 << 20), !block.isEmpty {
        try out.write(contentsOf: block)
      }
      try? handle.close()
      try? FileManager.default.removeItem(at: part)
    }
  }

  /// Per-stream byte counts, so progress is the sum rather than the last report.
  nonisolated private final class Counters: @unchecked Sendable {
    private var seen: [Int: Int64] = [:]
    private let lock = NSLock()
    func add(_ stream: Int, _ bytes: Int64) -> Int64 {
      lock.lock(); defer { lock.unlock() }
      seen[stream] = bytes
      return seen.values.reduce(0, +)
    }
  }

  /**
   One byte range, retried, resuming from whatever is already on disk.

   The retry is backed off rather than immediate: the failures at this size are
   rate limits and transient gateway errors, and hammering them is how a slow
   download becomes a refused one.
   */
  private func range(
    _ url: URL, to part: URL, from start: Int64, to end: Int64?,
    progress: @escaping @Sendable (Int64) -> Void
  ) async throws {
    var last: Error = Failure("not attempted")

    for attempt in 0..<Self.attempts {
      let have = FileManager.default.fileExists(atPath: part.path) ? size(part) : 0
      if let end, have >= end - start + 1 { progress(have); return }

      var request = URLRequest(url: url)
      request.timeoutInterval = 60
      request.setValue("qi", forHTTPHeaderField: "user-agent")
      let from = start + have
      if let end {
        request.setValue("bytes=\(from)-\(end)", forHTTPHeaderField: "Range")
      } else if have > 0 {
        request.setValue("bytes=\(from)-", forHTTPHeaderField: "Range")
      }

      do {
        let (stream, response) = try await URLSession.shared.bytes(for: request)
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(code) else { throw Failure("HTTP \(code)") }
        // A server that ignores Range answers 200 and sends the whole file; the
        // bytes already on disk are then wrong to keep.
        let resumed = code == 206
        if !resumed && have > 0 { try? FileManager.default.removeItem(at: part) }

        if !FileManager.default.fileExists(atPath: part.path) {
          FileManager.default.createFile(atPath: part.path, contents: nil)
        }
        let handle = try FileHandle(forWritingTo: part)
        defer { try? handle.close() }
        if resumed { try handle.seekToEnd() }

        var written: Int64 = resumed ? have : 0
        var buffer = Data()
        buffer.reserveCapacity(4 << 20)
        for try await byte in stream {
          buffer.append(byte)
          if buffer.count >= 4 << 20 {
            try handle.write(contentsOf: buffer)
            written += Int64(buffer.count)
            buffer.removeAll(keepingCapacity: true)
            progress(written)
          }
        }
        if !buffer.isEmpty {
          try handle.write(contentsOf: buffer)
          written += Int64(buffer.count)
        }
        progress(written)
        return
      } catch {
        last = error
        // 1s, 2s, 4s, 8s. Long enough to outlast a rate limit, short enough
        // that a person watching does not conclude it has hung.
        try? await Task.sleep(nanoseconds: UInt64(1 << attempt) * 1_000_000_000)
      }
    }
    throw last
  }

  private func contentLength(_ url: URL) async throws -> Int64 {
    var request = URLRequest(url: url)
    request.httpMethod = "HEAD"
    request.timeoutInterval = 30
    let (_, response) = try await URLSession.shared.data(for: request)
    return (response as? HTTPURLResponse)?.expectedContentLength ?? -1
  }

  /// sha256, streamed. The file is larger than anything worth holding whole.
  private func digest(_ url: URL) throws -> String {
    let handle = try FileHandle(forReadingFrom: url)
    defer { try? handle.close() }
    var hasher = SHA256()
    while let block = try handle.read(upToCount: 8 << 20), !block.isEmpty {
      hasher.update(data: block)
    }
    return hasher.finalize().map { String(format: "%02x", $0) }.joined()
  }
}

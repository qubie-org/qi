import Foundation

/**
 The weights: where they live, and how they get there.

 They used to be in the bundle, and moving them out is a trade rather than an
 improvement. Inside, the app worked the moment it was copied and never touched
 the network; outside, every update Sparkle ships is the app rather than the app
 plus two and a half gigabytes of weights that did not change. The second
 property is worth more, because it is paid every release and the first is paid
 once.

 What it costs is that a fresh install needs the network exactly once. That is
 the whole reason this file is careful: a download that fails halfway and cannot
 resume, or that succeeds and writes a truncated file nobody checks, turns a
 one-time cost into a broken app with no obvious cause. Both have already
 happened in this project — a 3.8 GB GGUF whose hash did not match, which
 `llama-bench` then benchmarked perfectly happily.

 ── Where they end up ───────────────────────────────────────────────────────

 `~/Library/Application Support/Qi/packs`, and the bundle is still consulted
 first. A build made with `QI_BUNDLE_PACKS=1` therefore needs no network at all
 and this whole file stays asleep — which keeps the fully-bundled DMG a
 supported thing to make rather than a path that quietly rots.
 */
nonisolated enum Packs {
  /// The app's own directory, created on demand.
  static var support: URL {
    let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("Qi", isDirectory: true)
    try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
    return base
  }

  static var installed: URL { support.appendingPathComponent("packs", isDirectory: true) }

  /// Bundled weights, when this build has them.
  static var bundled: URL? {
    guard let r = Bundle.main.resourceURL?.appendingPathComponent("packs") else { return nil }
    return FileManager.default.fileExists(atPath: r.path) ? r : nil
  }

  /**
   Where a pack actually is.

   Bundle first. A build that carries its weights must never go looking on disk
   for a copy that a previous build downloaded — two versions of the same pack
   with one of them stale is a class of bug worth designing out rather than
   detecting.
   */
  static func directory(_ pack: String) -> URL? {
    if let b = bundled?.appendingPathComponent(pack),
       FileManager.default.fileExists(atPath: b.path) { return b }
    let d = installed.appendingPathComponent(pack)
    return FileManager.default.fileExists(atPath: d.path) ? d : nil
  }

  /// Every pack that is present and complete, by id.
  static func ready() -> [String] {
    Catalog.load().filter { Install.shared.complete($0) }.map(\.id)
  }
}

// ── the catalogue ───────────────────────────────────────────────────────────

/**
 What each pack is, read from the same file the installer and the page read.

 Bundled as a resource rather than compiled in, so the list of weights is one
 document with one owner. A second copy in Swift would be a second thing to
 forget to update, and the failure would be an app that downloads the wrong
 file and verifies it against the wrong hash.
 */
struct Pack: Decodable {
  struct Move: Decodable {
    let from: String
    let to: String
  }

  let id: String
  let title: String?
  let repo: String?
  let required: Bool?
  let bytes: Int?
  /// Files, either a bare path or a `{from,to}` move.
  let files: [Move]
  /// Verified after download. A pack with no hashes cannot be verified and says so.
  let sha256: [String: String]?
  /// Files this project produced rather than mirrored — fetched from our own release.
  let derived: [String]?

  private enum CodingKeys: String, CodingKey {
    case id, title, repo, required, bytes, files, sha256, derived
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    id = try c.decode(String.self, forKey: .id)
    title = try? c.decode(String.self, forKey: .title)
    repo = try? c.decode(String.self, forKey: .repo)
    required = try? c.decode(Bool.self, forKey: .required)
    bytes = try? c.decode(Int.self, forKey: .bytes)
    sha256 = try? c.decode([String: String].self, forKey: .sha256)
    derived = try? c.decode([String].self, forKey: .derived)

    // `files` is heterogeneous by design: most packs name a file, some rename
    // it on the way in. Decoding both shapes here keeps that convenience in the
    // document rather than pushing it onto every reader.
    var out: [Move] = []
    if var list = try? c.nestedUnkeyedContainer(forKey: .files) {
      while !list.isAtEnd {
        if let move = try? list.decode(Move.self) { out.append(move) }
        else if let path = try? list.decode(String.self) {
          out.append(Move(from: path, to: String(path.split(separator: "/").last ?? "")))
        } else { _ = try? list.decode(Empty.self) }
      }
    }
    files = out
  }

  private struct Empty: Decodable {}
}

nonisolated enum Catalog {
  private struct Document: Decodable { let packs: [Pack] }

  static func load() -> [Pack] {
    guard let url = Bundle.main.url(forResource: "catalog", withExtension: "json"),
          let data = try? Data(contentsOf: url),
          let doc = try? JSONDecoder().decode(Document.self, from: data)
    else { return [] }
    return doc.packs
  }
}

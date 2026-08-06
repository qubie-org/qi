// swift-tools-version: 6.2
import PackageDescription

// SwiftPM, not an Xcode project. A .pbxproj is a file no one should be editing
// by hand and every tool corrupts differently; there is nothing here an Xcode
// target would give us that `swift build` plus a hand-assembled bundle does not.
// See native/build.sh for the assembly — SwiftPM produces a bare executable and
// will not write an Info.plist or a bundle layout for you.
let package = Package(
  name: "qi",
  platforms: [.macOS(.v15)],
  dependencies: [
    // Updates. The alternative to a framework here is telling people to
    // download a 140 MB app again by hand every time, which is the same as
    // saying they will not.
    .package(url: "https://github.com/sparkle-project/Sparkle", from: "2.9.0")
  ],
  targets: [
    .executableTarget(
      name: "qi",
      dependencies: [.product(name: "Sparkle", package: "Sparkle")],
      swiftSettings: [
        // SE-0466: everything in this module is @MainActor unless it says
        // otherwise. The whole module is a window and a web view, so the
        // exceptions would outnumber the rule the other way round.
        .defaultIsolation(MainActor.self)
      ]
    )
  ]
)

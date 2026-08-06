import Foundation
import Sparkle

/**
 Updates, over Sparkle.

 The app is 140 MB and the weights are not in it, which is the whole reason this
 is worth having. When the weights lived in the bundle an update was 2.6 GB of
 mostly unchanged model files, and nobody installs that twice; with them in
 Application Support an update is the code, and the code is small enough that
 checking daily and installing quietly is reasonable behaviour rather than an
 imposition.

 ── What signs it ──────────────────────────────────────────────────────────

 An EdDSA keypair. The private half lives in the macOS Keychain of whoever cuts
 releases and, so that it survives that machine, in Cloudflare's Secrets Store —
 never in this repository, and never anywhere a build can read it. The public
 half is in `Info.plist` as `SUPublicEDKey`, which is what makes it safe to
 distribute updates over a URL anyone can serve: Sparkle refuses anything the
 key does not vouch for, so the transport is not the thing being trusted.

 The feed is `appcast.xml` on the latest GitHub release. That means releases and
 the thing describing releases are the same artefact and cannot drift apart —
 there is no separate server to forget to update, and rolling back a release
 rolls back the feed with it.
 */
@MainActor
final class Updates {
  static let shared = Updates()

  /// Sparkle's own controller. Started once, at launch, and left alone.
  private var driver: SPUStandardUpdaterController?

  private init() {}

  /**
   Begin checking.

   `startingUpdater: true` lets Sparkle do its scheduled check on its own
   timetable — `SUScheduledCheckInterval` in the plist, once a day. A first
   check does not happen immediately on first launch, which is deliberate on
   Sparkle's part and correct: someone who has just opened an app for the first
   time is in the middle of a 2.5 GB download and does not need a second one
   proposed to them.
   */
  func begin() {
    guard driver == nil else { return }
    driver = SPUStandardUpdaterController(startingUpdater: true, updaterDelegate: nil, userDriverDelegate: nil)
  }

  /// Ask now, because someone chose to ask. Shows UI either way, including
  /// "you are up to date" — a manual check that silently does nothing is
  /// indistinguishable from a broken one.
  func checkNow() {
    begin()
    driver?.checkForUpdates(nil)
  }

  /// Whether the updater is live, for the menu item's enabled state.
  var ready: Bool { driver?.updater != nil }
}

# Armada native build lane

Build configuration for #689; #690 owns ArmadaKit and its behavior tests, #691
owns `Armada/` including the single SwiftUI `@main` entrypoint and app icon.
There is deliberately no fallback app/package. This lane is not build-ready
until those real sources are integrated. Do not copy the Companion API client.

Reference inspected read-only: The-Vibe-Company/companion-v2 at
`8e01b20970c36efa8779d29a1a2c02f45e20b338`, especially
`apps/ios/AGENTS.md`, `CompanionKit/Package.swift`, native build settings and
`Config/ExportOptions.plist`. Retained patterns: Swift 6, local package,
generic simulator compile and separate Debug/Release identities. Not retained:
API, auth callbacks, extension, assets, signing profiles or App Store record.

## Source contract

- `project.yml` is authoritative; generated `Armada.xcodeproj` is ignored.
  XcodeGen 2.44.1+ deterministically generates ordinary groups and the shared
  **Armada** scheme. Regenerate after adding/removing source files.
- `ArmadaKit/Package.swift` must expose library product `ArmadaKit` and runnable
  macOS Swift package behavior tests. Keep platform-neutral logic in that package.
- `Armada/` owns UI, assets (including an original AppIcon before upload), and
  one app entrypoint. Do not add another entrypoint in project configuration.
- Swift language mode 6, iOS 26+, iPhone/iPad. Release:
  `co.thevibecompany.armada`; Debug: `co.thevibecompany.armada.dev`.
  Both display **Armada**. Team `K28B69CWQ7` is an identifier, not signing material.
- Both configurations expose Info.plist `ARMADA_API_URL`:
  `https://armada.thevibecompany.co`. The app owner must consume this contract;
  no environment-switch UI, Supabase/provider secrets or OAuth callback schemes.
- Native runtime remains OFF until real operator conformance. A successful
  compile is not evidence of working auth, API or native-session continuity.

## Verify on Apple hardware

Xcode with iOS 26 SDK, Swift 6+, and XcodeGen 2.44.1+ are required.
Root has Xcode 27 / Swift 6.4; CI uses the hosted macOS 26 image's selected Xcode
and logs its actual version. Do not claim equivalent toolchains without receipts.

From the repository root:

```sh
apps/ios/scripts/verify.sh
```

This runs native `swift test --package-path apps/ios/ArmadaKit`, generates the
project, and compiles Debug and Release for a generic iOS Simulator without
signing or booting a simulator. The additive Apple Quality workflow does not
replace existing Linux/JS CI. Aim to keep native quality under five minutes;
timeout is ten minutes to allow cold runner setup. No XCUITests or XcodeBuildMCP
dependency in CI. Behavior coverage is owned by #690, not source-grep tests here.

For local interactive build, simulator/device discovery, launch and screenshot
work root uses installed XcodeBuildMCP (inspect its help/session defaults first).
Record the Git SHA, selected Xcode/SDK, simulator/device and source-bound rendered
receipts. Linux cannot validate Apple builds or UI.

## Root-only packaging (Mac; never run from worker/CI)

Prerequisites: real #690/#691 integration; green quality and full CI at the
same SHA; source-bound simulator/device/auth/API validation; original app icon;
privacy/support URLs and beta review contact approved; encryption/export
compliance reviewed (not predeclared here); separate Armada App Store record
registered by root; valid Armada distribution provisioning in Mac Keychain.
Do not reuse any Companion App Store ID or provisioning profile.

Generate with `cd apps/ios && xcodegen generate --spec project.yml`.
Choose a new monotonically increasing build number and reviewed marketing version.
After confirming signing settings on the Mac, root may archive/export:

```sh
# From apps/ios; values supplied by root, not stored credentials.
: "${ARMADA_VERSION:?set reviewed version}"
: "${ARMADA_BUILD_NUMBER:?set unique build number}"
xcodebuild -project Armada.xcodeproj -scheme Armada -configuration Release \
  -destination 'generic/platform=iOS' -archivePath build/Armada.xcarchive \
  MARKETING_VERSION="$ARMADA_VERSION" CURRENT_PROJECT_VERSION="$ARMADA_BUILD_NUMBER" archive
xcodebuild -exportArchive -archivePath build/Armada.xcarchive \
  -exportOptionsPlist Config/ExportOptions.plist -exportPath build/export
```

Export uses `destination=export`: it does **not** upload. No automatic
provisioning/network mutation flags are included. Root resolves any required
signing/profile setup deliberately on the Mac. Inspect exported bundle ID,
version, team, entitlements and production URL before any upload. Generated
projects, archives, IPA, signing keys/profiles and derived output stay ignored.
See `TestFlight/PLAN.md` for discovery and the gated distribution plan.

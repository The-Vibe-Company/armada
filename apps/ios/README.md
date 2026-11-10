# Armada native build lane

Build configuration for #689; #690 owns ArmadaKit and its behavior tests, #691
owns `Armada/` including the single SwiftUI `@main` entrypoint and app icon.
The real app and a source-bound ArmadaKit dependency are integrated; there is
deliberately no fallback app/package. Native quality validates this exact source,
not final product enablement or TestFlight readiness. Do not copy the Companion
API client.

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

## TestFlight from CI

`.github/workflows/testflight.yml` publishes every push to `main` that changes
`apps/ios/**`, and any manual run (Actions → TestFlight → Run workflow). It never
runs on pull requests or forks. It runs `scripts/verify.sh`, generates the project,
archives Release for `generic/platform=iOS`, exports an App Store IPA, uploads it
with `altool`, waits for App Store Connect to process it, sets its What to Test
(en-US) from `TestFlight/what-to-test.txt` and adds it to the TestFlight group
**Armada Internal**. The logic is in `scripts/testflight/` at the repository root.

- **Version.** Marketing version from `project.yml`; build number
  `1000 + run number`, so it never collides with the hand-uploaded builds 1–3.
  Re-running a run reuses its number: start a new run instead after an upload.
- **Export compliance.** `Config/Info.plist` declares
  `ITSAppUsesNonExemptEncryption = false`, so no build waits for an answer. The
  app only uses HTTPS through `URLSession`, the Keychain and a CryptoKit SHA-256
  hash for the login challenge; revisit the key if it ever adds its own encryption.
  The workflow fails if App Store Connect does not record the build as exempt.
- **Signing.** The existing iPhone Distribution certificate (a .p12) is imported
  into a temporary keychain; the **Armada App Store** profile is downloaded by name
  through the App Store Connect API each run. Nothing is created per run, and
  renewing the profile in the portal needs no secret change. Manual style and the
  profile apply to the app target only, through `Config/Signing.xcconfig`, which the
  workflow writes and deletes and git ignores. Automatic or cloud-managed signing
  was not chosen: archiving with it needs a development profile, which failed for
  lack of registered devices.
- **Cleanup.** An `always()` step deletes the keychain, the key and certificate
  files under `$RUNNER_TEMP`, the installed profile and `Signing.xcconfig`.
  The .p12 password reaches `security import -P` on the command line, as in
  GitHub's signing guide (`security` takes it no other way); the hosted runner
  is single-use, and the password is never printed.

### One-time setup (owner)

1. Settings → Environments → **New environment** `testflight`; under Deployment
   branches and tags choose **Selected branches** and add `main` only.
2. App Store Connect → Users and Access → Integrations → App Store Connect API →
   Team Keys: generate a key with the **App Manager** role (it uploads builds,
   edits What to Test, manages groups and reads profiles; use **Admin** if the
   profile download is refused). Download the .p8 once. Add to the environment:
   - `APP_STORE_CONNECT_API_KEY_ID`: the key ID shown next to the key.
   - `APP_STORE_CONNECT_API_ISSUER_ID`: the Issuer ID above the key list.
   - `APP_STORE_CONNECT_API_PRIVATE_KEY`: the full contents of `AuthKey_<id>.p8`,
     header lines included.
3. On the Mac holding the distribution identity: Keychain Access → My Certificates
   → the **iPhone Distribution** certificate used by builds 1–3 → Export as a
   .p12 with a new strong password, then add:
   - `IOS_DISTRIBUTION_CERTIFICATE_P12_BASE64`: `base64 -i Distribution.p12 | pbcopy`
     and paste. Delete the .p12 file afterwards.
   - `IOS_DISTRIBUTION_CERTIFICATE_PASSWORD`: that password.
4. The profile **Armada App Store** must stay active, of type App Store, for
   `co.thevibecompany.armada` with that certificate.

With any secret missing the workflow prints a notice and succeeds without
building. A successful first run shows each step green; the log ends with
`Build 1.0.0 (<1000 + run>) added to "Armada Internal".` (or "already receives
every build" if the group has access to all builds) and the run summary reads
`Armada 1.0.0 (<build>) is on TestFlight in "Armada Internal".` In App Store
Connect → TestFlight the build shows as ready to test with no missing compliance,
the What to Test text and the group, and internal testers get it in TestFlight.

## Manual fallback (owner's Mac)

Builds 1–3 of 1.0.0 were made this way. Use it only when the workflow cannot run.

Prerequisites: real #690/#691 integration; green quality and full CI at the
same SHA; source-bound simulator/device/auth/API validation; original app icon;
privacy/support URLs and beta review contact approved; export compliance
declared by `ITSAppUsesNonExemptEncryption` (see above); Armada App Store record
`6832706228`; valid Armada distribution provisioning in Mac Keychain.
Do not reuse any Companion App Store ID or provisioning profile.

Generate with `cd apps/ios && xcodegen generate --spec project.yml`.
Use the marketing version from `project.yml` and a build number higher than every
build uploaded for it (App Store Connect refuses a lower one). CI numbers are
`1000 + run number`, so a hand-picked number above the next run's makes CI uploads
fail until runs catch up: prefer a manual workflow run whenever it can work.
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
The signed IPA is uploaded with `asc publish testflight` and added to
**Armada Internal**; see `TestFlight/PLAN.md`.

# TestFlight operation plan

App: **Armada**, bundle `co.thevibecompany.armada`, team `K28B69CWQ7`, App Store
Connect app `6832706228`, internal group **Armada Internal**. Builds 1–3 of 1.0.0
were uploaded by hand from the owner's Mac.

## Automatic path (default)

`.github/workflows/testflight.yml` (setup and secrets in `../README.md`, "TestFlight
from CI") publishes each push to `main` that changes `apps/ios/**` and each manual
run, in this order:

1. `scripts/verify.sh` (ArmadaKit tests, simulator compile of both variants).
2. Temporary keychain with the distribution certificate; the **Armada App Store**
   profile downloaded through the App Store Connect API.
3. `xcodegen generate`, Release archive for `generic/platform=iOS` with build
   number `1000 + run number`, App Store IPA export (`destination=export`).
4. `xcrun altool --upload-package` with the API key.
5. Wait (up to an hour) until App Store Connect reports the build `VALID` and
   exempt from export compliance (`ITSAppUsesNonExemptEncryption = false`).
6. What to Test (en-US) from `what-to-test.txt` (at most 4000 characters), then
   the build added to **Armada Internal**, unless that group already has access
   to all builds.
7. Always: keychain, key files, profile and `Config/Signing.xcconfig` deleted.

The workflow adds builds to the internal group only. It never creates app records,
certificates or profiles, never submits for external beta review, never creates
public links and never invites testers.

## Manual fallback (owner's Mac)

When the workflow cannot run (expired certificate or profile, App Store Connect API
outage), archive and export as in `../README.md`, "Manual fallback". Then, after
inspecting the installed CLI's help rather than guessing version-specific flags:

```sh
asc --version
asc publish testflight --help
asc builds list --app 6832706228 --output table
asc testflight groups list --app 6832706228 --output table
```

1. Upload the exported IPA with `asc publish testflight` for app `6832706228`.
2. Wait for processing; check bundle, version and build number. Compliance is
   already declared in the Info.plist; answer it in App Store Connect only if a
   build still asks.
3. Paste `what-to-test.txt` into the build's What to Test (English (U.S.)).
4. Add the build to **Armada Internal**.

External groups, beta app review, public links and tester invitations remain
separate, explicit decisions of the owner, on either path.

CLI syntax reference: https://github.com/rorkai/App-Store-Connect-CLI
Project generation reference: https://github.com/yonaskolb/XcodeGen/blob/master/Docs/ProjectSpec.md

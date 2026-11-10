#!/bin/bash
# Archive, sign, export and upload the iOS app to TestFlight (.github/workflows/testflight.yml).
#
#   scripts/testflight/testflight.sh publish   sign with the distribution certificate, upload, distribute
#   scripts/testflight/testflight.sh cleanup   delete the temporary keychain, profile and files (always run)
#
# Secrets come from the environment and are written only below $RUNNER_TEMP/testflight; never echoed.
set -euo pipefail
set +x

root="$(cd "$(dirname "$0")/../.." && pwd)"
ios="$root/apps/ios"
work="${RUNNER_TEMP:?RUNNER_TEMP is not set}/testflight"
keychain="$work/signing.keychain-db"
signing_xcconfig="$ios/Config/Signing.xcconfig"
profile_dirs=("$HOME/Library/MobileDevice/Provisioning Profiles" "$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles")

APP_ID=6832706228
BUNDLE_ID=co.thevibecompany.armada
TEAM_ID=K28B69CWQ7
PROFILE_NAME="Armada App Store"
GROUP_NAME="Armada Internal"

cleanup() {
  if [[ -f "$keychain" ]]; then security delete-keychain "$keychain" || true; fi
  if [[ -f "$work/profile-uuid" ]]; then
    uuid="$(cat "$work/profile-uuid")"
    for dir in "${profile_dirs[@]}"; do rm -f "$dir/$uuid.mobileprovision"; done
  fi
  rm -f "$signing_xcconfig"
  rm -rf "$work"
}

publish() {
  : "${APP_STORE_CONNECT_API_KEY_ID:?}" "${APP_STORE_CONNECT_API_ISSUER_ID:?}" "${APP_STORE_CONNECT_API_PRIVATE_KEY:?}"
  : "${IOS_DISTRIBUTION_CERTIFICATE_P12_BASE64:?}" "${IOS_DISTRIBUTION_CERTIFICATE_PASSWORD:?}"
  : "${BUILD_NUMBER:?BUILD_NUMBER is not set}"
  # Builds 1-3 were uploaded by hand; CI numbers start at 1000.
  if [[ ! "$BUILD_NUMBER" =~ ^[0-9]+$ ]] || ((BUILD_NUMBER < 1000)); then
    echo "BUILD_NUMBER must be an integer of at least 1000, got '$BUILD_NUMBER'." >&2
    exit 1
  fi

  umask 077
  rm -rf "$work"
  mkdir -p "$work/private_keys"
  # altool looks for AuthKey_<key id>.p8 in API_PRIVATE_KEYS_DIR.
  printf '%s\n' "$APP_STORE_CONNECT_API_PRIVATE_KEY" >"$work/private_keys/AuthKey_$APP_STORE_CONNECT_API_KEY_ID.p8"
  printf '%s' "$IOS_DISTRIBUTION_CERTIFICATE_P12_BASE64" | base64 --decode >"$work/distribution.p12"

  # Temporary keychain holding only the distribution identity, per GitHub's Xcode signing guide.
  keychain_password="$(openssl rand -hex 24)"
  security create-keychain -p "$keychain_password" "$keychain"
  security set-keychain-settings -lut 21600 "$keychain"
  security unlock-keychain -p "$keychain_password" "$keychain"
  security import "$work/distribution.p12" -P "$IOS_DISTRIBUTION_CERTIFICATE_PASSWORD" -A -t cert -f pkcs12 -k "$keychain"
  rm -f "$work/distribution.p12"
  security set-key-partition-list -S apple-tool:,apple: -k "$keychain_password" "$keychain" >/dev/null
  security list-keychains -d user -s "$keychain"
  # The SHA-1 of the single valid signing identity, used for both archive and export.
  identities="$(security find-identity -v -p codesigning "$keychain" | grep -E '^ *[0-9]+\) [0-9A-F]{40} ' | awk '{print $2}' || true)"
  if [[ -z "$identities" || "$identities" == *$'\n'* ]]; then
    echo "The distribution certificate must contain exactly one valid signing identity." >&2
    exit 1
  fi
  identity="$identities"

  # Profile downloaded at run time: renewing it in the portal needs no secret change.
  bun "$root/scripts/testflight/app-store-connect.ts" profile "$PROFILE_NAME" "$work/profile.mobileprovision" >"$work/profile-uuid"
  profile_uuid="$(cat "$work/profile-uuid")"
  for dir in "${profile_dirs[@]}"; do
    mkdir -p "$dir"
    cp "$work/profile.mobileprovision" "$dir/$profile_uuid.mobileprovision"
  done

  # Manual style and profile for the app target only (Release.xcconfig includes this optional file):
  # a command-line profile would also reach the ArmadaKit package, which cannot take one. The identity
  # goes on the command line because XcodeGen's iOS app preset sets it at target level, above any xcconfig.
  cat >"$signing_xcconfig" <<EOF
CODE_SIGN_STYLE = Manual
PROVISIONING_PROFILE_SPECIFIER = $profile_uuid
EOF

  cd "$ios"
  xcodegen generate --spec project.yml
  xcodebuild -project Armada.xcodeproj -scheme Armada -configuration Release \
    -destination 'generic/platform=iOS' -archivePath "$work/Armada.xcarchive" \
    -derivedDataPath "$work/DerivedData" \
    CURRENT_PROJECT_VERSION="$BUILD_NUMBER" CODE_SIGN_IDENTITY="$identity" OTHER_CODE_SIGN_FLAGS="--keychain $keychain" archive

  # The marketing version is the one project.yml compiled into the archive.
  version="$(plutil -extract ApplicationProperties.CFBundleShortVersionString raw -o - "$work/Armada.xcarchive/Info.plist")"
  archived_build="$(plutil -extract ApplicationProperties.CFBundleVersion raw -o - "$work/Armada.xcarchive/Info.plist")"
  if [[ "$archived_build" != "$BUILD_NUMBER" ]]; then
    echo "Archived build number $archived_build is not $BUILD_NUMBER." >&2
    exit 1
  fi

  cat >"$work/ExportOptions.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
    <key>method</key><string>app-store-connect</string>
    <key>destination</key><string>export</string>
    <key>teamID</key><string>$TEAM_ID</string>
    <key>signingStyle</key><string>manual</string>
    <key>signingCertificate</key><string>$identity</string>
    <key>provisioningProfiles</key><dict>
        <key>$BUNDLE_ID</key><string>$profile_uuid</string>
    </dict>
    <key>manageAppVersionAndBuildNumber</key><false/>
    <key>uploadSymbols</key><true/>
</dict></plist>
EOF
  xcodebuild -exportArchive -archivePath "$work/Armada.xcarchive" \
    -exportOptionsPlist "$work/ExportOptions.plist" -exportPath "$work/export"
  ipa="$work/export/Armada.ipa"
  if [[ ! -f "$ipa" ]]; then
    echo "Export produced no $ipa." >&2
    exit 1
  fi

  echo "Uploading Armada $version ($BUILD_NUMBER)."
  API_PRIVATE_KEYS_DIR="$work/private_keys" xcrun altool --upload-package "$ipa" --type ios \
    --apple-id "$APP_ID" --bundle-id "$BUNDLE_ID" \
    --bundle-version "$BUILD_NUMBER" --bundle-short-version-string "$version" \
    --apiKey "$APP_STORE_CONNECT_API_KEY_ID" --apiIssuer "$APP_STORE_CONNECT_API_ISSUER_ID"

  # Fails unless the build appears and processes, so an upload that silently did nothing is caught here.
  bun "$root/scripts/testflight/app-store-connect.ts" distribute \
    "$APP_ID" "$version" "$BUILD_NUMBER" "$GROUP_NAME" "$ios/TestFlight/what-to-test.txt"

  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    echo "Armada $version ($BUILD_NUMBER) is on TestFlight in \"$GROUP_NAME\"." >>"$GITHUB_STEP_SUMMARY"
  fi
}

case "${1:-}" in
  publish) publish ;;
  cleanup) cleanup ;;
  *)
    echo "usage: $0 publish|cleanup" >&2
    exit 2
    ;;
esac

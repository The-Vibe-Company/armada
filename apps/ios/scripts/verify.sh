#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ "$(uname -s)" != Darwin ]]; then
  echo "Native verification requires macOS and Xcode with the iOS 26 SDK." >&2
  exit 1
fi
# Never substitute stubs for the real #690 package or #691 application.
if [[ ! -f ArmadaKit/Package.swift || ! -d Armada ]]; then
  echo "Missing real ArmadaKit package (#690) or Armada application (#691); integrate both before native verification." >&2
  exit 1
fi
xcodebuild -version
swift --version
xcodegen --version
swift test --package-path ArmadaKit
# Exercise the actual Foundation-only app projection under shipping optimization too.
swift test --package-path ArmadaKit --configuration release
xcodegen generate --spec project.yml
for configuration in Debug Release; do
  xcodebuild -project Armada.xcodeproj -scheme Armada \
    -configuration "$configuration" -sdk iphonesimulator \
    -destination 'generic/platform=iOS Simulator' \
    -derivedDataPath build/DerivedData CODE_SIGNING_ALLOWED=NO build
done

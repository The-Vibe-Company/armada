#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ "$(uname -s)" != Darwin ]]; then
  echo "Native verification requires macOS and Xcode with the iOS 26 SDK." >&2
  exit 1
fi
# Never substitute stubs for the real #690 package or #691 application.
test -f ArmadaKit/Package.swift
test -d Armada
xcodebuild -version
swift --version
xcodegen --version
swift test --package-path ArmadaKit
xcodegen generate --spec project.yml
for configuration in Debug Release; do
  xcodebuild -project Armada.xcodeproj -scheme Armada \
    -configuration "$configuration" -sdk iphonesimulator \
    -destination 'generic/platform=iOS Simulator' \
    -derivedDataPath build/DerivedData CODE_SIGNING_ALLOWED=NO build
done

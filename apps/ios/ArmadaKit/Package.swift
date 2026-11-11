// swift-tools-version: 6.0
import PackageDescription
let package = Package(
    name: "ArmadaKit",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [.library(name: "ArmadaKit", targets: ["ArmadaKit"])],
    targets: [.target(name: "ArmadaKit"), .testTarget(name: "ArmadaKitTests", dependencies: ["ArmadaKit"], exclude: ["Fixtures"])]
)

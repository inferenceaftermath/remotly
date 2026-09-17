// swift-tools-version: 6.0
// FlowKit: protocol codecs, terminal grid, pairing, connection, keychain and push helpers for the
// Remotly iOS app. No third-party dependencies. Tested with `swift test` on macOS or via the
// FlowKitTests scheme of the generated Xcode project.
import PackageDescription

let package = Package(
    name: "FlowKit",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "FlowKit", targets: ["FlowKit"]),
    ],
    targets: [
        .target(
            name: "FlowKit",
            path: "Sources/FlowKit"
        ),
        .testTarget(
            name: "FlowKitTests",
            dependencies: ["FlowKit"],
            path: "Tests/FlowKitTests"
        ),
    ],
    swiftLanguageModes: [.v6]
)

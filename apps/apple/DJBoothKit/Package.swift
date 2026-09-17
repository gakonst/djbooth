// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "DJBoothKit",
    platforms: [.macOS(.v14), .iOS(.v17)],
    products: [.library(name: "DJBoothKit", targets: ["DJBoothKit"])],
    targets: [
        .target(name: "DJBoothKit", resources: [.copy("Resources/phone-tools.json"), .copy("Resources/app-mcp.json")]),
        .testTarget(name: "DJBoothKitTests", dependencies: ["DJBoothKit"], resources: [.copy("Fixtures")])
    ]
)

// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "NanocodexUI",
    platforms: [.macOS(.v14), .iOS(.v17)],
    products: [.library(name: "NanocodexUI", targets: ["NanocodexUI"])],
    dependencies: [
        .package(url: "https://github.com/appstefan/HighlightSwift.git", from: "1.1.0"),
        .package(url: "https://github.com/kean/Nuke.git", exact: "13.2.0"),
        .package(url: "https://github.com/gonzalezreal/swift-markdown-ui.git", exact: "2.4.1"),
    ],
    targets: [
        .target(name: "NanocodexUI", dependencies: ["HighlightSwift", .product(name: "Nuke", package: "Nuke"), .product(name: "MarkdownUI", package: "swift-markdown-ui", condition: .when(platforms: [.iOS]))]),
        .testTarget(name: "NanocodexUITests", dependencies: ["NanocodexUI", .product(name: "MarkdownUI", package: "swift-markdown-ui", condition: .when(platforms: [.iOS]))]),
    ]
)

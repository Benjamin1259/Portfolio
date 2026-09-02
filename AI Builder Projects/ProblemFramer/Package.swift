// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "ProblemFramer",
    platforms: [
        .macOS(.v14)
    ],
    targets: [
        .executableTarget(
            name: "ProblemFramer",
            path: "Sources/ProblemFramer",
            linkerSettings: [
                .linkedFramework("Speech"),
                .linkedFramework("AVFoundation")
            ]
        )
    ]
)

import Foundation

/// Stores the Gemini API key as a plain local file instead of the macOS
/// Keychain. Keychain access requires OS-level permission prompts tied to
/// the app's code signature, which kept reappearing even with a stable
/// signing identity — this trades that OS-level protection away for a key
/// that just works, readable only by processes running as this Mac user.
enum ApiKeyStore {
    private static let fileManager = FileManager.default

    private static var fileURL: URL {
        let base = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let dir = base.appendingPathComponent("ProblemFramer", isDirectory: true)
        try? fileManager.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("gemini_api_key.txt")
    }

    static func save(apiKey: String) {
        try? apiKey.write(to: fileURL, atomically: true, encoding: .utf8)
    }

    static func loadAPIKey() -> String? {
        try? String(contentsOf: fileURL, encoding: .utf8)
    }

    static func clear() {
        try? fileManager.removeItem(at: fileURL)
    }
}

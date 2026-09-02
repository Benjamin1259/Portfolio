import Foundation

/// Persists ProblemFrame documents as individual JSON files under
/// ~/Library/Application Support/ProblemFramer/
@MainActor
final class ProblemFrameStore: ObservableObject {
    @Published var frames: [ProblemFrame] = []

    private let fileManager = FileManager.default
    private lazy var storageDirectory: URL = {
        let base = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        let dir = base.appendingPathComponent("ProblemFramer", isDirectory: true)
        try? fileManager.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }()

    init() {
        load()
    }

    private func fileURL(for frame: ProblemFrame) -> URL {
        storageDirectory.appendingPathComponent("\(frame.id.uuidString).json")
    }

    func load() {
        guard let files = try? fileManager.contentsOfDirectory(at: storageDirectory, includingPropertiesForKeys: nil) else {
            frames = []
            return
        }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let loaded = files
            .filter { $0.pathExtension == "json" }
            .compactMap { url -> ProblemFrame? in
                guard let data = try? Data(contentsOf: url) else { return nil }
                return try? decoder.decode(ProblemFrame.self, from: data)
            }
        frames = loaded.sorted { $0.updatedAt > $1.updatedAt }
    }

    func save(_ frame: ProblemFrame) {
        var updated = frame
        updated.updatedAt = Date()

        if let index = frames.firstIndex(where: { $0.id == frame.id }) {
            frames[index] = updated
        } else {
            frames.insert(updated, at: 0)
        }

        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = .prettyPrinted
        if let data = try? encoder.encode(updated) {
            try? data.write(to: fileURL(for: updated))
        }
    }

    func delete(_ frame: ProblemFrame) {
        frames.removeAll { $0.id == frame.id }
        try? fileManager.removeItem(at: fileURL(for: frame))
    }
}

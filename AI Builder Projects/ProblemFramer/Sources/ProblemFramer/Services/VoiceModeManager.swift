import Foundation
import AVFoundation

/// Global toggle for hands-free operation: when enabled, the app speaks
/// prompts/replies aloud and text fields auto-listen for dictation on focus.
@MainActor
final class VoiceModeManager: NSObject, ObservableObject {
    @Published var isEnabled = false {
        didSet {
            if !isEnabled { stopSpeaking() }
        }
    }
    @Published private(set) var isSpeaking = false

    private let synthesizer = AVSpeechSynthesizer()
    private var pendingCompletions: [() -> Void] = []

    override init() {
        super.init()
        synthesizer.delegate = self
    }

    /// Speaks the given text aloud (no-op if voice mode is off). `completion`
    /// fires once speech finishes, so callers can wait before starting to
    /// listen — otherwise the mic would pick up the app's own voice, and
    /// racing AVAudioEngine (recording) against AVSpeechSynthesizer
    /// (playback) at the same instant is what crashed the app.
    func speak(_ text: String, completion: (() -> Void)? = nil) {
        guard isEnabled, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            completion?()
            return
        }
        if let completion { pendingCompletions.append(completion) }
        isSpeaking = true
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = AVSpeechSynthesisVoice(language: "en-US")
        synthesizer.speak(utterance)
    }

    /// Runs `action` once any in-progress speech (from anywhere in the app)
    /// finishes, or immediately if nothing is speaking right now.
    func runAfterSpeaking(_ action: @escaping () -> Void) {
        if isSpeaking {
            pendingCompletions.append(action)
        } else {
            action()
        }
    }

    func stopSpeaking() {
        synthesizer.stopSpeaking(at: .immediate)
        isSpeaking = false
        pendingCompletions.removeAll()
    }

    private func finishSpeaking() {
        isSpeaking = false
        let completions = pendingCompletions
        pendingCompletions.removeAll()
        completions.forEach { $0() }
    }
}

extension VoiceModeManager: AVSpeechSynthesizerDelegate {
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        Task { @MainActor in finishSpeaking() }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        Task { @MainActor in finishSpeaking() }
    }
}

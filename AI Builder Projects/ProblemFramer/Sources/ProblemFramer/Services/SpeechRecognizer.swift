import Foundation
import Speech
import AVFoundation

/// Wraps Apple's on-device Speech framework for live dictation.
@MainActor
final class SpeechRecognizer: NSObject, ObservableObject {
    @Published var isRecording = false
    @Published var transcript = ""
    @Published var errorMessage: String?

    private let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
    private let audioEngine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?

    func start() {
        guard !isRecording else { return }
        errorMessage = nil
        requestPermissions { [weak self] granted in
            guard let self else { return }
            if granted {
                self.beginRecording(attempt: 0)
            } else {
                self.errorMessage = "Microphone or speech recognition access was denied. Enable it in System Settings > Privacy & Security."
            }
        }
    }

    func stop() {
        guard isRecording else { return }
        audioEngine.stop()
        audioEngine.inputNode.removeTap(onBus: 0)
        request?.endAudio()
        task?.cancel()
        task = nil
        request = nil
        isRecording = false
    }

    private func requestPermissions(completion: @escaping (Bool) -> Void) {
        SFSpeechRecognizer.requestAuthorization { authStatus in
            guard authStatus == .authorized else {
                DispatchQueue.main.async { completion(false) }
                return
            }
            AVCaptureDevice.requestAccess(for: .audio) { granted in
                DispatchQueue.main.async { completion(granted) }
            }
        }
    }

    /// CoreAudio can report an invalid (zero sample rate / zero channel) format
    /// for a brief moment right after mic permission is granted, before the
    /// input route has finished settling. Calling installTap with that format
    /// raises an Objective-C exception that Swift cannot catch and crashes the
    /// process outright — so we validate the format first and retry briefly
    /// instead of ever passing a bad format to AVAudioEngine.
    private static let maxFormatRetries = 5

    private func beginRecording(attempt: Int) {
        guard !isRecording else { return }
        guard let recognizer, recognizer.isAvailable else {
            errorMessage = "Speech recognizer is unavailable right now."
            return
        }

        let inputNode = audioEngine.inputNode
        let recordingFormat = inputNode.outputFormat(forBus: 0)

        guard recordingFormat.sampleRate > 0, recordingFormat.channelCount > 0 else {
            if attempt < Self.maxFormatRetries {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { [weak self] in
                    self?.beginRecording(attempt: attempt + 1)
                }
            } else {
                errorMessage = "Microphone isn't ready yet. Try again in a moment."
            }
            return
        }

        let recognitionRequest = SFSpeechAudioBufferRecognitionRequest()
        recognitionRequest.shouldReportPartialResults = true
        request = recognitionRequest
        transcript = ""

        inputNode.removeTap(onBus: 0)
        inputNode.installTap(onBus: 0, bufferSize: 1024, format: recordingFormat) { buffer, _ in
            recognitionRequest.append(buffer)
        }

        audioEngine.prepare()
        do {
            try audioEngine.start()
        } catch {
            inputNode.removeTap(onBus: 0)
            errorMessage = "Couldn't start audio engine: \(error.localizedDescription)"
            return
        }

        isRecording = true

        task = recognizer.recognitionTask(with: recognitionRequest) { [weak self] result, error in
            guard let self else { return }
            Task { @MainActor in
                if let result {
                    self.transcript = result.bestTranscription.formattedString
                }
                if error != nil || (result?.isFinal ?? false) {
                    self.stop()
                }
            }
        }
    }
}

import SwiftUI

/// A single-line (auto-growing) text field with an integrated mic. In Voice
/// Mode, focusing the field starts listening automatically (waiting for any
/// in-progress speech to finish first); the mic icon also works as a manual
/// toggle regardless of Voice Mode.
struct VoiceTextField: View {
    @Binding var text: String
    var placeholder: String
    var onSubmit: (() -> Void)? = nil

    @EnvironmentObject private var voiceMode: VoiceModeManager
    @StateObject private var recognizer = SpeechRecognizer()
    @FocusState private var isFocused: Bool
    @State private var baseText: String = ""
    @State private var showError = false

    var body: some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField(placeholder, text: $text, axis: .vertical)
                .textFieldStyle(.plain)
                .lineLimit(1...6)
                .focused($isFocused)
                .onSubmit { onSubmit?() }

            MicIndicator(isRecording: recognizer.isRecording, action: toggleManually)
        }
        .onChange(of: isFocused) { _, focused in handleFocusChange(focused) }
        .onChange(of: recognizer.transcript) { _, newValue in
            text = baseText.isEmpty ? newValue : "\(baseText) \(newValue)"
        }
        .onChange(of: recognizer.errorMessage) { _, newValue in showError = newValue != nil }
        .alert("Dictation Error", isPresented: $showError) {
            Button("OK") { recognizer.errorMessage = nil }
        } message: {
            Text(recognizer.errorMessage ?? "")
        }
    }

    private func handleFocusChange(_ focused: Bool) {
        guard voiceMode.isEnabled else { return }
        if focused {
            voiceMode.runAfterSpeaking { startListening() }
        } else {
            recognizer.stop()
        }
    }

    private func toggleManually() {
        if recognizer.isRecording {
            recognizer.stop()
        } else {
            voiceMode.runAfterSpeaking { startListening() }
        }
    }

    private func startListening() {
        baseText = text.trimmingCharacters(in: .whitespacesAndNewlines)
        recognizer.start()
    }
}

struct MicIndicator: View {
    let isRecording: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: isRecording ? "mic.fill" : "mic")
                .font(.system(size: 16))
                .foregroundStyle(isRecording ? .red : .secondary)
        }
        .buttonStyle(.plain)
        .help(isRecording ? "Stop dictation" : "Dictate")
    }
}

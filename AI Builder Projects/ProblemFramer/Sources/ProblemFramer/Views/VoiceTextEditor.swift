import SwiftUI

/// Multi-line counterpart to VoiceTextField, used for the guided form's
/// longer answers. Same auto-listen-on-focus behavior in Voice Mode.
struct VoiceTextEditor: View {
    @Binding var text: String
    var spokenPrompt: String? = nil

    @EnvironmentObject private var voiceMode: VoiceModeManager
    @StateObject private var recognizer = SpeechRecognizer()
    @FocusState private var isFocused: Bool
    @State private var baseText: String = ""
    @State private var showError = false

    var body: some View {
        VStack(alignment: .trailing, spacing: 4) {
            TextEditor(text: $text)
                .font(.body)
                .frame(minHeight: 80)
                .padding(6)
                .background(RoundedRectangle(cornerRadius: 6).fill(Color(nsColor: .textBackgroundColor)))
                .overlay(RoundedRectangle(cornerRadius: 6).stroke(Color.gray.opacity(0.25)))
                .focused($isFocused)

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
            if let spokenPrompt {
                voiceMode.speak(spokenPrompt) { startListening() }
            } else {
                voiceMode.runAfterSpeaking { startListening() }
            }
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

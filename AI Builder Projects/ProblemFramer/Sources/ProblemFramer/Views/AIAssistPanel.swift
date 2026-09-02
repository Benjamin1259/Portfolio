import SwiftUI

struct AIAssistPanel: View {
    @Binding var frame: ProblemFrame
    var onRevise: ([String]) -> Void

    @EnvironmentObject private var voiceMode: VoiceModeManager
    @State private var draftMessage: String = ""
    @State private var isLoading = false
    @State private var errorMessage: String?

    private let service = GeminiService()

    private var modelMessages: [ChatMessage] {
        frame.chatHistory.filter { $0.role == .model }
    }

    var body: some View {
        VStack(spacing: 0) {
            header

            Divider()

            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        if modelMessages.isEmpty {
                            Text("Ask the assistant to review your draft, or tap \"Review My Draft\" above to get started.")
                                .font(.callout)
                                .foregroundStyle(.secondary)
                                .padding(.top, 12)
                        }
                        if let score = frame.lastQualityScore {
                            VStack(spacing: 4) {
                                Text("Problem Statement Strength")
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(.secondary)
                                QualityGauge(score: score)
                                    .scaleEffect(0.7)
                                    .frame(height: 110)
                            }
                            .frame(maxWidth: .infinity)
                            .padding(.bottom, 4)
                        }
                        ForEach(modelMessages) { message in
                            let isLatest = message.id == modelMessages.last?.id
                            ChatBubble(
                                message: message,
                                score: isLatest ? frame.lastQualityScore : nil,
                                problemKeys: isLatest ? WizardStepOrder.problemKeys(in: frame.sectionFeedback) : [],
                                onRevise: onRevise
                            )
                            .id(message.id)
                        }
                        if isLoading {
                            HStack {
                                ProgressView()
                                    .controlSize(.small)
                                Text("Thinking…")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        if let errorMessage {
                            Text(errorMessage)
                                .font(.caption)
                                .foregroundStyle(.red)
                        }
                    }
                    .padding(12)
                }
                .onChange(of: frame.chatHistory) { _, newValue in
                    if let last = newValue.last {
                        withAnimation {
                            proxy.scrollTo(last.id, anchor: .bottom)
                        }
                    }
                }
            }

            Divider()

            inputBar
        }
        .background(Color(nsColor: .windowBackgroundColor))
    }

    private var header: some View {
        HStack {
            Text("AI Assist")
                .font(.headline)
            Spacer()
            Button("Review My Draft") { reviewDraft() }
                .disabled(isLoading)
        }
        .padding(12)
    }

    private var inputBar: some View {
        HStack(alignment: .bottom, spacing: 8) {
            VoiceTextField(
                text: $draftMessage,
                placeholder: "Ask a question…",
                onSubmit: sendDraft
            )
            .padding(6)
            .overlay(RoundedRectangle(cornerRadius: 6).stroke(Color.gray.opacity(0.3)))

            Button {
                sendDraft()
            } label: {
                Image(systemName: "arrow.up.circle.fill")
                    .font(.title2)
            }
            .disabled(draftMessage.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isLoading)
        }
        .padding(12)
    }

    private func sendDraft() {
        let trimmed = draftMessage.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        draftMessage = ""
        send(text: trimmed)
    }

    private func send(text: String) {
        errorMessage = nil
        frame.chatHistory.append(ChatMessage(role: .user, text: text))
        isLoading = true

        Task {
            do {
                let reply = try await service.send(history: frame.chatHistory, frame: frame)
                frame.chatHistory.append(ChatMessage(role: .model, text: reply))
                voiceMode.speak(reply)
            } catch {
                errorMessage = error.localizedDescription
            }
            isLoading = false
        }
    }

    private func reviewDraft() {
        errorMessage = nil
        let prompt = """
        Please review my current draft above. Where is it vague, unsupported, or missing evidence? What clarifying questions should I answer so this problem statement can serve as a clear foundation for whatever work follows? \
        End your response with a line starting exactly with "Recommended Next Step:" followed by the single most important thing I should do next.
        """
        frame.chatHistory.append(ChatMessage(role: .user, text: prompt))
        isLoading = true

        Task {
            do {
                async let feedbackTask = service.send(history: frame.chatHistory, frame: frame)
                async let scoreTask = service.scoreClarity(frame: frame)
                async let sectionTask = service.sectionFeedback(frame: frame)
                let (reply, score, sections) = try await (feedbackTask, scoreTask, sectionTask)
                frame.chatHistory.append(ChatMessage(role: .model, text: reply))
                frame.lastQualityScore = score
                frame.sectionFeedback = sections
                voiceMode.speak("This scores \(score) out of 100. \(reply)")
            } catch {
                errorMessage = error.localizedDescription
            }
            isLoading = false
        }
    }

}

private struct ChatBubble: View {
    let message: ChatMessage
    /// Only set for the message from the most recent "Review My Draft" —
    /// drives the readiness graphic and headline treatment.
    let score: Int?
    /// Every wizard step (in order) with unresolved feedback.
    let problemKeys: [String]
    let onRevise: ([String]) -> Void

    private var isNotReady: Bool {
        guard let score else { return false }
        return score < GeminiService.notReadyThreshold
    }

    private var headline: String {
        Self.splitHeadline(message.text).headline
    }

    private var nextStep: String? {
        Self.splitNextStep(Self.splitHeadline(message.text).body).nextStep
    }

    private var body_: String {
        Self.splitNextStep(Self.splitHeadline(message.text).body).remainder
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 10) {
                if score != nil {
                    Image(systemName: isNotReady ? "exclamationmark.octagon.fill" : "checkmark.seal.fill")
                        .font(.title)
                        .foregroundStyle(isNotReady ? .red : .green)
                } else {
                    Image(systemName: "sparkles")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .padding(.top, 4)
                }

                Text(MarkdownBlocksView.inline(headline))
                    .font(.title3.weight(.semibold))
                    .fixedSize(horizontal: false, vertical: true)
            }

            if let nextStep {
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: "arrow.turn.up.right")
                        .foregroundStyle(.blue)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Recommended Next Step")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                        Text(MarkdownBlocksView.inline(nextStep))
                            .font(.callout.weight(.medium))
                    }
                }
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 10).fill(Color.blue.opacity(0.08)))
            }

            if isNotReady, !problemKeys.isEmpty {
                Button {
                    onRevise(problemKeys)
                } label: {
                    Label("Revise Flagged Sections", systemImage: "arrow.uturn.backward.circle.fill")
                }
                .buttonStyle(.borderedProminent)
                .tint(.red)
            }

            if !body_.isEmpty {
                MarkdownBlocksView(text: body_)
            }
        }
        .textSelection(.enabled)
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 12).fill(Color(nsColor: .textBackgroundColor)))
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .stroke(isNotReady ? Color.red.opacity(0.4) : Color.gray.opacity(0.2), lineWidth: 1)
        )
    }

    /// The first paragraph reads as the verdict ("This draft is currently a
    /// data investigation request, not an engineering problem frame...");
    /// everything after the first blank line is supporting detail.
    private static func splitHeadline(_ text: String) -> (headline: String, body: String) {
        guard let range = text.range(of: "\n\n") else {
            return (text.trimmingCharacters(in: .whitespacesAndNewlines), "")
        }
        let headline = String(text[..<range.lowerBound]).trimmingCharacters(in: .whitespacesAndNewlines)
        let body = String(text[range.upperBound...]).trimmingCharacters(in: .whitespacesAndNewlines)
        return (headline, body)
    }

    /// Pulls out a "Recommended Next Step:" section (heading or inline
    /// label) wherever it appears, so it can be shown right under the
    /// verdict instead of buried at the end of the detailed feedback.
    private static func splitNextStep(_ text: String) -> (nextStep: String?, remainder: String) {
        let lines = text.components(separatedBy: "\n")

        guard let startIndex = lines.firstIndex(where: { isNextStepLabel($0) }) else {
            return (nil, text)
        }

        var firstLine = lines[startIndex].trimmingCharacters(in: .whitespaces)
        firstLine = String(firstLine.drop(while: { $0 == "#" })).trimmingCharacters(in: .whitespaces)
        if let colonRange = firstLine.range(of: ":") {
            firstLine = String(firstLine[colonRange.upperBound...]).trimmingCharacters(in: .whitespaces)
        } else {
            firstLine = ""
        }

        var stepLines: [String] = firstLine.isEmpty ? [] : [firstLine]
        var endIndex = startIndex + 1
        while endIndex < lines.count {
            let trimmed = lines[endIndex].trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("#") { break }
            stepLines.append(lines[endIndex])
            endIndex += 1
        }

        let nextStepText = stepLines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)

        var remainderLines = lines
        remainderLines.removeSubrange(startIndex..<endIndex)
        let remainder = remainderLines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)

        return (nextStepText.isEmpty ? nil : nextStepText, remainder)
    }

    private static func isNextStepLabel(_ line: String) -> Bool {
        let stripped = line.trimmingCharacters(in: .whitespaces)
            .trimmingCharacters(in: CharacterSet(charactersIn: "#"))
            .trimmingCharacters(in: .whitespaces)
        return stripped.lowercased().hasPrefix("recommended next step")
    }
}

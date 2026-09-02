import SwiftUI

/// Shown right after the wizard finishes: sends everything the PM entered to
/// Gemini to synthesize a clean problem statement, score its clarity, and
/// critique the framing, before landing on the full document.
struct ProblemFrameReviewView: View {
    @EnvironmentObject private var store: ProblemFrameStore
    @EnvironmentObject private var voiceMode: VoiceModeManager
    let frameID: UUID
    var onRevise: (UUID, [String]) -> Void
    var onContinue: () -> Void

    @State private var frame = ProblemFrame()
    @State private var generatedStatement = ""
    @State private var feedback = ""
    @State private var qualityScore = 0
    @State private var isLoading = false
    @State private var errorMessage: String?

    private var problemKeys: [String] { WizardStepOrder.problemKeys(in: frame.sectionFeedback) }

    private let service = GeminiService()

    var body: some View {
        ScrollView {
            VStack(spacing: 32) {
                VStack(spacing: 4) {
                    Text("Sharpening the Frame")
                        .font(.largeTitle.weight(.semibold))
                    Text("Gemini's take on what you've written so far.")
                        .font(.title3)
                        .foregroundStyle(.secondary)
                }

                if isLoading {
                    VStack(spacing: 10) {
                        ProgressView().controlSize(.large)
                        Text("Reviewing your problem frame…")
                            .foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 40)
                } else if let errorMessage {
                    VStack(spacing: 12) {
                        Text(errorMessage)
                            .foregroundStyle(.red)
                            .multilineTextAlignment(.center)
                        Button("Try Again") { Task { await generate() } }
                            .buttonStyle(.borderedProminent)
                    }
                    .padding(.vertical, 40)
                } else {
                    QualityGauge(score: qualityScore)

                    resultCard(
                        title: "Suggested Problem Statement",
                        icon: "text.quote",
                        accentColor: .blue,
                        content: generatedStatement
                    ) {
                        Button("Use This Statement") {
                            frame.problemStatement = generatedStatement
                            store.save(frame)
                        }
                        .disabled(generatedStatement.isEmpty)
                    }

                    resultCard(
                        title: "Feedback on Clarity",
                        icon: "text.magnifyingglass",
                        accentColor: .purple,
                        content: feedback
                    ) {
                        if qualityScore < GeminiService.notReadyThreshold, !problemKeys.isEmpty {
                            Button {
                                onRevise(frameID, problemKeys)
                            } label: {
                                Label("Revise Flagged Sections", systemImage: "arrow.uturn.backward.circle.fill")
                            }
                            .buttonStyle(.borderedProminent)
                            .tint(.red)
                        }
                    }
                }

                HStack {
                    Button("Regenerate") { Task { await generate() } }
                        .disabled(isLoading)

                    Spacer()

                    Button("Continue") { onContinue() }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.large)
                }
                .frame(maxWidth: 700)
            }
            .padding(40)
            .frame(maxWidth: 700)
            .frame(maxWidth: .infinity)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .onAppear {
            loadFrame()
            Task { await generate() }
        }
    }

    @ViewBuilder
    private func resultCard<Accessory: View>(
        title: String,
        icon: String,
        accentColor: Color,
        content: String,
        @ViewBuilder accessory: () -> Accessory
    ) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: icon)
                    .foregroundStyle(accentColor)
                Text(title)
                    .font(.headline)
            }
            .padding(.bottom, 12)

            MarkdownBlocksView(text: content)
                .textSelection(.enabled)

            accessory()
                .padding(.top, 14)
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 14).fill(Color(nsColor: .textBackgroundColor)))
        .overlay(
            RoundedRectangle(cornerRadius: 14)
                .stroke(accentColor.opacity(0.25), lineWidth: 1)
        )
        .overlay(alignment: .leading) {
            RoundedRectangle(cornerRadius: 2)
                .fill(accentColor)
                .frame(width: 4)
                .padding(.vertical, 10)
        }
    }

    private func loadFrame() {
        if let existing = store.frames.first(where: { $0.id == frameID }) {
            frame = existing
        }
    }

    private func generate() async {
        isLoading = true
        errorMessage = nil

        do {
            async let statementTask = service.send(
                history: [ChatMessage(role: .user, text: Self.statementPrompt)],
                frame: frame
            )
            async let feedbackTask = service.send(
                history: [ChatMessage(role: .user, text: Self.feedbackPrompt)],
                frame: frame
            )
            async let scoreTask = service.scoreClarity(frame: frame)
            async let sectionTask = service.sectionFeedback(frame: frame)
            let (statement, critique, score, sections) = try await (statementTask, feedbackTask, scoreTask, sectionTask)
            generatedStatement = statement.trimmingCharacters(in: .whitespacesAndNewlines)
            feedback = critique.trimmingCharacters(in: .whitespacesAndNewlines)
            qualityScore = score
            frame.lastQualityScore = score
            frame.sectionFeedback = sections
            store.save(frame)
            voiceMode.speak("This scores \(qualityScore) out of 100. Here's the suggested problem statement: \(generatedStatement)")
        } catch {
            errorMessage = error.localizedDescription
        }

        isLoading = false
    }

    private static let statementPrompt = """
    Based on everything above, write a single clear, well-formed problem \
    statement — 2 to 4 sentences — that could serve as the foundation any \
    downstream work flows from, whether that's design, engineering, or \
    prioritization. State only the problem, never a solution or a feature \
    request. Return just the statement itself: no headers, no preamble, no \
    quotation marks.
    """

    private static let feedbackPrompt = """
    Review everything above for clarity, as the foundation all downstream \
    work will build from. Point out: where the framing is vague or \
    unsupported, what's missing for someone to fully understand the \
    problem, and concrete suggestions to sharpen it. Be direct and \
    specific. Use short paragraphs or bullet points — no headers, no \
    preamble.
    """
}

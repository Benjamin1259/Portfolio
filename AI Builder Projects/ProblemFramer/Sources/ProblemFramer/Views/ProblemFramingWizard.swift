import SwiftUI

/// Walks the user through the problem frame one question at a time, instead
/// of showing all the sections at once. Lands on the full document view
/// (with AI Assist) once every step is done.
struct ProblemFramingWizard: View {
    @EnvironmentObject private var store: ProblemFrameStore
    @EnvironmentObject private var voiceMode: VoiceModeManager
    let frameID: UUID
    /// When set, only these sections are shown (in this order) instead of
    /// the full 6-step wizard — used when revising just the flagged sections.
    var restrictToKeys: [String]? = nil
    var onBack: () -> Void
    var onFinish: () -> Void

    @State private var frame = ProblemFrame()
    @State private var stepIndex = 0

    private var steps: [FramingStep] {
        guard let restrictToKeys, !restrictToKeys.isEmpty else { return framingSteps }
        return restrictToKeys.compactMap { key in framingSteps.first { $0.key == key } }
    }

    private var currentStep: FramingStep { steps[stepIndex] }
    private var isLastStep: Bool { stepIndex == steps.count - 1 }
    private var currentText: String { frame[keyPath: currentStep.keyPath] }
    private var currentCritique: String? { frame.sectionFeedback[currentStep.key] }

    var body: some View {
        VStack(spacing: 20) {
            Spacer()

            Text("Step \(stepIndex + 1) of \(steps.count)")
                .font(.caption)
                .foregroundStyle(.secondary)

            Text(currentStep.title)
                .font(.largeTitle.weight(.semibold))
                .multilineTextAlignment(.center)

            Text(currentStep.prompt)
                .font(.title3)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 560)

            VoiceTextEditor(text: $frame[dynamicMember: currentStep.keyPath])
                .id(stepIndex)
                .frame(maxWidth: 560, minHeight: 220, maxHeight: 220)

            if let currentCritique {
                HStack(alignment: .top, spacing: 6) {
                    Image(systemName: "exclamationmark.triangle.fill")
                    Text(currentCritique)
                }
                .font(.callout)
                .foregroundStyle(.red)
                .frame(maxWidth: 560, alignment: .leading)
            }

            TagPicker(
                selectedTags: $frame[dynamicMember: currentStep.tagsKeyPath],
                tags: currentStep.tagCatalog
            )
            .frame(maxWidth: 560, alignment: .leading)

            HStack {
                Button("Back") { goBack() }

                Spacer()

                Button("Skip") { advance() }
                    .buttonStyle(.plain)
                    .foregroundStyle(.secondary)

                Button(isLastStep ? "Finish" : "Next") { advance() }
                    .buttonStyle(.borderedProminent)
                    .disabled(currentText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            .frame(maxWidth: 560)

            Spacer()
            Spacer()
        }
        .padding(40)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .onAppear {
            loadFrame()
            speakCurrentPrompt()
        }
        .onChange(of: stepIndex) { _, _ in speakCurrentPrompt() }
        .onChange(of: frame) { _, newValue in store.save(newValue) }
    }

    private func loadFrame() {
        if let existing = store.frames.first(where: { $0.id == frameID }) {
            frame = existing
        }
        stepIndex = 0
    }

    private func speakCurrentPrompt() {
        voiceMode.speak(currentStep.prompt)
    }

    private func goBack() {
        voiceMode.stopSpeaking()
        if stepIndex > 0 {
            stepIndex -= 1
        } else {
            onBack()
        }
    }

    private func advance() {
        voiceMode.stopSpeaking()
        if isLastStep {
            onFinish()
        } else {
            stepIndex += 1
        }
    }
}

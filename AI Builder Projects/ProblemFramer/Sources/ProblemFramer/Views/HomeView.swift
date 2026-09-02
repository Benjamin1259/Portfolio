import SwiftUI

struct HomeView: View {
    var onSubmit: (String, [String]) -> Void

    @EnvironmentObject private var voiceMode: VoiceModeManager
    @State private var input: String = ""
    @State private var selectedTags: [String] = []

    private var greetingName: String {
        let fullName = NSFullUserName()
        return fullName.split(separator: " ").first.map(String.init) ?? fullName
    }

    private var timeOfDayGreeting: String {
        let hour = Calendar.current.component(.hour, from: Date())
        switch hour {
        case 0..<12: return "Good morning"
        case 12..<17: return "Good afternoon"
        default: return "Good evening"
        }
    }

    var body: some View {
        VStack(spacing: 24) {
            Spacer()

            VStack(spacing: 8) {
                Text("\(timeOfDayGreeting), \(greetingName).")
                    .font(.largeTitle.weight(.semibold))
                Text("What do you want to build today?")
                    .font(.title2)
                    .foregroundStyle(.secondary)
            }

            HStack(alignment: .bottom, spacing: 8) {
                VoiceTextField(
                    text: $input,
                    placeholder: "Describe the problem you're trying to solve…",
                    onSubmit: submit
                )
                .font(.body)
                .padding(12)
                .background(RoundedRectangle(cornerRadius: 10).fill(Color(nsColor: .textBackgroundColor)))
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color.gray.opacity(0.3)))

                Button(action: submit) {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.system(size: 28))
                }
                .buttonStyle(.plain)
                .disabled(input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            .frame(maxWidth: 560)

            VStack(alignment: .leading, spacing: 6) {
                Text("Tag this problem (optional)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                TagPicker(selectedTags: $selectedTags, tags: ProblemTagCatalog.problemType)
            }
            .frame(maxWidth: 560, alignment: .leading)

            Spacer()
            Spacer()
        }
        .padding(40)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .onAppear { speakGreetingIfEnabled() }
        .onChange(of: voiceMode.isEnabled) { _, enabled in
            if enabled { speakGreetingIfEnabled() }
        }
    }

    private func speakGreetingIfEnabled() {
        voiceMode.speak("\(timeOfDayGreeting), \(greetingName). What do you want to build today?")
    }

    private func submit() {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        onSubmit(trimmed, selectedTags)
        input = ""
        selectedTags = []
    }
}

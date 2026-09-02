import SwiftUI
import AppKit

struct ProblemFrameDetailView: View {
    @EnvironmentObject private var store: ProblemFrameStore
    let frameID: UUID
    var onRevise: (UUID, [String]) -> Void

    @State private var frame = ProblemFrame()

    var body: some View {
        HSplitView {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    TextField("Problem title", text: $frame.title)
                        .font(.title2.bold())
                        .textFieldStyle(.plain)

                    TagPicker(selectedTags: $frame.tags, tags: ProblemTagCatalog.problemType)

                    FramingSection(
                        title: "Problem Statement",
                        prompt: "What, precisely, is broken or missing? State it as a problem, not a solution.",
                        text: $frame.problemStatement
                    )
                    ForEach(framingSteps, id: \.key) { step in
                        FramingSection(
                            title: step.title,
                            prompt: step.prompt,
                            text: $frame[dynamicMember: step.keyPath],
                            selectedTags: $frame[dynamicMember: step.tagsKeyPath],
                            tagCatalog: step.tagCatalog
                        )
                    }
                }
                .padding(24)
            }
            .frame(minWidth: 420, idealWidth: 520)

            AIAssistPanel(frame: $frame, onRevise: { keys in onRevise(frameID, keys) })
                .frame(minWidth: 320, idealWidth: 380)
        }
        .onAppear { loadFrame() }
        .onChange(of: frame) { _, newValue in
            store.save(newValue)
        }
        .toolbar {
            ToolbarItem {
                Button {
                    exportMarkdown()
                } label: {
                    Label("Export Markdown", systemImage: "square.and.arrow.up")
                }
            }
        }
    }

    private func loadFrame() {
        if let existing = store.frames.first(where: { $0.id == frameID }) {
            frame = existing
        }
    }

    private func exportMarkdown() {
        let panel = NSSavePanel()
        panel.allowedContentTypes = [.plainText]
        panel.nameFieldStringValue = "\(frame.title.isEmpty ? "problem-frame" : frame.title).md"
        panel.begin { response in
            guard response == .OK, let url = panel.url else { return }
            try? frame.asMarkdown().write(to: url, atomically: true, encoding: .utf8)
        }
    }
}

private struct FramingSection: View {
    let title: String
    let prompt: String
    @Binding var text: String
    var selectedTags: Binding<[String]>? = nil
    var tagCatalog: [String] = []

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.headline)
            Text(prompt)
                .font(.caption)
                .foregroundStyle(.secondary)
            VoiceTextEditor(text: $text, spokenPrompt: prompt)
            if let selectedTags {
                TagPicker(selectedTags: selectedTags, tags: tagCatalog)
            }
        }
    }
}

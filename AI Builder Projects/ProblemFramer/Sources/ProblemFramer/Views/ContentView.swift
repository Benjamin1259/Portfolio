import SwiftUI

struct ContentView: View {
    @EnvironmentObject private var store: ProblemFrameStore
    @EnvironmentObject private var voiceMode: VoiceModeManager
    @State private var selectedFrameID: UUID?
    @State private var wizardFrameID: UUID?
    @State private var wizardRestrictKeys: [String]?
    @State private var reviewFrameID: UUID?
    @State private var showingSettings = false

    private var selectedFrame: ProblemFrame? {
        guard let id = selectedFrameID else { return nil }
        return store.frames.first { $0.id == id }
    }

    var body: some View {
        NavigationSplitView {
            SidebarView(selectedFrameID: $selectedFrameID)
        } detail: {
            if let wizardFrameID {
                ProblemFramingWizard(
                    frameID: wizardFrameID,
                    restrictToKeys: wizardRestrictKeys,
                    onBack: {
                        self.wizardFrameID = nil
                        self.wizardRestrictKeys = nil
                        self.selectedFrameID = nil
                    },
                    onFinish: {
                        self.wizardFrameID = nil
                        self.wizardRestrictKeys = nil
                        self.reviewFrameID = wizardFrameID
                    }
                )
                .id(wizardFrameID)
            } else if let reviewFrameID {
                ProblemFrameReviewView(frameID: reviewFrameID, onRevise: reviseFrame) {
                    self.reviewFrameID = nil
                }
                .id(reviewFrameID)
            } else if let frame = selectedFrame {
                ProblemFrameDetailView(frameID: frame.id, onRevise: reviseFrame)
                    .id(frame.id)
            } else {
                HomeView(onSubmit: startNewFrame)
            }
        }
        .onChange(of: selectedFrameID) { _, newValue in
            if newValue != wizardFrameID {
                wizardFrameID = nil
                wizardRestrictKeys = nil
            }
            if newValue != reviewFrameID {
                reviewFrameID = nil
            }
        }
        .toolbar {
            ToolbarItem(placement: .automatic) {
                Button {
                    voiceMode.isEnabled.toggle()
                } label: {
                    Label(
                        "Voice Mode",
                        systemImage: voiceMode.isEnabled ? "speaker.wave.2.fill" : "speaker.slash"
                    )
                }
                .help(voiceMode.isEnabled ? "Voice Mode is on — click to turn off" : "Turn on Voice Mode")
            }
            ToolbarItem(placement: .automatic) {
                Button {
                    showingSettings = true
                } label: {
                    Label("Settings", systemImage: "gearshape")
                }
            }
        }
        .sheet(isPresented: $showingSettings) {
            SettingsView()
        }
    }

    private func startNewFrame(seedText: String, tags: [String]) {
        var frame = ProblemFrame()
        frame.problemStatement = seedText
        frame.title = String(seedText.prefix(60))
        frame.tags = tags
        store.save(frame)
        selectedFrameID = frame.id
        wizardFrameID = frame.id
    }

    private func reviseFrame(id: UUID, sectionKeys: [String]) {
        selectedFrameID = id
        wizardFrameID = id
        wizardRestrictKeys = sectionKeys
    }
}

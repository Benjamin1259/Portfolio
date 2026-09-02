import SwiftUI

struct SidebarView: View {
    @EnvironmentObject private var store: ProblemFrameStore
    @Binding var selectedFrameID: UUID?

    var body: some View {
        List(selection: $selectedFrameID) {
            ForEach(store.frames) { frame in
                VStack(alignment: .leading, spacing: 2) {
                    Text(frame.title.isEmpty ? "Untitled Problem" : frame.title)
                        .font(.headline)
                    Text(frame.updatedAt, style: .date)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .tag(frame.id)
            }
            .onDelete { offsets in
                for index in offsets {
                    store.delete(store.frames[index])
                }
            }
        }
        .navigationTitle("Problem Frames")
        .toolbar {
            ToolbarItem {
                Button {
                    selectedFrameID = nil
                } label: {
                    Label("New Problem Frame", systemImage: "plus")
                }
            }
        }
        .frame(minWidth: 220)
    }
}

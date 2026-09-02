import SwiftUI

struct SettingsView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var apiKey: String = ""
    @State private var savedConfirmation = false

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Gemini API Key")
                .font(.headline)

            Text("Stored locally on this Mac. Get a key at aistudio.google.com/apikey.")
                .font(.caption)
                .foregroundStyle(.secondary)

            SecureField("Paste your API key", text: $apiKey)
                .textFieldStyle(.roundedBorder)
                .onChange(of: apiKey) { _, _ in savedConfirmation = false }

            if savedConfirmation {
                Text("Saved.")
                    .font(.caption)
                    .foregroundStyle(.green)
            }

            HStack {
                Spacer()
                Button("Close") { dismiss() }
                Button("Save") {
                    ApiKeyStore.save(apiKey: apiKey)
                    savedConfirmation = true
                }
                .keyboardShortcut(.defaultAction)
                .disabled(apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(24)
        .frame(width: 420)
        .onAppear {
            apiKey = ApiKeyStore.loadAPIKey() ?? ""
        }
    }
}

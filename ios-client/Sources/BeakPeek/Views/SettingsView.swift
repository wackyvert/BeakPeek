import SwiftUI

struct SettingsView: View {
    @Environment(SettingsStore.self) private var settings
    @Environment(BeakPeekAPI.self) private var api
    @Environment(\.dismiss) private var dismiss
    @State private var serviceURL = ""
    @FocusState private var focused: Bool

    var body: some View {
        Form {
            Section {
                TextField("http://beakpeek.local:8787", text: $serviceURL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.URL)
                    .focused($focused)
            } header: {
                Text("Service URL")
            }

            Section {
                Button {
                    settings.serviceURL = serviceURL
                    api.configure(serviceURL: serviceURL)
                    Task { await api.refreshAll() }
                    dismiss()
                } label: {
                    Label("Save and Connect", systemImage: "checkmark.circle")
                }
                .disabled(serviceURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)

                Button {
                    Task { await api.refreshAll() }
                } label: {
                    Label("Refresh Now", systemImage: "arrow.clockwise")
                }
            }

            Section {
                LabeledContent("Status", value: api.status.label)
                LabeledContent("Events", value: "\(api.events.count)")
                LabeledContent("Species", value: "\(api.species.count)")
            }
        }
        .navigationTitle("Settings")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Done") {
                    dismiss()
                }
            }
        }
        .onAppear {
            serviceURL = settings.serviceURL
            focused = !settings.isConfigured
        }
    }
}

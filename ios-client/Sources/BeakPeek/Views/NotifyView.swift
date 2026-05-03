import SwiftUI

struct NotifyView: View {
    @Environment(BeakPeekAPI.self) private var api

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Toggle("Notifications", isOn: Binding(
                        get: { api.notifications?.enabled ?? false },
                        set: { value in
                            Task { await api.updateNotifications(enabled: value) }
                        }
                    ))

                    LabeledContent(
                        "Home Assistant",
                        value: api.notifications?.homeAssistantConfigured == true ? "Configured" : "Missing"
                    )

                    if let notifyService = api.notifications?.notifyService, !notifyService.isEmpty {
                        LabeledContent("Service", value: notifyService)
                    }
                }

                Section {
                    Toggle("All Visitors", isOn: Binding(
                        get: { api.notifications?.notifyAllVisitors ?? false },
                        set: { value in
                            Task { await api.updateNotifications(notifyAllVisitors: value) }
                        }
                    ))
                }

                Section {
                    ForEach(api.species) { species in
                        Toggle(isOn: Binding(
                            get: { api.notifications?.isEnabled(for: species) ?? false },
                            set: { enabled in
                                Task { await api.setNotificationRule(species: species, enabled: enabled) }
                            }
                        )) {
                            SpeciesNotifyRow(species: species)
                        }
                    }
                } header: {
                    Text("Species")
                }

                Section {
                    Button {
                        Task { await api.enableAllNotificationSpecies() }
                    } label: {
                        Label("Enable All Species", systemImage: "checklist.checked")
                    }

                    Button(role: .destructive) {
                        Task { await api.clearNotificationSpecies() }
                    } label: {
                        Label("Clear Species", systemImage: "xmark.circle")
                    }
                    .disabled(api.notifications?.rules.isEmpty ?? true)
                }
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .background(AppTheme.background.ignoresSafeArea())
            .navigationTitle("Notify")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        Task { await api.refreshAll() }
                    } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                }
            }
            .task {
                await api.refreshAll()
            }
            .refreshable {
                await api.refreshAll()
            }
        }
    }
}

private struct SpeciesNotifyRow: View {
    let species: BeakPeekSpecies

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "leaf")
                .foregroundStyle(.green)
                .frame(width: 26)

            VStack(alignment: .leading, spacing: 2) {
                Text(species.displayName)
                    .font(.headline)
                    .lineLimit(1)

                Text("\(species.count) sightings")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 4)
    }
}

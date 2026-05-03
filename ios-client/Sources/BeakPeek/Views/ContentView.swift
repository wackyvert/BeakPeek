import SwiftUI

struct ContentView: View {
    @Environment(SettingsStore.self) private var settings
    @Environment(BeakPeekAPI.self) private var api
    @State private var showingSettings = false

    var body: some View {
        TabView {
            DashboardView(showingSettings: $showingSettings)
                .tabItem { Label("Today", systemImage: "sun.max") }

            EventsListView()
                .tabItem { Label("Events", systemImage: "bird") }

            SpeciesListView()
                .tabItem { Label("Species", systemImage: "leaf") }

            NotifyView()
                .tabItem { Label("Notify", systemImage: "bell") }

            SettingsView()
                .tabItem { Label("Settings", systemImage: "gearshape") }
        }
        .tint(.green)
        .sheet(isPresented: $showingSettings) {
            NavigationStack {
                SettingsView()
            }
            .presentationDetents([.medium, .large])
        }
        .task {
            api.configure(serviceURL: settings.serviceURL)
            await api.refreshAll()
            if !settings.isConfigured {
                showingSettings = true
            }
        }
        .onChange(of: settings.serviceURL) { _, newValue in
            api.configure(serviceURL: newValue)
            Task { await api.refreshAll() }
        }
    }
}

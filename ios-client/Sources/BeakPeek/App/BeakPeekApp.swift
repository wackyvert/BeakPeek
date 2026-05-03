import SwiftUI

@main
struct BeakPeekApp: App {
    @State private var settings = SettingsStore()
    @State private var api = BeakPeekAPI()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environment(settings)
                .environment(api)
                .preferredColorScheme(.dark)
        }
    }
}

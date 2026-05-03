import Foundation
import Observation

@MainActor
@Observable
final class SettingsStore {
    private static let serviceURLKey = "beakpeek.serviceURL"

    var serviceURL: String {
        didSet {
            UserDefaults.standard.set(serviceURL, forKey: Self.serviceURLKey)
        }
    }

    init() {
        serviceURL = UserDefaults.standard.string(forKey: Self.serviceURLKey) ?? ""
    }

    var isConfigured: Bool {
        !serviceURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}

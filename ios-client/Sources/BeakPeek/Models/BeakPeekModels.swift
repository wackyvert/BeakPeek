import Foundation

struct BeakPeekSummary: Codable, Equatable {
    let service: String?
    let generatedAt: TimeInterval
    let latest: BeakPeekEvent?
    let visitsLast2h: Int
    let todaySpecies: Int
    let cameras: [String]
    let inFlight: [String]
}

struct BeakPeekEvent: Codable, Equatable, Hashable, Identifiable {
    let id: String
    let timestamp: TimeInterval
    let cameraId: String
    let cameraName: String
    let predictionIndex: Int?
    let scientificName: String?
    let commonName: String?
    let confidence: Double?
    let imageUrl: String?
    let source: String

    var displayName: String {
        commonName ?? scientificName ?? "Visitor"
    }

    var notificationKey: String? {
        Self.notificationKey(commonName: commonName, scientificName: scientificName)
    }

    var date: Date {
        Date(timeIntervalSince1970: timestamp / 1000.0)
    }

    var confidenceLabel: String {
        guard let confidence else { return "Unknown confidence" }
        return confidence.formatted(.percent.precision(.fractionLength(0)))
    }

    static func notificationKey(commonName: String?, scientificName: String?) -> String? {
        let name = commonName ?? scientificName
        let normalized = name?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        return normalized?.isEmpty == false ? normalized : nil
    }
}

struct BeakPeekSpecies: Codable, Equatable, Hashable, Identifiable {
    let commonName: String?
    let scientificName: String?
    let count: Int

    var id: String {
        "\(commonName ?? "")|\(scientificName ?? "")"
    }

    var displayName: String {
        commonName ?? scientificName ?? "Unknown species"
    }

    var notificationKey: String? {
        BeakPeekEvent.notificationKey(commonName: commonName, scientificName: scientificName)
    }
}

struct BeakPeekNotificationPreferences: Codable, Equatable {
    let enabled: Bool
    let notifyAllVisitors: Bool
    let homeAssistantConfigured: Bool
    let notifyService: String
    let rules: [BeakPeekNotificationRule]

    func isEnabled(for species: BeakPeekSpecies) -> Bool {
        guard let key = species.notificationKey else { return false }
        return rules.contains { $0.speciesKey == key && $0.enabled }
    }
}

struct BeakPeekNotificationRule: Codable, Equatable, Hashable, Identifiable {
    let speciesKey: String
    let commonName: String?
    let scientificName: String?
    let enabled: Bool

    var id: String { speciesKey }
}

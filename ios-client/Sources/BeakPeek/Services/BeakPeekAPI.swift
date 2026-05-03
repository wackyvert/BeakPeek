import Foundation
import Observation

@MainActor
@Observable
final class BeakPeekAPI {
    enum Status: Equatable {
        case idle
        case loading
        case online
        case offline(String)

        var label: String {
            switch self {
            case .idle: "Not configured"
            case .loading: "Connecting"
            case .online: "Online"
            case .offline(let message): message
            }
        }
    }

    var status: Status = .idle
    var summary: BeakPeekSummary?
    var events: [BeakPeekEvent] = []
    var species: [BeakPeekSpecies] = []
    var notifications: BeakPeekNotificationPreferences?

    private var baseURL: URL?
    private var streamTask: Task<Void, Never>?

    func configure(serviceURL rawValue: String) {
        let normalized = Self.normalizedURLString(rawValue)
        guard !normalized.isEmpty, let url = URL(string: normalized) else {
            baseURL = nil
            summary = nil
            events = []
            species = []
            notifications = nil
            status = .idle
            stopStream()
            return
        }

        guard url != baseURL else { return }
        baseURL = url
        status = .loading
        stopStream()
        startStream()
    }

    func refreshAll() async {
        guard baseURL != nil else {
            status = .idle
            return
        }

        if status != .online { status = .loading }

        do {
            async let summary: BeakPeekSummary = get("api/v1/summary")
            async let events: [BeakPeekEvent] = get("api/v1/events?limit=75")
            async let species: [BeakPeekSpecies] = get("api/v1/species")
            async let notifications: BeakPeekNotificationPreferences = get("api/v1/notifications")

            self.summary = try await summary
            self.events = try await events
            self.species = try await species
            self.notifications = try await notifications
            status = .online
        } catch {
            status = .offline(error.localizedDescription)
        }
    }

    func classify(cameraId: String) async {
        guard !cameraId.isEmpty else { return }
        do {
            let _: ClassifyResponse = try await post("api/v1/cameras/\(cameraId)/classify", body: ["delay": false])
            await refreshAll()
        } catch {
            status = .offline(error.localizedDescription)
        }
    }

    func updateNotifications(enabled: Bool? = nil, notifyAllVisitors: Bool? = nil) async {
        do {
            notifications = try await send(
                "api/v1/notifications",
                method: "PUT",
                body: NotificationPreferenceUpdate(
                    enabled: enabled,
                    notifyAllVisitors: notifyAllVisitors
                )
            )
        } catch {
            status = .offline(error.localizedDescription)
        }
    }

    func setNotificationRule(species: BeakPeekSpecies, enabled: Bool) async {
        guard let key = species.notificationKey,
              let encodedKey = key.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) else {
            return
        }

        do {
            notifications = try await send(
                "api/v1/notifications/species/\(encodedKey)",
                method: "PUT",
                body: NotificationRuleUpdate(
                    enabled: enabled,
                    commonName: species.commonName,
                    scientificName: species.scientificName
                )
            )
        } catch {
            status = .offline(error.localizedDescription)
        }
    }

    func enableAllNotificationSpecies() async {
        do {
            notifications = try await send(
                "api/v1/notifications/species/enable-all",
                method: "POST",
                body: EmptyBody()
            )
        } catch {
            status = .offline(error.localizedDescription)
        }
    }

    func clearNotificationSpecies() async {
        guard let url = endpoint("api/v1/notifications/species") else { return }
        do {
            var request = URLRequest(url: url)
            request.httpMethod = "DELETE"
            let (data, response) = try await URLSession.shared.data(for: request)
            try validate(response)
            notifications = try JSONDecoder().decode(BeakPeekNotificationPreferences.self, from: data)
        } catch {
            status = .offline(error.localizedDescription)
        }
    }

    func delete(event: BeakPeekEvent) async {
        guard let url = endpoint("api/v1/events/\(event.id)") else { return }
        do {
            var request = URLRequest(url: url)
            request.httpMethod = "DELETE"
            let (_, response) = try await URLSession.shared.data(for: request)
            try validate(response)
            events.removeAll { $0.id == event.id }
            if summary?.latest?.id == event.id {
                await refreshAll()
            }
        } catch {
            status = .offline(error.localizedDescription)
        }
    }

    func imageURL(for event: BeakPeekEvent?) -> URL? {
        guard let imageUrl = event?.imageUrl else { return nil }
        if let absolute = URL(string: imageUrl), absolute.scheme != nil {
            return absolute
        }
        guard let baseURL else { return nil }
        return URL(string: imageUrl, relativeTo: baseURL)?.absoluteURL
    }

    private func startStream() {
        guard baseURL != nil else { return }
        streamTask = Task { [weak self] in
            await self?.runStream()
        }
    }

    private func stopStream() {
        streamTask?.cancel()
        streamTask = nil
    }

    private func runStream() async {
        while !Task.isCancelled {
            guard let url = endpoint("api/v1/stream") else { return }

            do {
                var request = URLRequest(url: url)
                request.setValue("text/event-stream", forHTTPHeaderField: "Accept")

                let (bytes, response) = try await URLSession.shared.bytes(for: request)
                try validate(response)
                status = .online

                var dataLines: [String] = []
                for try await line in bytes.lines {
                    if Task.isCancelled { return }
                    if line.isEmpty {
                        consumeStreamData(dataLines)
                        dataLines.removeAll(keepingCapacity: true)
                    } else if line.hasPrefix("data:") {
                        dataLines.append(String(line.dropFirst(5)).trimmingCharacters(in: .whitespaces))
                    }
                }
            } catch {
                if Task.isCancelled { return }
                status = .offline(error.localizedDescription)
                try? await Task.sleep(nanoseconds: 5_000_000_000)
            }
        }
    }

    private func consumeStreamData(_ lines: [String]) {
        guard !lines.isEmpty else { return }
        let payload = lines.joined(separator: "\n")
        guard let data = payload.data(using: .utf8),
              let event = try? JSONDecoder().decode(BeakPeekEvent.self, from: data) else {
            return
        }

        events.removeAll { $0.id == event.id }
        events.insert(event, at: 0)
        if events.count > 75 {
            events = Array(events.prefix(75))
        }

        if let current = summary {
            summary = BeakPeekSummary(
                service: current.service,
                generatedAt: Date().timeIntervalSince1970 * 1000,
                latest: event,
                visitsLast2h: current.visitsLast2h + 1,
                todaySpecies: current.todaySpecies,
                cameras: Array(Set(current.cameras + [event.cameraId])).sorted(),
                inFlight: current.inFlight
            )
        }

        Task {
            await refreshAll()
        }
    }

    private func get<T: Decodable>(_ path: String) async throws -> T {
        guard let url = endpoint(path) else { throw URLError(.badURL) }
        let (data, response) = try await URLSession.shared.data(from: url)
        try validate(response)
        return try JSONDecoder().decode(T.self, from: data)
    }

    private func post<T: Decodable, Body: Encodable>(_ path: String, body: Body) async throws -> T {
        try await send(path, method: "POST", body: body)
    }

    private func send<T: Decodable, Body: Encodable>(_ path: String, method: String, body: Body) async throws -> T {
        guard let url = endpoint(path) else { throw URLError(.badURL) }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(body)

        let (data, response) = try await URLSession.shared.data(for: request)
        try validate(response)
        return try JSONDecoder().decode(T.self, from: data)
    }

    private func endpoint(_ path: String) -> URL? {
        guard let baseURL else { return nil }
        return URL(string: path, relativeTo: baseURL)?.absoluteURL
    }

    private func validate(_ response: URLResponse) throws {
        guard let http = response as? HTTPURLResponse,
              (200..<300).contains(http.statusCode) else {
            throw URLError(.badServerResponse)
        }
    }

    private static func normalizedURLString(_ rawValue: String) -> String {
        let trimmed = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return "" }
        let withScheme = trimmed.hasPrefix("http://") || trimmed.hasPrefix("https://")
            ? trimmed
            : "http://\(trimmed)"
        return withScheme.replacingOccurrences(of: "/+$", with: "", options: .regularExpression)
    }
}

private struct ClassifyResponse: Decodable {
    let skipped: Bool
    let reason: String?
    let event: BeakPeekEvent?
}

private struct NotificationPreferenceUpdate: Encodable {
    let enabled: Bool?
    let notifyAllVisitors: Bool?
}

private struct NotificationRuleUpdate: Encodable {
    let enabled: Bool
    let commonName: String?
    let scientificName: String?
}

private struct EmptyBody: Encodable {}

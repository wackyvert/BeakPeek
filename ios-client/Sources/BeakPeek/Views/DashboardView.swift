import SwiftUI

struct DashboardView: View {
    @Environment(BeakPeekAPI.self) private var api
    @Binding var showingSettings: Bool

    private let columns = [
        GridItem(.flexible(), spacing: 12),
        GridItem(.flexible(), spacing: 12),
        GridItem(.flexible(), spacing: 12)
    ]

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    LatestEventCard(event: api.summary?.latest)

                    LazyVGrid(columns: columns, spacing: 12) {
                        StatTile(value: "\(api.summary?.visitsLast2h ?? 0)", label: "Visits 2h", symbol: "eye")
                        StatTile(value: "\(api.summary?.todaySpecies ?? 0)", label: "Species", symbol: "leaf")
                        StatTile(value: "\(api.summary?.cameras.count ?? 0)", label: "Cameras", symbol: "camera")
                    }

                    CameraStrip()

                    SectionHeader(title: "Recent", actionTitle: nil)
                    VStack(spacing: 10) {
                        ForEach(api.events.prefix(8)) { event in
                            NavigationLink(value: event) {
                                EventRow(event: event)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
                .padding()
            }
            .background(AppTheme.background.ignoresSafeArea())
            .navigationTitle("BeakPeek")
            .navigationDestination(for: BeakPeekEvent.self) { event in
                EventDetailView(event: event)
            }
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    StatusBadge(status: api.status)
                }
                ToolbarItemGroup(placement: .topBarTrailing) {
                    Button {
                        Task { await api.refreshAll() }
                    } label: {
                        Image(systemName: "arrow.clockwise")
                    }

                    Button {
                        showingSettings = true
                    } label: {
                        Image(systemName: "gearshape")
                    }
                }
            }
            .refreshable {
                await api.refreshAll()
            }
        }
    }
}

private struct LatestEventCard: View {
    @Environment(BeakPeekAPI.self) private var api
    let event: BeakPeekEvent?

    var body: some View {
        if let event {
            NavigationLink(value: event) {
                card
            }
            .buttonStyle(.plain)
        } else {
            card
        }
    }

    private var card: some View {
        ZStack(alignment: .bottomLeading) {
            RemoteImage(url: api.imageURL(for: event), height: 360)

            LinearGradient(
                colors: [.clear, .black.opacity(0.82)],
                startPoint: .top,
                endPoint: .bottom
            )

            VStack(alignment: .leading, spacing: 8) {
                Label(event?.cameraName ?? "Waiting for a visitor", systemImage: "camera")
                    .font(.callout.weight(.semibold))
                    .foregroundStyle(.white.opacity(0.82))

                Text(event?.displayName ?? "No sightings yet")
                    .font(.largeTitle.bold())
                    .foregroundStyle(.white)
                    .lineLimit(2)
                    .minimumScaleFactor(0.7)

                if let event {
                    Text("\(event.date.formatted(date: .omitted, time: .shortened)) · \(event.confidenceLabel)")
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(.white.opacity(0.74))
                }
            }
            .padding(18)
        }
        .frame(maxWidth: .infinity)
        .frame(height: 360)
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .stroke(.white.opacity(0.12), lineWidth: 1)
        }
    }
}

private struct CameraStrip: View {
    @Environment(BeakPeekAPI.self) private var api

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionHeader(title: "Cameras", actionTitle: nil)

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 10) {
                    ForEach(api.summary?.cameras ?? [], id: \.self) { cameraId in
                        CameraButton(cameraId: cameraId)
                    }
                }
            }
        }
    }
}

private struct CameraButton: View {
    @Environment(BeakPeekAPI.self) private var api
    let cameraId: String

    var body: some View {
        Button {
            Task { await api.classify(cameraId: cameraId) }
        } label: {
            Label(cameraId, systemImage: api.summary?.inFlight.contains(cameraId) == true ? "hourglass" : "camera.aperture")
                .font(.callout.weight(.semibold))
                .lineLimit(1)
        }
        .buttonStyle(.bordered)
        .controlSize(.large)
    }
}

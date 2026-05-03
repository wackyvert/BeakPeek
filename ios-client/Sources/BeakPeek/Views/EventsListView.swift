import SwiftUI

struct EventsListView: View {
    @Environment(BeakPeekAPI.self) private var api

    var body: some View {
        NavigationStack {
            List {
                ForEach(api.events) { event in
                    NavigationLink(value: event) {
                        EventRow(event: event)
                    }
                    .listRowBackground(Color.clear)
                }
                .onDelete { offsets in
                    for offset in offsets {
                        let event = api.events[offset]
                        Task { await api.delete(event: event) }
                    }
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(AppTheme.background.ignoresSafeArea())
            .navigationTitle("Events")
            .navigationDestination(for: BeakPeekEvent.self) { event in
                EventDetailView(event: event)
            }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        Task { await api.refreshAll() }
                    } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                }
            }
            .refreshable {
                await api.refreshAll()
            }
        }
    }
}

struct EventRow: View {
    @Environment(BeakPeekAPI.self) private var api
    let event: BeakPeekEvent

    var body: some View {
        HStack(spacing: 12) {
            RemoteImage(url: api.imageURL(for: event), height: 76)
                .frame(width: 92)
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))

            VStack(alignment: .leading, spacing: 4) {
                Text(event.displayName)
                    .font(.headline)
                    .foregroundStyle(.primary)
                    .lineLimit(1)

                Text(event.cameraName)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)

                Text(event.date.formatted(date: .abbreviated, time: .shortened))
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.secondary)
            }

            Spacer(minLength: 8)

            Text(event.confidenceLabel)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.green)
        }
        .padding(.vertical, 6)
    }
}

import SwiftUI

struct EventDetailView: View {
    @Environment(BeakPeekAPI.self) private var api
    @Environment(\.dismiss) private var dismiss
    let event: BeakPeekEvent

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                RemoteImage(url: api.imageURL(for: event), height: 440)
                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))

                VStack(alignment: .leading, spacing: 12) {
                    Text(event.displayName)
                        .font(.largeTitle.bold())
                        .lineLimit(2)
                        .minimumScaleFactor(0.72)

                    DetailRow(label: "Camera", value: event.cameraName, symbol: "camera")
                    DetailRow(label: "Time", value: event.date.formatted(date: .abbreviated, time: .shortened), symbol: "clock")
                    DetailRow(label: "Confidence", value: event.confidenceLabel, symbol: "gauge.with.dots.needle.bottom.50percent")
                    DetailRow(label: "Source", value: event.source.capitalized, symbol: "antenna.radiowaves.left.and.right")

                    if let scientificName = event.scientificName, scientificName != event.commonName {
                        DetailRow(label: "Scientific", value: scientificName, symbol: "text.book.closed")
                    }
                }
                .padding()
                .background(AppTheme.panel)
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            }
            .padding()
        }
        .background(AppTheme.background.ignoresSafeArea())
        .navigationTitle("Sighting")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button(role: .destructive) {
                    Task {
                        await api.delete(event: event)
                        dismiss()
                    }
                } label: {
                    Image(systemName: "trash")
                }
            }
        }
    }
}

private struct DetailRow: View {
    let label: String
    let value: String
    let symbol: String

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: symbol)
                .frame(width: 24)
                .foregroundStyle(.green)

            VStack(alignment: .leading, spacing: 2) {
                Text(label)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                Text(value)
                    .font(.body.weight(.medium))
                    .foregroundStyle(.primary)
                    .lineLimit(2)
            }
        }
    }
}

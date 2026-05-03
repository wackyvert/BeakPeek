import SwiftUI

enum AppTheme {
    static let background = LinearGradient(
        colors: [
            Color(red: 0.03, green: 0.04, blue: 0.05),
            Color(red: 0.05, green: 0.07, blue: 0.06)
        ],
        startPoint: .top,
        endPoint: .bottom
    )

    static let panel = Color.white.opacity(0.07)
}

struct RemoteImage: View {
    let url: URL?
    let height: CGFloat

    var body: some View {
        AsyncImage(url: url) { phase in
            switch phase {
            case .empty:
                placeholder
                    .overlay {
                        ProgressView()
                    }
            case .success(let image):
                image
                    .resizable()
                    .scaledToFill()
            case .failure:
                placeholder
                    .overlay {
                        Image(systemName: "photo")
                            .font(.largeTitle)
                            .foregroundStyle(.secondary)
                    }
            @unknown default:
                placeholder
            }
        }
        .frame(maxWidth: .infinity)
        .frame(height: height)
        .clipped()
        .background(.black)
    }

    private var placeholder: some View {
        Rectangle()
            .fill(.black.opacity(0.55))
    }
}

struct StatTile: View {
    let value: String
    let label: String
    let symbol: String

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Image(systemName: symbol)
                .font(.headline)
                .foregroundStyle(.green)

            Text(value)
                .font(.title.bold())
                .monospacedDigit()
                .lineLimit(1)
                .minimumScaleFactor(0.7)

            Text(label)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(AppTheme.panel)
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
    }
}

struct SectionHeader: View {
    let title: String
    let actionTitle: String?

    var body: some View {
        HStack {
            Text(title)
                .font(.headline)
            Spacer()
            if let actionTitle {
                Text(actionTitle)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
            }
        }
    }
}

struct StatusBadge: View {
    let status: BeakPeekAPI.Status

    var body: some View {
        Label(status.label, systemImage: symbol)
            .font(.caption.weight(.semibold))
            .foregroundStyle(color)
            .lineLimit(1)
    }

    private var symbol: String {
        switch status {
        case .online: "checkmark.circle.fill"
        case .loading: "arrow.triangle.2.circlepath"
        case .idle: "circle"
        case .offline: "exclamationmark.triangle.fill"
        }
    }

    private var color: Color {
        switch status {
        case .online: .green
        case .loading: .yellow
        case .idle: .secondary
        case .offline: .orange
        }
    }
}

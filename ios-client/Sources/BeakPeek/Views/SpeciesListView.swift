import SwiftUI

struct SpeciesListView: View {
    @Environment(BeakPeekAPI.self) private var api

    var body: some View {
        NavigationStack {
            List(api.species) { species in
                HStack(spacing: 12) {
                    Image(systemName: "leaf")
                        .foregroundStyle(.green)
                        .frame(width: 28)

                    VStack(alignment: .leading, spacing: 3) {
                        Text(species.displayName)
                            .font(.headline)
                            .lineLimit(1)

                        if let scientificName = species.scientificName,
                           scientificName != species.commonName {
                            Text(scientificName)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                    }

                    Spacer()

                    Text("\(species.count)")
                        .font(.title3.bold())
                        .monospacedDigit()
                        .foregroundStyle(.green)
                }
                .padding(.vertical, 6)
                .listRowBackground(Color.clear)
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(AppTheme.background.ignoresSafeArea())
            .navigationTitle("Species")
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

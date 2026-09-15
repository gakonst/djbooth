import SwiftUI
import DJBoothKit

struct LibraryView: View {
    @Bindable var model: BoothModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private var selected: Collection? { model.collections.first { $0.id == model.selectedCollection } }
    private var animation: Animation? { reduceMotion ? nil : .easeOut(duration: 0.16) }
    var body: some View {
        #if os(iOS)
        Group {
            if model.showPlaylistBrowser || selected == nil {
                PlaylistBrowserView(model: model).transition(.opacity)
            } else {
                mobileTrackBrowser.transition(.opacity)
            }
        }.background(BoothStyle.background)
        #else
        VStack(spacing: 0) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    Button { withAnimation(animation) { model.openPlaylistBrowser() } } label: {
                        Label("Playlists", systemImage: "square.stack").font(.caption.weight(.medium))
                            .padding(.horizontal, 10).padding(.vertical, 8)
                            .background(model.showPlaylistBrowser ? BoothStyle.accent.opacity(0.15) : BoothStyle.surface, in: RoundedRectangle(cornerRadius: 5))
                    }.accessibilityIdentifier("library.playlists")
                    ForEach(["All music", "Unsorted", "Favorites", "On this device"], id: \.self) { filter in
                        Button { withAnimation(animation) { model.showLibrary(filter: filter) } } label: {
                            Text(filter).font(.caption).padding(.horizontal, 10).padding(.vertical, 8)
                                .background(!model.showPlaylistBrowser && selected == nil && model.filter == filter ? BoothStyle.accent.opacity(0.15) : BoothStyle.surface, in: RoundedRectangle(cornerRadius: 5))
                        }
                    }
                }.buttonStyle(.plain).padding(.horizontal, 12).padding(.vertical, 8)
            }.accessibilityIdentifier("library.filters")
            if model.showPlaylistBrowser {
                PlaylistBrowserView(model: model).transition(.opacity)
            } else {
                trackBrowser.transition(.opacity)
            }
        }.background(BoothStyle.background)
        #endif
    }
    #if os(iOS)
    private var mobileTrackBrowser: some View {
        MobileTrackList(model: model, collectionID: selected?.id ?? "")
    }
    #else
    private var trackBrowser: some View {
        let tracks = model.visibleTracks
        let selected = self.selected
        return VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 10) {
                if let selected {
                    Button { withAnimation(animation) { model.backFromCollection() } } label: {
                        HStack(spacing: 10) {
                            Image(systemName: "arrow.left").frame(width: 32, height: 32).background(BoothStyle.surface)
                            VStack(alignment: .leading, spacing: 3) {
                                Text(selected.name).font(.system(size: 13, weight: .semibold)).lineLimit(1)
                                Text("Up one level").font(.system(size: 10)).foregroundStyle(.secondary)
                            }
                            Spacer()
                        }.contentShape(Rectangle())
                    }.buttonStyle(.plain).accessibilityIdentifier("playlist.back")
                }
                HStack {
                    Text("\(tracks.count) tracks").font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                    Text("·").foregroundStyle(.tertiary)
                    Label("\(tracks.count(where: { model.offlineIDs.contains($0.id) })) local", systemImage: "internaldrive").font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                    Spacer()
                    Menu {
                        Button("New playlist", systemImage: "plus") { model.showNewCollection = true }
                        if let selected {
                            Button("Keep playlist offline", systemImage: "arrow.down.circle") { Task { await model.keepCollectionOffline(selected) } }
                        }
                        if let selected, model.workstationConnected {
                            Button("Add to Rekordbox", systemImage: "externaldrive") { Task { await model.exportCollection(selected) } }
                        }
                    } label: { Image(systemName: "ellipsis.circle").font(.title3) }.accessibilityIdentifier("library.collectionMenu")
                }
                LibrarySearchField(text: $model.query, prompt: "Search tracks, artists, comments", identifier: "library.search")
                HStack(spacing: 5) {
                    trackSortButton("Order", field: "default")
                    trackSortButton("A–Z", field: "title")
                    trackSortButton("BPM", field: "bpm")
                    trackSortButton("Key", field: "key")
                }.buttonStyle(.plain)
            }.padding(12)
            #if os(macOS)
            TrackTableHeader().padding(.horizontal, 8)
            #endif
            if tracks.isEmpty {
                ContentUnavailableView(model.query.isEmpty ? "No tracks" : "No matching tracks", systemImage: "music.note.list",
                                       description: Text(model.filter == "Unsorted" ? "Every recording already belongs to a playlist." : model.query.isEmpty ? "Import music or add tracks to this playlist." : "Try another title, artist, or comment."))
            } else {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(tracks) { track in TrackRow(track: track, model: model, collection: selected) }
                    }.padding(.horizontal, 8)
                        .animation(animation, value: tracks.map(\.id))
                }.id(selected?.id ?? model.filter)
            }
        }
    }
    private func trackSortButton(_ title: String, field: String) -> some View {
        Button {
            if model.trackSort == field && field != "default" { model.trackSortAscending.toggle() }
            else { model.trackSort = field; model.trackSortAscending = true }
        } label: {
            HStack(spacing: 3) {
                Text(title)
                if model.trackSort == field && field != "default" { Image(systemName: model.trackSortAscending ? "arrow.up" : "arrow.down") }
            }.font(.system(size: 10)).frame(maxWidth: .infinity).padding(.vertical, 5)
                .background(model.trackSort == field ? Color.white.opacity(0.08) : Color.clear)
                .overlay(Rectangle().stroke(BoothStyle.border))
        }.accessibilityIdentifier("track.sort.\(field)")
    }
    #endif
}

#if os(iOS)
struct MobileTrackList: View {
    @Bindable var model: BoothModel
    let collectionID: String
    var body: some View {
        let selected = model.collections.first { $0.id == collectionID }
        let byID = model.tracksByID
        let tracks = selected?.trackIDs.compactMap { byID[$0] } ?? []
        List {
            if let selected {
                HStack(alignment: .center, spacing: 10) {
                    Button { model.backFromCollection() } label: {
                        Image(systemName: "chevron.left")
                            .font(.system(size: 18, weight: .medium)).frame(width: 36, height: 44)
                            .contentShape(Rectangle())
                    }.buttonStyle(.plain).accessibilityLabel("Back to playlists")
                        .accessibilityIdentifier("playlist.back")
                    Text(selected.name).font(.system(size: 22, weight: .bold)).lineLimit(2)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .accessibilityIdentifier("playlist.title")
                }.padding(.vertical, 12).padding(.trailing, 8)
                    .listRowInsets(EdgeInsets(top: 0, leading: 8, bottom: 0, trailing: 8))
                    .listRowSeparator(.hidden).listRowBackground(BoothStyle.background)
            }
            if tracks.isEmpty {
                ContentUnavailableView("No tracks", systemImage: "music.note.list")
                    .listRowSeparator(.hidden).listRowBackground(BoothStyle.background)
            } else {
                ForEach(tracks) { track in
                    TrackRow(track: track, model: model, collection: selected)
                        .listRowInsets(EdgeInsets(top: 0, leading: 8, bottom: 0, trailing: 8))
                        .listRowSeparator(.hidden).listRowBackground(BoothStyle.background)
                }
            }
        }.listStyle(.plain).scrollContentBackground(.hidden)
            .environment(\.defaultMinListRowHeight, 0)
            .background(BoothStyle.background).accessibilityIdentifier("library.tracks")
    }
}
#endif

struct TrackRow: View {
    let track: Track
    @Bindable var model: BoothModel
    var collection: Collection? = nil
    var preservingQueue = false
    @State private var editingAnnotation = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        SwipeRow(left: leftSwipe, right: rightSwipe, identity: track.id) { activation in rowContent(activation: activation) }
            .sheet(isPresented: $editingAnnotation) { TrackAnnotationEditor(track: track, model: model) }
            .contextMenu {
                Button("Comment & color") { editingAnnotation = true }
                Button(model.favorites.contains(track.id) ? "Remove from favorites" : "Add to favorites") { model.favorite(track) }
                Button("Add to playlist") { model.choosePlaylist(for: track) }
                if let collection, let position = collection.trackIDs.firstIndex(of: track.id) {
                    if position > 0 { Button("Move earlier") { model.move(track, in: collection, by: -1) } }
                    if position < collection.trackIDs.count - 1 { Button("Move later") { model.move(track, in: collection, by: 1) } }
                    Button("Remove from playlist", role: .destructive) { model.requestRemoval(track, from: collection) }
                }
                Button("Keep on this device") { Task { await model.keepOffline(track) } }
                    .disabled(model.demo || model.offlineIDs.contains(track.id))
            }
            .accessibilityAction(named: "Comment & color") { editingAnnotation = true }
            .accessibilityAction(named: "Add to playlist") { model.choosePlaylist(for: track) }
    }
    private var leftSwipe: RowSwipeAction? {
        if let collection {
            RowSwipeAction(title: "Remove", symbol: "minus", color: .pink) {
                model.requestRemoval(track, from: collection)
            }
        } else {
            RowSwipeAction(title: "Archive", symbol: "archivebox", color: .orange) {
                withAnimation(reduceMotion ? nil : .easeOut(duration: 0.16)) { model.archive(track) }
            }
        }
    }
    private var rightSwipe: RowSwipeAction? {
        if collection != nil {
            return RowSwipeAction(title: "Add to playlist", symbol: "plus", color: .green) { model.choosePlaylist(for: track) }
        }
        return RowSwipeAction(title: model.quickAddTarget.map { "Add to \($0.name)" } ?? "Add to playlist", symbol: "plus", color: .green) {
            withAnimation(reduceMotion ? nil : .easeOut(duration: 0.16)) { model.quickAdd(track) }
        }
    }
    @ViewBuilder private func rowContent(activation: RowSwipeActivation) -> some View {
        #if os(iOS)
        mobileRow(activation: activation)
        #else
        HStack(spacing: 10) {
            Button {
                guard activation.canActivate() else { return }
                Task { await model.play(track, preservingQueue: preservingQueue) }
            } label: {
                HStack(spacing: 10) {
                    TrackArtwork(track: track, model: model, size: artworkSize)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(track.title).font(.subheadline.weight(.medium)).lineLimit(1)
                        Text(track.artist ?? "Unknown artist").font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                    }.frame(maxWidth: .infinity, alignment: .leading)
                }.contentShape(Rectangle())
            }.buttonStyle(.plain).accessibilityLabel("Play \(track.title)")
            #if os(macOS)
            AnalysisWaveform(waveform: track.waveform, compact: true).frame(width: 105, height: 26)
            Text(track.album ?? "—").font(.caption).foregroundStyle(.secondary).lineLimit(1).frame(width: 140, alignment: .leading)
            Text(track.bpm.map { String(format: "%.0f", $0) } ?? "—").font(.caption.monospacedDigit()).foregroundStyle(.secondary).frame(width: 38)
            Text(track.key ?? "—").font(.caption).foregroundStyle(.secondary).frame(width: 35)
            #endif
            Group {
                if model.downloading.contains(track.id) { ProgressView().controlSize(.mini) }
                else { Image(systemName: model.offlineIDs.contains(track.id) ? "checkmark.circle.fill" : "cloud")
                        .foregroundStyle(model.offlineIDs.contains(track.id) ? BoothStyle.mint : Color.secondary.opacity(0.35)) }
            }.font(.caption2).frame(width: 14).accessibilityLabel(model.offlineIDs.contains(track.id) ? "Available offline" : "Not on this device")
            Button { model.favorite(track) } label: {
                Image(systemName: model.favorites.contains(track.id) ? "heart.fill" : "heart")
                    .foregroundStyle(model.favorites.contains(track.id) ? BoothStyle.accent : .secondary)
            }.buttonStyle(.plain).accessibilityLabel(model.favorites.contains(track.id) ? "Unfavorite \(track.title)" : "Favorite \(track.title)")
            #if os(macOS)
            Text(timeLabel(track.durationSeconds)).font(.caption.monospacedDigit()).foregroundStyle(.secondary).frame(width: 40)
            #endif
            Menu {
                Button("Comment & color", systemImage: "square.and.pencil") { editingAnnotation = true }
                Button("Keep on this device", systemImage: "arrow.down.circle") { Task { await model.keepOffline(track) } }
                    .disabled(model.demo || model.offlineIDs.contains(track.id))
                Menu("Add to playlist") {
                    ForEach(model.collections) { collection in Button(collection.name) { model.add(track, to: collection) } }
                    Button("New playlist…") { model.showNewCollection = true }
                }
                if let collection {
                    Button("Remove from playlist", role: .destructive) { model.requestRemoval(track, from: collection) }
                    Button("Move earlier", systemImage: "arrow.up") { model.move(track, in: collection, by: -1) }
                    Button("Move later", systemImage: "arrow.down") { model.move(track, in: collection, by: 1) }
                } else {
                    Button("Archive", systemImage: "archivebox") { model.archive(track) }
                }
                if let raw = track.hosted?.externalUrl, let url = URL(string: raw), url.scheme == "https" {
                    Link("Open on \(track.source)", destination: url)
                }
            } label: { Image(systemName: "ellipsis").frame(width: 22, height: 30) }.menuStyle(.borderlessButton)
                .accessibilityLabel("Options for \(track.title)")
        }.padding(.horizontal, 8).padding(.vertical, rowPadding)
            .background(model.player.track?.id == track.id ? BoothStyle.accent.opacity(0.12) : .clear, in: RoundedRectangle(cornerRadius: 5))
            .overlay(alignment: .bottom) { Rectangle().fill(BoothStyle.border.opacity(0.45)).frame(height: 0.5) }
        #endif
    }
    private func mobileRow(activation: RowSwipeActivation) -> some View {
        HStack(spacing: 7) {
            Button {
                guard activation.canActivate() else { return }
                Task { await model.play(track, preservingQueue: preservingQueue) }
            } label: {
                AnalysisWaveform(waveform: track.waveform, compact: true)
                    .frame(width: 72, height: 38).allowsHitTesting(false)
                    .background(BoothStyle.background)
                    .overlay(Rectangle().stroke(BoothStyle.border, lineWidth: 0.5))
            }.buttonStyle(.plain).accessibilityLabel("Play \(track.title)")
                .accessibilityIdentifier("track.waveform.\(track.id)")
            Button {
                guard activation.canActivate() else { return }
                Task { await model.play(track, preservingQueue: preservingQueue) }
            } label: {
                VStack(alignment: .leading, spacing: 3) {
                    Text(track.title).font(.system(size: 13, weight: .semibold)).lineLimit(1)
                    HStack(spacing: 4) {
                        if model.offlineIDs.contains(track.id) {
                            Image(systemName: "checkmark.circle.fill").foregroundStyle(BoothStyle.mint).font(.system(size: 8))
                        }
                        Text(track.artist ?? "Unknown artist").lineLimit(1)
                    }.font(.system(size: 10)).foregroundStyle(.secondary)
                    if !model.annotation(for: track).note.isEmpty {
                        Text(model.annotation(for: track).note).font(.system(size: 10)).foregroundStyle(model.annotation(for: track).color?.tint ?? .secondary)
                            .lineLimit(1).accessibilityIdentifier("track.note.\(track.id)")
                    }
                }.frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
            }.buttonStyle(.plain).accessibilityLabel("Play \(track.title)")
            VStack(alignment: .trailing, spacing: 2) {
                HStack(spacing: 0) {
                    TrackColorMenu(track: track, model: model)
                    Text(track.bpm.map { String(format: "%.1f", $0) } ?? "—")
                        .font(.system(size: 12, weight: .semibold, design: .monospaced))
                        .accessibilityIdentifier("track.bpm.\(track.id)")
                    Text(" BPM").font(.system(size: 8)).foregroundStyle(.secondary)
                }
                HStack(spacing: 5) {
                    Text(track.key ?? "—").font(.system(size: 9, weight: .semibold, design: .monospaced))
                        .foregroundStyle(BoothStyle.background).padding(.horizontal, 4).padding(.vertical, 2)
                        .background(Color.white.opacity(0.85), in: RoundedRectangle(cornerRadius: 2))
                        .accessibilityIdentifier("track.key.\(track.id)")
                    Text(timeLabel(track.durationSeconds)).font(.system(size: 9, design: .monospaced)).foregroundStyle(.secondary)
                }
            }.fixedSize(horizontal: true, vertical: false)
        }.padding(.horizontal, 4).padding(.vertical, 7)
            .background(model.player.track?.id == track.id ? BoothStyle.accent.opacity(0.12) : .clear)
            .overlay(alignment: .bottom) { Rectangle().fill(BoothStyle.border.opacity(0.55)).frame(height: 0.5) }
            .accessibilityElement(children: .contain).accessibilityIdentifier("track.row.\(track.id)")
    }
    private var artworkSize: CGFloat {
        #if os(macOS)
        28
        #else
        36
        #endif
    }
    private var rowPadding: CGFloat {
        #if os(macOS)
        4
        #else
        6
        #endif
    }
}

#if os(macOS)
private struct TrackTableHeader: View {
    var body: some View {
        HStack(spacing: 10) {
            Text("TITLE / ARTIST").frame(maxWidth: .infinity, alignment: .leading)
            Text("WAVEFORM").frame(width: 105, alignment: .leading)
            Text("ALBUM").frame(width: 140, alignment: .leading)
            Text("BPM").frame(width: 38)
            Text("KEY").frame(width: 35)
            Spacer().frame(width: 40)
            Text("TIME").frame(width: 40)
            Spacer().frame(width: 22)
        }.font(.system(size: 9, weight: .medium, design: .monospaced)).foregroundStyle(.secondary)
            .padding(.horizontal, 8).padding(.vertical, 8).background(BoothStyle.raised)
    }
}
#endif

struct MiniPlayer: View {
    @Bindable var model: BoothModel
    var body: some View {
        HStack(spacing: 12) {
            if let track = model.player.track {
                HStack(spacing: 12) {
                    TrackArtwork(track: track, model: model, size: 42)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(track.title).font(.subheadline.weight(.semibold)).lineLimit(1)
                        Text(track.artist ?? "Unknown artist").font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    }.frame(maxWidth: .infinity, alignment: .leading)
                }
                #if os(macOS)
                Button { model.player.advance(-1) } label: { Image(systemName: "backward.end.fill") }
                #endif
                Button { Task { await model.togglePlayback() } } label: { Image(systemName: model.player.playing ? "pause.fill" : "play.fill").font(.title3) }.accessibilityLabel("Play or pause")
                Button { model.player.advance(1) } label: { Image(systemName: "forward.end.fill") }.accessibilityLabel("Next track")
                #if os(macOS)
                Slider(value: Binding(get: { min(model.player.elapsed, max(1, model.player.duration)) }, set: { model.player.seek($0) }), in: 0...max(1, model.player.duration)).frame(maxWidth: 300)
                Text(timeLabel(model.player.elapsed)).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                #endif
            } else {
                Image(systemName: "waveform").font(.title2).foregroundStyle(BoothStyle.accent)
                VStack(alignment: .leading, spacing: 3) {
                    Text("Find your next favorite").font(.subheadline.weight(.semibold))
                    Text("Choose a track to start listening").font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Image(systemName: "hifispeaker.fill").foregroundStyle(.secondary)
            }
        }.buttonStyle(.plain).padding(14).modifier(BoothGlass())
    }
}

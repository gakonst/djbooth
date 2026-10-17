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
            if let selected, let item = model.connectedPlaylist(selected.id) { ConnectedPlaylistStatus(model: model, item: item) }
            if tracks.isEmpty, let selected, let item = model.connectedPlaylist(selected.id),
               model.musicCatalog.snapshots[item.id] == nil || model.musicPlaylistLoading.contains(item.id) || model.musicPlaylistErrors[item.id] != nil {
                Spacer()
            } else if tracks.isEmpty {
                ContentUnavailableView(model.query.isEmpty ? "No tracks" : "No matching tracks", systemImage: "music.note.list",
                                       description: Text(model.filter == "Unsorted" ? "Every recording already belongs to a playlist." : model.query.isEmpty ? "Import music or add tracks to this playlist." : "Try another title, artist, or comment."))
            } else {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(Array(tracks.enumerated()), id: \.offset) { position, track in
                            TrackRow(track: track, model: model, collection: selected, queuePosition: position)
                        }
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
struct MobileGroupBrowser: View {
    @Bindable var model: BoothModel
    let mode: LibraryBrowseMode
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.colorSchemeContrast) private var contrast
    var body: some View {
        let groups = Dictionary(grouping: model.tracks) { mode.group(for: $0) }
        List {
            if groups.isEmpty {
                ContentUnavailableView("No music yet", systemImage: mode.symbol).boothLibraryCell()
            }
            ForEach(groups.keys.sorted { $0.localizedStandardCompare($1) == .orderedAscending }, id: \.self) { name in
                Button { model.browse(mode, group: name) } label: {
                    row(name, count: groups[name]?.count ?? 0)
                }.buttonStyle(BoothRowButtonStyle()).accessibilityIdentifier("library.group.\(name)")
                    .boothLibraryCell()
            }
        }.boothLibraryList().accessibilityIdentifier("library.groups")
    }
    private func row(_ name: String, count: Int) -> some View {
        let layout = typeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 8))
            : AnyLayout(HStackLayout(spacing: 12))
        return HStack(spacing: 12) {
            layout {
                Text(name).boothFont(14, relativeTo: .subheadline, weight: .semibold)
                    .foregroundStyle(.primary).lineLimit(typeSize.isAccessibilitySize ? 3 : 1)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Text("\(count) \(count == 1 ? "track" : "tracks")")
                    .boothFont(12, relativeTo: .caption, design: .monospaced).foregroundStyle(.secondary)
                    .fixedSize(horizontal: true, vertical: false)
            }
            Image(systemName: "chevron.right").font(.caption.weight(.semibold))
                .foregroundStyle(.secondary).accessibilityHidden(true)
        }.frame(minHeight: 48).padding(.horizontal, 12).padding(.vertical, 6).contentShape(Rectangle())
            .overlay(alignment: .bottom) { Rectangle().fill(contrast == .increased ? Color.secondary : BoothStyle.border).frame(height: 0.5) }
    }
}

struct MobileTrackList: View {
    @Bindable var model: BoothModel
    @State private var visibleTrackIDs = Set<String>()
    let collectionID: String?
    var groupMode: LibraryBrowseMode? = nil
    var groupName: String? = nil
    var body: some View {
        let selected = model.collections.first { $0.id == collectionID }
        let tracks = model.visibleTracks(in: collectionID, groupMode: groupMode, groupName: groupName)
        List {
            if tracks.isEmpty, let selected, let item = model.connectedPlaylist(selected.id),
               model.musicCatalog.snapshots[item.id] == nil || model.musicPlaylistLoading.contains(item.id) || model.musicPlaylistErrors[item.id] != nil {
                EmptyView()
            } else if tracks.isEmpty {
                ContentUnavailableView(model.query.isEmpty ? "No tracks" : "No matching tracks", systemImage: "magnifyingglass",
                                       description: Text(model.query.isEmpty ? "Import music to get started." : "Try another title, artist, or album."))
                    .boothLibraryCell()
            } else {
                ForEach(Array(tracks.enumerated()), id: \.offset) { position, track in
                    TrackRow(track: track, model: model, collection: selected, queuePosition: position)
                        .boothLibraryCell(horizontalInset: 8)
                        .onAppear { visibleTrackIDs.insert(track.id) }
                        .onDisappear { visibleTrackIDs.remove(track.id) }
                        .onChange(of: track.id) { old, new in
                            if visibleTrackIDs.remove(old) != nil { visibleTrackIDs.insert(new) }
                        }
                }
            }
        }.boothLibraryList().accessibilityIdentifier("library.tracks")
            .scrollDismissesKeyboard(.interactively)
            .overlay {
                if tracks.isEmpty, let selected, let item = model.connectedPlaylist(selected.id) {
                    ConnectedPlaylistStatus(model: model, item: item)
                }
            }
            .task(id: tracks.filter { visibleTrackIDs.contains($0.id) }.map(\.id)) {
                do { try await Task.sleep(for: .milliseconds(200)) } catch { return }
                await model.warmVisibleMusicStreams(tracks.filter { visibleTrackIDs.contains($0.id) }.map(\.id))
            }
            .task(id: collectionID) {
                if let collectionID, let item = model.connectedPlaylist(collectionID) { await model.loadMusicPlaylist(item) }
            }
            .refreshable {
                await model.refreshPairedMac()
                if let collectionID, let item = model.connectedPlaylist(collectionID) { await model.loadMusicPlaylist(item, force: true) }
            }
            .safeAreaInset(edge: .top, spacing: 0) {
                if collectionID == nil, groupName == nil {
                    VStack(alignment: .leading, spacing: 4) {
                        LibrarySearchField(text: $model.query, prompt: "Search all titles, artists, albums", identifier: "library.search")
                            .frame(minHeight: 44)
                            .submitLabel(.search)
                            .onSubmit { UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil) }
                        Text("\(tracks.count) tracks · \(model.trackSort == "addedAt" ? "Recently Added" : "Alphabetical")")
                            .font(.caption).foregroundStyle(.secondary)
                            .accessibilityIdentifier("library.tracks.summary")
                    }.padding(.horizontal, 12).padding(.vertical, 6).background(BoothStyle.background)
                }
            }
    }
}
#endif

struct ConnectedPlaylistStatus: View {
    @Bindable var model: BoothModel
    let item: MusicPlaylist
    var body: some View {
        #if os(iOS)
        if let error = model.musicPlaylistErrors[item.id] {
            ContentUnavailableView {
                Label("Couldn’t load tracks", systemImage: "wifi.exclamationmark")
                    .accessibilityIdentifier("music.playlist.error")
            } description: {
                Text(error)
            } actions: {
                Button("Retry") { Task { await model.loadMusicPlaylist(item, force: true) } }
                    .accessibilityIdentifier("music.playlist.retry")
            }
        } else if model.musicPlaylistLoading.contains(item.id) || model.musicCatalog.snapshots[item.id] == nil {
            ProgressView().accessibilityElement(children: .ignore).accessibilityLabel("Loading tracks")
                .accessibilityIdentifier("music.playlist.loading")
        }
        #else
        if let error = model.musicPlaylistErrors[item.id] {
            VStack(alignment: .leading, spacing: 12) {
                Label("Couldn’t load playlist", systemImage: "exclamationmark.circle").font(.headline).accessibilityIdentifier("music.playlist.error")
                Text(error).font(.subheadline).foregroundStyle(.secondary)
                Button("Retry") { Task { await model.loadMusicPlaylist(item, force: true) } }
                    .accessibilityIdentifier("music.playlist.retry")
            }.padding()
        } else if model.musicPlaylistLoading.contains(item.id) || model.musicCatalog.snapshots[item.id] == nil {
            ProgressView(model.musicCatalog.snapshots[item.id] == nil ? "Loading tracks…" : "Refreshing playlist…")
                .frame(maxWidth: .infinity).padding(28).accessibilityIdentifier("music.playlist.loading")
        }
        #endif
    }
}

struct TrackRow: View {
    let track: Track
    @Bindable var model: BoothModel
    var collection: Collection? = nil
    var sharedPlaylist = false
    var contributor: CrewMember? = nil
    var contributorItemID: String? = nil
    var removeSharedTrack: (() -> Void)? = nil
    var preservingQueue = false
    var queuePosition: Int? = nil
    @State private var editingAnnotation = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.colorSchemeContrast) private var contrast
    @Environment(\.accessibilityDifferentiateWithoutColor) private var differentiateWithoutColor
    var body: some View {
        SwipeRow(left: leftSwipe, right: rightSwipe, identity: track.id) { activation in rowContent(activation: activation) }
            .task(id: track.id) {
                if track.id.hasPrefix("usb:"), track.waveform == nil { await model.loadWaveform(track) }
            }
            .sheet(isPresented: $editingAnnotation) { TrackAnnotationEditor(track: track, model: model) }
            .contextMenu {
                // Leave the row's hold gesture to native List reordering.
                if !sharedPlaylist { trackContextActions }
            }
            .accessibilityActions {
                if !track.id.hasPrefix("paired:") {
                    Button("Comment & color") { editingAnnotation = true }
                    Button("Add to playlist") { model.choosePlaylist(for: track) }
                }
                offlineAction
            }
    }
    private var offlineAction: some View {
        let saved = model.offlineIDs.contains(track.id)
        let downloading = model.downloading.contains(track.id)
        return Button(saved ? "On this device" : downloading ? "Downloading…" : "Keep on this device",
                      systemImage: saved ? "checkmark.circle" : "arrow.down.circle") {
            Task { await model.keepOffline(track) }
        }.disabled(saved || model.demo || downloading)
            .accessibilityIdentifier("track.download.\(track.id)")
    }
    @ViewBuilder private var trackContextActions: some View {
        if !track.id.hasPrefix("paired:") {
        if let removeSharedTrack { Button("Remove from shared playlist", role: .destructive, action: removeSharedTrack) }
        Button("Comment & color") { editingAnnotation = true }
        Button(model.favorites.contains(track.id) ? "Remove from favorites" : "Add to favorites") { model.favorite(track) }
        Button("Add to playlist") { model.choosePlaylist(for: track) }
        if let collection, let position = collection.trackIDs.firstIndex(of: track.id) {
            if position > 0 { Button("Move earlier") { model.move(track, in: collection, by: -1) } }
            if position < collection.trackIDs.count - 1 { Button("Move later") { model.move(track, in: collection, by: 1) } }
            Button("Remove from playlist", role: .destructive) { model.requestRemoval(track, from: collection) }
        }
        } else {
            Text("Read-only · edit on your Mac")
        }
        offlineAction
        #if os(iOS)
        ForEach(model.djLink.detectedDecks) { device in
            let playing = model.djLink.decks.first(where: { $0.id == device.player })?.state.playing
            let reason = !model.offlineIDs.contains(track.id) ? "download first" :
                playing == true ? "pause first" : playing == nil ? "waiting for deck" :
                model.djLink.loadingTrackID != nil ? "loading" : nil
            Button("Load on \(model.djLink.playerLabel(device.player))\(reason.map { " · \($0)" } ?? "")") {
                Task { _ = await model.djLink.load(track, on: device, model: model) }
            }
            .disabled(reason != nil)
            .accessibilityIdentifier("track.load.\(device.player)")
        }
        #endif
    }
    private var leftSwipe: RowSwipeAction? {
        if track.id.hasPrefix("paired:") { return nil }
        if sharedPlaylist {
            return removeSharedTrack.map { action in RowSwipeAction(title: "Remove", symbol: "minus", color: .pink, perform: action) }
        }
        if let collection {
            return RowSwipeAction(title: "Remove", symbol: "minus", color: .pink) {
                model.requestRemoval(track, from: collection)
            }
        } else {
            return RowSwipeAction(title: "Archive", symbol: "archivebox", color: .orange) {
                withAnimation(reduceMotion ? nil : .easeOut(duration: 0.16)) { model.archive(track) }
            }
        }
    }
    private var rightSwipe: RowSwipeAction? {
        if track.id.hasPrefix("paired:") {
            return RowSwipeAction(title: "Keep offline", symbol: "arrow.down.circle", color: .green) {
                Task { await model.keepOffline(track) }
            }
        }
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
                Task { await model.play(track, preservingQueue: preservingQueue, queuePosition: queuePosition) }
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
            }.buttonStyle(.plain).disabled(track.id.hasPrefix("paired:"))
                .accessibilityLabel(model.favorites.contains(track.id) ? "Unfavorite \(track.title)" : "Favorite \(track.title)")
            #if os(macOS)
            Text(timeLabel(track.durationSeconds)).font(.caption.monospacedDigit()).foregroundStyle(.secondary).frame(width: 40)
            #endif
            Menu {
                Button("Comment & color", systemImage: "square.and.pencil") { editingAnnotation = true }
                    .disabled(track.id.hasPrefix("paired:"))
                offlineAction
                Menu("Add to playlist") {
                    ForEach(model.collections.filter { !$0.id.hasPrefix("paired:") }) { collection in Button(collection.name) { model.add(track, to: collection) } }
                    Button("New playlist…") { model.showNewCollection = true }
                }.disabled(track.id.hasPrefix("paired:"))
                if let collection, !collection.id.hasPrefix("paired:") {
                    Button("Remove from playlist", role: .destructive) { model.requestRemoval(track, from: collection) }
                    Button("Move earlier", systemImage: "arrow.up") { model.move(track, in: collection, by: -1) }
                    Button("Move later", systemImage: "arrow.down") { model.move(track, in: collection, by: 1) }
                } else if !track.id.hasPrefix("paired:") {
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
        let selected = model.player.track?.id == track.id
        return VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                if track.id.hasPrefix("paired:") { TrackArtwork(track: track, model: model, size: 32) }
                Button {
                    guard activation.canActivate() else { return }
                    Task { await model.play(track, preservingQueue: preservingQueue, queuePosition: queuePosition) }
                } label: {
                    AnalysisWaveform(waveform: track.waveform, initialColumns: model.initialWaveformColumns[track.id], compact: true)
                        .frame(width: 64, height: 40).allowsHitTesting(false)
                        .frame(minHeight: 44).contentShape(Rectangle())
                }.buttonStyle(BoothRowButtonStyle()).accessibilityLabel("Play \(track.title)")
                    .accessibilityIdentifier("track.waveform.\(track.id)")
                mobileTrackTitle(activation: activation, selected: selected)
                if !typeSize.isAccessibilitySize { mobileTrackMetadata }
                #if os(iOS)
                if !model.djLink.detectedDecks.isEmpty {
                    Menu { trackContextActions } label: {
                        Image(systemName: "ellipsis").frame(width: 36, height: 44)
                    }.accessibilityLabel("Options for \(track.title)")
                        .accessibilityIdentifier("track.options.\(track.id)")
                }
                #endif
            }
            if typeSize.isAccessibilitySize {
                mobileTrackMetadata.frame(maxWidth: .infinity, alignment: .trailing)
            }
        }.padding(.horizontal, 4).padding(.vertical, 7)
            .background(selected ? BoothStyle.accent.opacity(contrast == .increased ? 0.24 : 0.12) : .clear)
            .overlay(alignment: .leading) { if selected { Rectangle().fill(BoothStyle.accent).frame(width: 2) } }
            .overlay(alignment: .bottom) { Rectangle().fill(contrast == .increased ? Color.secondary : BoothStyle.border).frame(height: 0.5) }
            .accessibilityElement(children: .contain).accessibilityIdentifier("track.row.\(track.id)")
    }
    private func mobileTrackTitle(activation: RowSwipeActivation, selected: Bool) -> some View {
        let annotation = model.annotation(for: track)
        return Button {
            guard activation.canActivate() else { return }
            Task { await model.play(track, preservingQueue: preservingQueue, queuePosition: queuePosition) }
        } label: {
            VStack(alignment: .leading, spacing: 3) {
                Text(track.title).boothFont(14, relativeTo: .subheadline, weight: .semibold)
                    .lineLimit(typeSize.isAccessibilitySize ? 2 : 1)
                HStack(spacing: 4) {
                    if selected { Image(systemName: "speaker.wave.2.fill").foregroundStyle(BoothStyle.accent).accessibilityHidden(true) }
                    else if model.offlineIDs.contains(track.id) { Image(systemName: "checkmark.circle.fill").foregroundStyle(BoothStyle.mint).accessibilityHidden(true) }
                    Text(track.artist ?? "Unknown artist").lineLimit(typeSize.isAccessibilitySize ? 2 : 1)
                }.boothFont(11, relativeTo: .caption2).foregroundStyle(.secondary)
                if !annotation.note.isEmpty {
                    Text(annotation.note).boothFont(11, relativeTo: .caption2)
                        .foregroundStyle(contrast == .increased ? Color.primary : annotation.color?.tint ?? .secondary)
                        .lineLimit(typeSize.isAccessibilitySize ? 2 : 1).accessibilityIdentifier("track.note.\(track.id)")
                }
            }.frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).contentShape(Rectangle())
        }.buttonStyle(BoothRowButtonStyle()).accessibilityLabel("Play \(track.title)")
            .accessibilityValue("\(track.artist ?? "Unknown artist"), \(selected ? "Current track, " : "")\(model.offlineIDs.contains(track.id) ? "Available offline" : "Not on this device")")
    }
    private var mobileTrackMetadata: some View {
        let color = model.annotation(for: track).color
        return VStack(alignment: .trailing, spacing: 4) {
            HStack(spacing: 3) {
                #if os(iOS)
                if let contributorItemID { CrewContributorBadge(member: contributor, itemID: contributorItemID, compact: true) }
                #endif
                Text(track.bpm.map { String(format: "%.1f", $0) } ?? "—")
                    .boothFont(12, relativeTo: .caption, weight: .semibold, design: .monospaced)
                    .accessibilityIdentifier("track.bpm.\(track.id)")
                Text("BPM").boothFont(11, relativeTo: .caption2).foregroundStyle(.secondary)
            }
            HStack(spacing: 6) {
                if let color {
                    HStack(spacing: 3) {
                        Rectangle().fill(color.tint).frame(width: 6, height: 12)
                        if differentiateWithoutColor {
                            Text(String(color.label.prefix(1)))
                                .boothFont(11, relativeTo: .caption2, weight: .semibold, design: .monospaced)
                                .foregroundStyle(.primary)
                        }
                    }.accessibilityHidden(true).allowsHitTesting(false)
                }
                Text(track.key ?? "—").boothFont(11, relativeTo: .caption2, weight: .semibold, design: .monospaced)
                    .fixedSize(horizontal: true, vertical: false)
                    .foregroundStyle(.primary).padding(.horizontal, 5).padding(.vertical, 2)
                    .background(BoothStyle.raised, in: RoundedRectangle(cornerRadius: 3))
                    .overlay(RoundedRectangle(cornerRadius: 3).stroke(contrast == .increased ? Color.primary : Color.secondary.opacity(0.55), lineWidth: 0.5))
                    .accessibilityIdentifier("track.key.\(track.id)")
                    .accessibilityValue(color.map { "\($0.label) color" } ?? "")
                Text(timeLabel(track.durationSeconds)).boothFont(11, relativeTo: .caption2, design: .monospaced).foregroundStyle(.secondary)
                    .fixedSize(horizontal: true, vertical: false)
            }
        }.fixedSize(horizontal: true, vertical: false)
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

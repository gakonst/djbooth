import SwiftUI
import DJBoothKit

struct PlaylistBrowserView: View {
    @Bindable var model: BoothModel
    var folderPath: [String]? = nil
    private var path: [String] { folderPath ?? model.playlistFolderPath }
    private var musicProvider: String? { path.first.flatMap { model.musicProviderNames.contains($0) ? $0 : nil } }
    private var showsEmptyState: Bool {
        #if os(iOS)
        if path.isEmpty && (!model.musicProviderNames.isEmpty || model.usbConnected) { return false }
        if let provider = musicProvider, model.musicLoading || model.musicFolderError(provider) != nil { return false }
        #endif
        return true
    }
    #if os(macOS)
    @State private var search = ""
    #endif
    @State private var pendingDelete: Collection?
    @State private var editing: Collection?
    @State private var showUSBLibrary = false
    @State private var refreshError: String?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.colorSchemeContrast) private var contrast
    private var animation: Animation? { reduceMotion ? nil : .easeOut(duration: 0.16) }
    private var searching: Bool {
        #if os(macOS)
        !search.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        #else
        false
        #endif
    }
    private var sorted: [Collection] {
        #if os(macOS)
        let terms = search.lowercased().split(whereSeparator: \.isWhitespace)
        return model.collections.filter { collection in
            let text = ([collection.name, collection.mood ?? ""] + (collection.folderPath ?? [])).joined(separator: " ").lowercased()
            return terms.allSatisfy { text.contains($0) }
        }.sorted { first, second in
            let comparison: ComparisonResult
            switch model.playlistSort {
            case "createdAt": comparison = (first.createdAt ?? "").compare(second.createdAt ?? "")
            case "updatedAt": comparison = (first.updatedAt ?? "").compare(second.updatedAt ?? "")
            default: comparison = first.name.localizedStandardCompare(second.name)
            }
            if comparison == .orderedSame { return first.id < second.id }
            return model.playlistSortAscending ? comparison == .orderedAscending : comparison == .orderedDescending
        }
        #else
        return model.playlistCollections
        #endif
    }
    private func browserRows(from sorted: [Collection]) -> [PlaylistBrowserRow] {
        let searching = self.searching
        let path = self.path
        var pinnedPlaylists: [Collection] = []
        var visiblePlaylists: [Collection] = []
        var folderCounts: [String: Int] = [:]
        // One sorted snapshot feeds every section; pinning keeps the same row identity.
        for collection in sorted {
            if searching { visiblePlaylists.append(collection); continue }
            let collectionPath = collection.folderPath ?? []
            if collection.isPinned == true { pinnedPlaylists.append(collection) }
            else if collectionPath == path { visiblePlaylists.append(collection) }
            guard collectionPath.count > path.count,
                  collectionPath.starts(with: path) else { continue }
            let name = collectionPath[path.count]
            #if os(iOS)
            // The connected device has one named entry, not a second folder row.
            if path.isEmpty, model.pendingQuickAddTrackID == nil, name == model.usbDevice?.folderName { continue }
            if path.isEmpty, model.musicProviderNames.contains(name) { continue }
            #endif
            folderCounts[name, default: 0] += 1
        }
        let visibleFolders = folderCounts.sorted { $0.key.localizedStandardCompare($1.key) == .orderedAscending }
        var rows: [PlaylistBrowserRow] = []
        rows.reserveCapacity(pinnedPlaylists.count + visiblePlaylists.count + visibleFolders.count + 2)
        #if os(iOS)
        if model.pendingQuickAddTrackID != nil { rows.append(.cancelQuickAdd) }
        #endif
        #if os(iOS)
        if folderPath == nil, !searching, let folder = path.last { rows.append(.back(folder)) }
        #else
        if !searching, let folder = path.last { rows.append(.back(folder)) }
        #endif
        if !pinnedPlaylists.isEmpty {
            #if os(macOS)
            rows.append(.pinnedHeader)
            #endif
            rows.append(contentsOf: pinnedPlaylists.map(PlaylistBrowserRow.playlist))
        }
        rows.append(contentsOf: visibleFolders.map { .folder(name: $0.key, count: $0.value) })
        rows.append(contentsOf: visiblePlaylists.map(PlaylistBrowserRow.playlist))
        if pinnedPlaylists.isEmpty && visibleFolders.isEmpty && visiblePlaylists.isEmpty { rows.append(.empty) }
        return rows
    }
    var body: some View {
        let sorted = self.sorted
        let rows = browserRows(from: sorted)
        let empty = rows.contains { if case .empty = $0 { return true }; return false }
        VStack(spacing: 0) {
            #if os(macOS)
            VStack(spacing: 10) {
                HStack {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(model.pendingQuickAddTrackID == nil ? "Playlists" : "Add to playlist").font(.headline)
                        Text("\(model.collections.count) playlists · \(model.collections.reduce(0) { $0 + $1.trackIDs.count }) tracks total")
                            .font(.caption2).foregroundStyle(.secondary)
                    }
                    Spacer()
                    if model.pendingQuickAddTrackID != nil {
                        Button("Cancel") { model.cancelQuickAdd() }.font(.caption).accessibilityIdentifier("playlist.picker.cancel")
                    }
                    Button { model.showNewCollection = true } label: { Image(systemName: "plus") }
                        .accessibilityLabel("New playlist").accessibilityIdentifier("playlist.create")
                }
                LibrarySearchField(text: $search, prompt: "Search playlists", identifier: "playlist.search")
                HStack(spacing: 5) {
                    sortButton("A–Z", field: "title")
                    sortButton("Created", field: "createdAt")
                    sortButton("Modified", field: "updatedAt")
                    Button("Reset") { model.playlistSort = "title"; model.playlistSortAscending = true }
                        .font(.system(size: 10)).frame(maxWidth: .infinity).padding(.vertical, 6)
                        .overlay(Rectangle().stroke(BoothStyle.border)).accessibilityIdentifier("playlist.sort.reset")
                }.buttonStyle(.plain)
            }.padding(12)
            #endif
            #if os(iOS)
            ZStack {
            List {
                if path.isEmpty {
                    ForEach(model.crews) { crew in
                        LibraryNavigationButton { model.openCrewFolder(crew.id) } label: {
                            browserNavigationRow(title: crew.name,
                                                 detail: "\(crew.crateCount) playlists · \(crew.memberCount) members", symbol: "folder.badge.person.crop")
                        }.buttonStyle(.plain).boothLibraryCell()
                            .disabled(model.pendingQuickAddTrackID != nil && !crew.role.canEdit)
                            .accessibilityIdentifier("crew.folder.\(crew.id)")
                    }
                    if model.crewsLoading && model.crews.isEmpty { ProgressView("Loading shared folders").boothLibraryCell() }
                }
                if path.isEmpty, model.pendingQuickAddTrackID == nil, model.usbConnected, let device = model.usbDevice {
                    Button {
                        model.openPlaylistFolder([device.folderName])
                    } label: {
                        browserNavigationRow(title: device.name, detail: "USB · Connected", symbol: "externaldrive")
                    }.buttonStyle(.plain).accessibilityIdentifier("usb.open")
                        .accessibilityValue(model.usbConnected ? "Connected" : "Disconnected")
                        .contextMenu { Button("Choose USB folder") { showUSBLibrary = true } }
                        .boothLibraryCell()
                }
                if path.isEmpty, model.pendingQuickAddTrackID == nil {
                    ForEach(model.musicProviderNames, id: \.self) { name in
                        LibraryNavigationButton { model.openPlaylistFolder([name]) } label: {
                            let count = model.musicCatalog.playlists.filter { item in model.musicCatalog.sources.contains { $0.id == item.sourceID && $0.providerName == name } }.count
                            browserNavigationRow(title: name, detail: "\(count) playlists", symbol: "folder")
                        }.buttonStyle(.plain).boothLibraryCell().accessibilityIdentifier("music.source.\(name)")
                    }
                }
                browserContent(rows).boothLibraryCell()
            }.boothLibraryList().accessibilityIdentifier("playlist.browser")
            if empty { musicFolderStatus }
            }
            #else
            ScrollView(.vertical, showsIndicators: true) {
                LazyVStack(spacing: 0) { browserContent(rows) }
                    .animation(animation, value: sorted.map { "\($0.id):\($0.isPinned == true)" })
            }
            #endif
        }
        #if os(macOS)
        .accessibilityIdentifier("playlist.browser")
        #endif
        .task { await model.refreshCrews() }
        .task(id: path.first) { await model.refreshMusic(provider: musicProvider) }
        .refreshable {
            await model.refreshCrews()
            await model.refreshMusic(force: true, provider: musicProvider)
            if let provider = musicProvider, !empty {
                refreshError = model.musicFolderError(provider)
            }
        }
        .alert("Couldn’t refresh playlists", isPresented: Binding(get: { refreshError != nil }, set: { if !$0 { refreshError = nil } })) {
            Button("OK", role: .cancel) { refreshError = nil }
        } message: { Text(refreshError ?? "") }
        .sheet(item: $editing) { PlaylistEditSheet(collection: $0, model: model) }
        .sheet(isPresented: $showUSBLibrary) { USBLibraryView(model: model) }
        .alert("Delete playlist?", isPresented: Binding(get: { pendingDelete != nil }, set: { if !$0 { pendingDelete = nil } }), presenting: pendingDelete) { collection in
            Button("Delete playlist", role: .destructive) { withAnimation(animation) { model.deleteCollection(collection) }; pendingDelete = nil }
            Button("Cancel", role: .cancel) { pendingDelete = nil }
        } message: { collection in Text("Delete ‘\(collection.name)’? Its recordings stay in your library.") }
    }
    private func browserContent(_ rows: [PlaylistBrowserRow]) -> some View {
        let trackMap = model.tracksByID
        return ForEach(rows) { item in
                        switch item {
                        case .cancelQuickAdd:
                            Button { model.cancelQuickAdd() } label: {
                                browserNavigationRow(title: "Cancel", detail: "Add to playlist", symbol: "xmark")
                            }.buttonStyle(BoothRowButtonStyle()).accessibilityIdentifier("playlist.picker.cancel")
                        case .back(let title):
                            LibraryNavigationButton {
                                guard !path.isEmpty else { return }
                                model.openPlaylistFolder(Array(path.dropLast()))
                            } label: {
                                browserNavigationRow(title: title, detail: "Up one level", symbol: "arrow.left")
                            }.buttonStyle(BoothRowButtonStyle()).accessibilityIdentifier("playlist.folder.back")
                        case .pinnedHeader:
                            Text("PINNED").font(.system(size: 9, weight: .semibold, design: .monospaced)).tracking(1)
                                .foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 12).padding(.vertical, 8)
                        case .folder(let name, let count):
                            LibraryNavigationButton {
                                model.openPlaylistFolder(path + [name])
                            } label: {
                                browserNavigationRow(title: name, detail: "\(count) playlists", symbol: "folder")
                            }.buttonStyle(BoothRowButtonStyle()).accessibilityIdentifier("playlist.folder.\(name)")
                        case .playlist(let collection):
                            if let item = model.connectedPlaylist(collection.id) { connectedRow(collection, item: item) }
                            else { row(collection, trackMap: trackMap) }
                        case .empty:
                            #if os(iOS)
                            if path.isEmpty && !model.crews.isEmpty {
                                Button("New playlist", systemImage: "plus") { model.showNewCollection = true }
                                    .accessibilityIdentifier("playlist.empty.create")
                            } else { emptyPlaylists }
                            #else
                            emptyPlaylists
                            #endif
                        }
                    }
    }
    @ViewBuilder private var emptyPlaylists: some View {
        if showsEmptyState {
            ContentUnavailableView {
                Label(searching ? "No matching playlists" : "No playlists here", systemImage: "music.note.list")
            } description: {
                Text(searching ? "Try another title or mood." : musicProvider != nil ? "Your playlists will appear here. Manage your connected account in Settings." : "Create a playlist to organize your music.")
            } actions: {
                if !searching && musicProvider == nil {
                    Button("New playlist") { model.showNewCollection = true }
                        .accessibilityIdentifier("playlist.empty.create")
                }
            }
        }
    }
    @ViewBuilder private var musicFolderStatus: some View {
        if let provider = musicProvider {
            if model.musicLoading {
                ProgressView().accessibilityElement(children: .ignore).accessibilityLabel("Loading playlists")
                    .accessibilityIdentifier("music.folder.loading")
            } else if let error = model.musicFolderError(provider) {
                ContentUnavailableView {
                    Label("Couldn’t load playlists", systemImage: "wifi.exclamationmark")
                        .accessibilityIdentifier("music.folder.error")
                } description: {
                    Text(error)
                } actions: {
                    Button("Retry") { Task { await model.refreshMusic(force: true, provider: provider) } }
                        .accessibilityIdentifier("music.folder.retry")
                }
            }
        }
    }
    private func connectedRow(_ collection: Collection, item: MusicPlaylist) -> some View {
        let downloaded = model.musicIsDownloaded(item)
        return HStack(spacing: 12) {
            LibraryNavigationButton { model.openCollection(collection) } label: {
                VStack(alignment: .leading, spacing: 4) {
                    Text(item.name).lineLimit(1)
                    Text("\(downloaded ? collection.trackIDs.count : item.trackCount) tracks\(downloaded ? "" : " · Stream")").font(.caption).foregroundStyle(.secondary)
                }.frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 8)
            }.buttonStyle(.plain).accessibilityIdentifier("music.playlist.\(item.remoteID)")
            if model.musicDownloads.contains(item.id) || model.musicPlaylistLoading.contains(item.id) { ProgressView() }
            if downloaded {
                Image(systemName: "checkmark").foregroundStyle(.secondary)
                    .accessibilityLabel("Downloaded")
                    .accessibilityIdentifier("music.downloaded.\(item.remoteID)")
            } else {
                Button { Task { await model.downloadMusic(item) } } label: { Image(systemName: "arrow.down.circle") }
                    .disabled(model.musicDownloads.contains(item.id)).accessibilityLabel("Download playlist")
                    .accessibilityIdentifier("music.download.\(item.remoteID)")
            }
        }.padding(.horizontal, 12).contextMenu {
            if downloaded {
                Button("Keep playlist on this phone") { Task { await model.keepCollectionOffline(collection) } }
            }
            Button("Refresh playlist") { Task { await model.loadMusicPlaylist(item, force: true) } }
            if let url = URL(string: item.url) { Link("Open original playlist", destination: url) }
            if let source = model.musicCatalog.sources.first(where: { $0.id == item.sourceID }), source.provider == "spotify" {
                Button("Enable Spotify streaming") { model.beginSpotifySignIn(source) }
            }
        }
    }
    private func sortButton(_ title: String, field: String) -> some View {
        Button {
            if model.playlistSort == field { model.playlistSortAscending.toggle() }
            else { model.playlistSort = field; model.playlistSortAscending = field == "title" }
        } label: {
            HStack(spacing: 3) {
                Text(title)
                if model.playlistSort == field { Image(systemName: model.playlistSortAscending ? "arrow.up" : "arrow.down") }
            }.font(.system(size: 10)).frame(maxWidth: .infinity).padding(.vertical, 6)
                .background(model.playlistSort == field ? Color.white.opacity(0.08) : Color.clear)
                .overlay(Rectangle().stroke(BoothStyle.border))
        }.accessibilityIdentifier("playlist.sort.\(field)")
    }
    private func row(_ collection: Collection, trackMap: [String: Track]) -> some View {
        var duration = 0.0
        var lowerBPM: Double?, upperBPM: Double?
        #if os(macOS)
        var waveform: Waveform?
        #endif
        for id in collection.trackIDs {
            guard let track = trackMap[id] else { continue }
            duration += track.durationSeconds ?? 0
            if let bpm = track.bpm, bpm.isFinite, bpm > 0 {
                lowerBPM = min(lowerBPM ?? bpm, bpm)
                upperBPM = max(upperBPM ?? bpm, bpm)
            }
            #if os(macOS)
            if waveform == nil, let value = track.waveform, value.source == "rekordbox", !value.peaks.isEmpty { waveform = value }
            #endif
        }
        let pin = collection.isPinned == true ? "Unpin playlist" : "Pin playlist"
        let deleteSwipe = RowSwipeAction(title: "Delete", symbol: "trash", color: .pink) { pendingDelete = collection }
        return SwipeRow(
            left: deleteSwipe,
            right: RowSwipeAction(title: pin, symbol: collection.isPinned == true ? "pin.slash" : "pin", color: .cyan) {
                withAnimation(animation) { model.togglePin(collection) }
            }, maximum: 140, identity: collection.id
        ) { activation in
            HStack(spacing: 8) {
                LibraryNavigationButton {
                    guard activation.canActivate() else { return }
                    withAnimation(animation) { model.openCollection(collection) }
                } label: {
                    #if os(iOS)
                    mobilePlaylistLabel(collection, duration: duration, lowerBPM: lowerBPM, upperBPM: upperBPM)
                    #else
                    HStack(spacing: 10) {
                        #if os(macOS)
                        Group {
                            if let waveform {
                                AnalysisWaveform(waveform: waveform, compact: true)
                                    .accessibilityIdentifier("playlist.waveform.\(collection.id)")
                            } else {
                                Text(String(collection.name.prefix(1)).uppercased()).font(.system(size: 13, weight: .semibold))
                            }
                        }.frame(width: 64, height: 36).allowsHitTesting(false)
                            .background(BoothStyle.surface).overlay(Rectangle().stroke(BoothStyle.border))
                        #endif
                        VStack(alignment: .leading, spacing: 4) {
                            HStack(spacing: 4) {
                                Text(collection.name).font(.system(size: 13, weight: .semibold)).lineLimit(1)
                                if collection.isPinned == true { Image(systemName: "pin.fill").font(.system(size: 9)).foregroundStyle(.cyan) }
                            }
                            let detail = [collection.mood ?? "", (collection.folderPath ?? []).joined(separator: " / ")].filter { !$0.isEmpty }.joined(separator: " · ")
                            #if os(macOS)
                            Text(detail.isEmpty ? "Playlist" : detail).font(.system(size: 10)).foregroundStyle(.secondary).lineLimit(1)
                            #else
                            if !detail.isEmpty { Text(detail).font(.system(size: 10)).foregroundStyle(.secondary).lineLimit(1) }
                            #endif
                        }.frame(maxWidth: .infinity, alignment: .leading)
                        VStack(alignment: .trailing, spacing: 4) {
                            #if os(macOS)
                            Text("\(collection.trackIDs.count) tracks").font(.system(size: 11, weight: .semibold))
                            #endif
                            Text(durationLabel(duration)).font(.system(size: 9, design: .monospaced))
                                .foregroundStyle(BoothStyle.background).padding(.horizontal, 5).padding(.vertical, 2).background(.white.opacity(0.85))
                            if let lower = lowerBPM, let upper = upperBPM {
                                Text(lower.rounded() == upper.rounded() ? "\(Int(lower.rounded())) BPM" : "\(Int(lower.rounded()))–\(Int(upper.rounded())) BPM")
                                    .font(.system(size: 8, design: .monospaced)).foregroundStyle(.secondary)
                                    .accessibilityIdentifier("playlist.bpm.\(collection.id)")
                            }
                        }
                    }.frame(minHeight: 36).contentShape(Rectangle())
                    #endif
                }.buttonStyle(BoothRowButtonStyle()).accessibilityIdentifier("playlist.row.\(collection.id)")
                    .accessibilityValue(collection.isPinned == true ? "Pinned" : "Not pinned")
                    .accessibilityAction(named: Text("Edit playlist")) { editing = collection }
                    .accessibilityAction(named: Text("Keep playlist offline")) { Task { await model.keepCollectionOffline(collection) } }
                    #if os(iOS)
                    .contextMenu {
                        Button("Edit playlist", systemImage: "pencil") { editing = collection }
                        Button("New playlist", systemImage: "plus") { model.showNewCollection = true }
                        Button(pin, systemImage: "pin") { model.togglePin(collection) }
                        Button("Keep playlist offline", systemImage: "arrow.down.circle") { Task { await model.keepCollectionOffline(collection) } }
                        Button("Delete playlist", systemImage: "trash", role: .destructive) { pendingDelete = collection }
                    }
                    #else
                    .onLongPressGesture(minimumDuration: 0.55) { editing = collection }
                    #endif
                #if os(macOS)
                Menu {
                    Button("Edit playlist", systemImage: "pencil") { editing = collection }
                    Button(pin, systemImage: "pin") { model.togglePin(collection) }
                    Button("Keep playlist offline", systemImage: "arrow.down.circle") { Task { await model.keepCollectionOffline(collection) } }
                    Button("Delete playlist", systemImage: "trash", role: .destructive) { pendingDelete = collection }
                } label: { Image(systemName: "ellipsis").frame(width: 22, height: 42) }
                    .menuStyle(.borderlessButton).accessibilityLabel("Options for playlist \(collection.name)")
                #endif
            }.padding(.horizontal, 12).padding(.vertical, 6)
                .overlay(alignment: .bottom) { Rectangle().fill(contrast == .increased ? Color.secondary : BoothStyle.border).frame(height: 0.5) }
        }
    }
    private func mobilePlaylistLabel(_ collection: Collection, duration: Double, lowerBPM: Double?, upperBPM: Double?) -> some View {
        PlaylistRowLabel(id: collection.id, title: collection.name,
            detail: [collection.mood ?? "", (collection.folderPath ?? []).joined(separator: " / ")].filter { !$0.isEmpty }.joined(separator: " · "),
            pinned: collection.isPinned == true, summary: durationLabel(duration), lowerBPM: lowerBPM, upperBPM: upperBPM)
    }
    private func browserNavigationRow(title: String, detail: String, symbol: String) -> some View {
        let folder = symbol.hasPrefix("folder") || symbol == "externaldrive"
        return HStack(spacing: 10) {
            if !folder {
                Image(systemName: symbol).font(.body).foregroundStyle(.secondary).frame(width: 32).accessibilityHidden(true)
            }
            VStack(alignment: .leading, spacing: 3) {
                Text(title).boothFont(14, relativeTo: .subheadline, weight: .semibold)
                    .foregroundStyle(.primary).lineLimit(typeSize.isAccessibilitySize ? 2 : 1)
                #if os(macOS)
                Text(detail).font(.system(size: 10)).foregroundStyle(.secondary)
                #endif
            }.frame(maxWidth: .infinity, alignment: .leading)
            Image(systemName: folder ? symbol : "chevron.right")
                .font(.body).foregroundStyle(.secondary).frame(width: 20).accessibilityHidden(true)
        }.frame(minHeight: 48).padding(.horizontal, 12).padding(.vertical, 6).contentShape(Rectangle())
            .overlay(alignment: .bottom) { Rectangle().fill(contrast == .increased ? Color.secondary : BoothStyle.border).frame(height: 0.5) }
    }
    private func durationLabel(_ seconds: Double) -> String {
        let minutes = Int(max(0, seconds.isFinite ? seconds : 0) / 60)
        return minutes >= 60 ? "\(minutes / 60)h \(minutes % 60)m" : "\(minutes)m"
    }
}

private struct PlaylistRowLabel: View {
    let id: String
    let title: String
    var detail = ""
    var pinned = false
    let summary: String
    var lowerBPM: Double? = nil
    var upperBPM: Double? = nil
    var trailingSymbol = "chevron.right"
    @Environment(\.dynamicTypeSize) private var typeSize
    var body: some View {
        let layout = typeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 8))
            : AnyLayout(HStackLayout(spacing: 12))
        HStack(spacing: 12) {
            layout {
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 5) {
                        Text(title).boothFont(14, relativeTo: .subheadline, weight: .semibold)
                            .foregroundStyle(.primary).lineLimit(typeSize.isAccessibilitySize ? 3 : 1)
                        if pinned {
                            Image(systemName: "pin.fill").font(.caption).foregroundStyle(BoothStyle.accent).accessibilityHidden(true)
                        }
                    }
                    if !detail.isEmpty {
                        Text(detail).boothFont(11, relativeTo: .caption2).foregroundStyle(.secondary)
                            .lineLimit(typeSize.isAccessibilitySize ? 2 : 1)
                    }
                }.frame(maxWidth: .infinity, alignment: .leading)
                VStack(alignment: typeSize.isAccessibilitySize ? .leading : .trailing, spacing: 4) {
                    Text(summary).boothFont(12, relativeTo: .caption, design: .monospaced).foregroundStyle(.primary)
                    if let lower = lowerBPM, let upper = upperBPM {
                        Text(lower.rounded() == upper.rounded() ? "\(Int(lower.rounded())) BPM" : "\(Int(lower.rounded()))–\(Int(upper.rounded())) BPM")
                            .boothFont(11, relativeTo: .caption2, design: .monospaced).foregroundStyle(.secondary)
                            .accessibilityIdentifier("playlist.bpm.\(id)")
                    }
                }.fixedSize(horizontal: true, vertical: false)
            }
            Image(systemName: trailingSymbol).font(.caption.weight(.semibold)).foregroundStyle(.secondary).accessibilityHidden(true)
        }.frame(minHeight: 48).contentShape(Rectangle())
    }
}

private enum PlaylistBrowserRow: Identifiable {
    case cancelQuickAdd
    case back(String)
    case pinnedHeader
    case folder(name: String, count: Int)
    case playlist(Collection)
    case empty

    var id: String {
        switch self {
        case .cancelQuickAdd: "navigation:cancelQuickAdd"
        case .back: "navigation:back"
        case .pinnedHeader: "heading:pinned"
        case .folder(let name, _): "folder:\(name)"
        case .playlist(let collection): "playlist:\(collection.id)"
        case .empty: "placeholder:empty"
        }
    }
}

struct PlaylistEditSheet: View {
    let collection: Collection
    @Bindable var model: BoothModel
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var mood = ""
    @State private var folder = ""
    var body: some View {
        NavigationStack {
            Form {
                TextField("Playlist title", text: $name).accessibilityIdentifier("playlist.edit.name")
                TextField("Mood", text: $mood).accessibilityIdentifier("playlist.edit.mood")
                TextField("Folder / subfolder", text: $folder).accessibilityIdentifier("playlist.edit.folder")
            }.navigationTitle("Edit playlist")
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Save") {
                            model.updateCollection(collection, name: name, mood: mood,
                                                   folderPath: folder.split(separator: "/").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty })
                            dismiss()
                        }.disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }
                .onAppear { name = collection.name; mood = collection.mood ?? ""; folder = (collection.folderPath ?? []).joined(separator: " / ") }
        }
        #if os(macOS)
        .frame(minWidth: 430, minHeight: 280)
        #endif
    }
}

struct LibrarySearchField: View {
    @Binding var text: String
    let prompt: String
    let identifier: String
    var body: some View {
        HStack(spacing: 7) {
            Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
            TextField(prompt, text: $text).textFieldStyle(.plain).autocorrectionDisabled().accessibilityIdentifier(identifier)
            if !text.isEmpty {
                Button { text = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary) }
                    .buttonStyle(.plain).accessibilityLabel("Clear search")
            }
        }.font(.system(size: 12)).padding(9).background(BoothStyle.surface, in: RoundedRectangle(cornerRadius: 5))
    }
}

#if os(iOS)
struct SharedFolderPrompts: ViewModifier {
    @Bindable var model: BoothModel
    @State private var crewName = ""
    @State private var displayName = ""
    @State private var inviteCode = ""
    @State private var actionRunning = false

    func body(content: Content) -> some View {
        content
        .alert("New shared folder", isPresented: $model.newSharedFolderPresented) {
            TextField("Crew name", text: $crewName)
            TextField("Your name", text: $displayName)
            Button("Cancel", role: .cancel) { crewName = "" }
            Button("Create") {
                run {
                    let id = try await model.createCrew(crewName, displayName: displayName)
                    crewName = ""
                    model.openCrewFolder(id)
                }
            }.disabled(crewName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || displayName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        } message: {
            Text("Every playlist in this folder is shared with your crew.")
        }
        .alert("Join shared folder", isPresented: $model.joinSharedFolderPresented) {
            TextField("Invite link or code", text: $inviteCode)
            Button("Cancel", role: .cancel) { inviteCode = "" }
            Button("Continue") {
                model.receiveCrewInvite(inviteCode)
                inviteCode = ""
            }.disabled(inviteCode.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
    }
    private func run(_ operation: @escaping @MainActor () async throws -> Void) {
        guard !actionRunning else { return }; actionRunning = true
        Task { defer { actionRunning = false }; do { try await operation() } catch { model.message = error.localizedDescription } }
    }
}

struct CrewFolderView: View {
    @Bindable var model: BoothModel
    let crewID: String
    @State private var actionRunning = false
    private var detail: CrewDetail? { model.crewDetails[crewID] }

    var body: some View {
        List {
            if let detail {
                if model.pendingQuickAddTrackID != nil {
                    Button("Cancel adding track", role: .cancel) { model.cancelQuickAdd() }
                        .boothFont(14, relativeTo: .subheadline).frame(minHeight: 44)
                        .boothLibraryCell(horizontalInset: 12).accessibilityIdentifier("playlist.picker.cancel")
                }
                if detail.crates.isEmpty {
                    ContentUnavailableView("No playlists here", systemImage: "music.note.list")
                        .boothLibraryCell()
                }
                ForEach(detail.crates) { crate in
                    LibraryNavigationButton {
                        if model.pendingQuickAddTrackID != nil { addPending(to: crate.id) }
                        else { model.openCrewPlaylist(crewID: crewID, crateID: crate.id) }
                    } label: {
                        PlaylistRowLabel(id: crate.id, title: crate.name, summary: "\(crate.itemCount ?? 0) tracks",
                            trailingSymbol: model.pendingQuickAddTrackID == nil ? "chevron.right" : "plus.circle")
                            .padding(.horizontal, 12).padding(.vertical, 6)
                            .overlay(alignment: .bottom) { Rectangle().fill(BoothStyle.border).frame(height: 0.5) }
                    }.buttonStyle(BoothRowButtonStyle()).boothLibraryCell()
                        .disabled(actionRunning || (model.pendingQuickAddTrackID != nil && !detail.crew.role.canEdit))
                        .accessibilityIdentifier("crew.playlist.\(crate.id)")
                }
            } else {
                ProgressView("Loading shared folder").frame(maxWidth: .infinity).boothLibraryCell()
            }
        }
        .boothLibraryList()
        .task(id: crewID) { await model.loadCrew(crewID) }
        .refreshable { await model.loadCrew(crewID) }
    }
    private func addPending(to crateID: String) {
        guard !actionRunning else { return }; actionRunning = true
        Task { defer { actionRunning = false }; do { try await model.addPendingTrack(crewID: crewID, crateID: crateID) }
               catch { model.crewError = error.localizedDescription } }
    }
}

struct CrewMembersView: View {
    @Bindable var model: BoothModel
    let crewID: String
    @Environment(\.dismiss) private var dismiss
    @State private var invite: CrewInvite?
    @State private var inviting = false
    @State private var error: String?
    private var detail: CrewDetail? { model.crewDetails[crewID] }

    var body: some View {
        NavigationStack {
            List {
                if let detail {
                    Section {
                        ForEach(detail.members) { member in
                            HStack(spacing: 12) {
                                CrewMark(name: member.displayName, small: true)
                                Text(member.displayName).boothFont(14, relativeTo: .subheadline, weight: .semibold)
                                Spacer()
                                Text(member.role == .dj ? "Can edit" : member.role == .viewer ? "Can view" : member.role.rawValue.capitalized)
                                    .boothFont(11, relativeTo: .caption2).foregroundStyle(.secondary)
                            }.frame(minHeight: 56)
                                .overlay(alignment: .bottom) { Rectangle().fill(BoothStyle.border).frame(height: 0.5) }
                                .boothLibraryCell(horizontalInset: 12)
                        }
                    } header: { Text(detail.crew.name) } footer: {
                        Text("Members have access to every playlist in this folder.")
                    }
                    if detail.crew.role.canInvite {
                        Button {
                            guard !inviting else { return }; inviting = true
                            Task {
                                defer { inviting = false }
                                do { invite = try await model.inviteToCrew(crewID) }
                                catch { self.error = error.localizedDescription }
                            }
                        } label: {
                            HStack {
                                Label("Add people", systemImage: "person.badge.plus")
                                if inviting { Spacer(); ProgressView() }
                            }
                        }.boothFont(14, relativeTo: .subheadline).frame(minHeight: 48)
                            .boothLibraryCell(horizontalInset: 12).disabled(inviting).accessibilityIdentifier("crew.members.add")
                    }
                }
            }.boothLibraryList().navigationTitle("Members").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
                .sheet(isPresented: Binding(get: { invite != nil }, set: { if !$0 { invite = nil } })) {
                    if let invite { CrewInviteView(crewName: detail?.crew.name ?? "Shared folder", invite: invite, endpoint: model.crewInviteEndpoint) }
                }
                .alert("Could not invite", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) {
                    Button("OK") { error = nil }
                } message: { Text(error ?? "") }
        }.tint(BoothStyle.accent).preferredColorScheme(.dark)
    }
}

struct CrewPlaylistView: View {
    @Bindable var model: BoothModel
    let crewID: String
    let crateID: String
    @State private var adding = false
    private var detail: CrewCrateDetail? { model.crewCrates[crateID] }
    private var canEdit: Bool { model.crewDetails[crewID]?.crew.role.canEdit == true }

    var body: some View {
        List {
            if canEdit {
                HStack {
                    Button { adding = true } label: { Label("Add tracks", systemImage: "plus") }
                        .accessibilityIdentifier("crew.playlist.addTracks")
                    Spacer()
                    EditButton()
                }.buttonStyle(BoothRowButtonStyle()).boothFont(12, relativeTo: .caption)
                    .frame(minHeight: 44).boothLibraryCell(horizontalInset: 12)
            }
            if let detail {
                if detail.items.isEmpty {
                    ContentUnavailableView("Empty playlist", systemImage: "music.note.list", description: Text("Add tracks from your library.")).boothLibraryCell()
                }
                ForEach(detail.items) { item in
                    CrewTrackRow(model: model, crewID: crewID, item: item, canEdit: canEdit)
                        .boothLibraryCell(horizontalInset: 8)
                        .moveDisabled(!canEdit)
                        .swipeActions(edge: .trailing) {
                            if canEdit {
                                Button("Remove", systemImage: "trash", role: .destructive) {
                                    Task { do { try await model.removeFromCrew(crewID: crewID, crateID: crateID, itemID: item.id) }
                                           catch { model.crewError = error.localizedDescription } }
                                }
                            }
                        }
                }
                .onMove { source, destination in move(source, destination, items: detail.items) }
            } else { ProgressView("Loading playlist").frame(maxWidth: .infinity).boothLibraryCell() }
        }
        .boothLibraryList()
        .task(id: crateID) { await model.loadCrewCrate(crewID: crewID, crateID: crateID) }
        .refreshable { await model.loadCrewCrate(crewID: crewID, crateID: crateID) }
        .sheet(isPresented: $adding) { CrewTrackPicker(model: model, crewID: crewID, crateID: crateID) }
    }
    private func move(_ source: IndexSet, _ destination: Int, items: [CrewCrateItem]) {
        guard canEdit, let from = source.first else { return }
        var reordered = items
        let item = reordered.remove(at: from)
        let target = min(destination > from ? destination - 1 : destination, reordered.count)
        reordered.insert(item, at: target)
        model.crewCrates[crateID]?.items = reordered
        let after = target == 0 ? nil : reordered[target - 1].id
        Task { do { try await model.moveCrewItem(crewID: crewID, crateID: crateID, itemID: item.id, afterItemID: after) }
               catch { model.crewError = error.localizedDescription; await model.loadCrewCrate(crewID: crewID, crateID: crateID) } }
    }
}

private struct CrewTrackRow: View {
    @Bindable var model: BoothModel
    let crewID: String
    let item: CrewCrateItem
    let canEdit: Bool
    var body: some View {
        let track = model.localTrack(for: item)
        let member = model.crewDetails[crewID]?.members.first { $0.accountID == item.addedBy }
        HStack(spacing: 6) {
            if let track {
                VStack(alignment: .leading, spacing: 2) {
                    TrackRow(track: track, model: model, sharedPlaylist: true, contributor: member, contributorItemID: item.id, removeSharedTrack: canEdit ? {
                        Task { do { try await model.removeFromCrew(crewID: crewID, crateID: item.crateID, itemID: item.id) }
                               catch { model.crewError = error.localizedDescription } }
                    } : nil)
                    if let note = item.note, !note.isEmpty { Text(note).font(.caption).foregroundStyle(BoothStyle.accent) }
                }
            } else {
                VStack(alignment: .leading, spacing: 3) {
                    Text(item.title).font(.subheadline.weight(.semibold))
                    Text(item.artist ?? "Unknown artist").font(.caption).foregroundStyle(.secondary)
                    Label("Audio not shared yet", systemImage: "icloud.slash").font(.caption).foregroundStyle(.secondary)
                }.frame(maxWidth: .infinity, alignment: .leading)
                CrewContributorBadge(member: member, itemID: item.id)
            }
        }
    }
}

struct CrewContributorBadge: View {
    let member: CrewMember?
    let itemID: String
    var compact = false
    @State private var showingContributor = false
    private var name: String? {
        guard let name = member?.displayName.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty else { return nil }
        return name
    }
    var body: some View {
        Button { showingContributor = true } label: {
            Group {
                if let name { CrewMark(name: name, small: true, compact: compact) }
                else {
                    Image(systemName: "person.fill").font(compact ? .system(size: 9) : .body).foregroundStyle(.secondary)
                        .frame(width: compact ? 16 : 38, height: compact ? 16 : 38).background(Circle().fill(Color.white.opacity(0.08)))
                }
            }.frame(minWidth: compact ? 16 : 44, minHeight: compact ? 16 : 44).contentShape(Rectangle())
        }.buttonStyle(.plain)
            .accessibilityLabel("Added by \(name ?? "unknown contributor")")
            .accessibilityIdentifier("crew.contributor.\(itemID)")
            .popover(isPresented: $showingContributor) {
                VStack(spacing: 6) {
                    Text("Added by").font(.caption).foregroundStyle(.secondary)
                    Text(name ?? "Unknown contributor").font(.headline).accessibilityIdentifier("crew.contributor.name")
                    if name == nil { Text("Member details are unavailable.").font(.caption).foregroundStyle(.secondary) }
                }.padding().presentationCompactAdaptation(.popover)
            }
    }
}

private struct CrewTrackPicker: View {
    @Bindable var model: BoothModel
    let crewID: String
    let crateID: String
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var adding = Set<String>()
    private var tracks: [Track] {
        let source = query.isEmpty ? model.tracks : model.tracks.filter { "\($0.title) \($0.artist ?? "")".localizedStandardContains(query) }
        return Array(source.prefix(500))
    }
    var body: some View {
        NavigationStack {
            List(tracks) { track in
                Button {
                    guard !adding.contains(track.id) else { return }; adding.insert(track.id)
                    Task { defer { adding.remove(track.id) }; do { try await model.addToCrew(track, crewID: crewID, crateID: crateID) }
                           catch { model.crewError = error.localizedDescription } }
                } label: {
                    HStack {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(track.title).boothFont(14, relativeTo: .body, weight: .semibold).foregroundStyle(.primary)
                            Text(track.artist ?? "Unknown artist").boothFont(11, relativeTo: .caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        if adding.contains(track.id) { ProgressView().controlSize(.small) }
                        else { Image(systemName: "plus.circle").foregroundStyle(BoothStyle.accent) }
                    }
                }.buttonStyle(BoothRowButtonStyle()).padding(.vertical, 6).boothLibraryCell(horizontalInset: 12)
            }.boothLibraryList().searchable(text: $query, prompt: "Find tracks")
                .navigationTitle("Add tracks")
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }.tint(BoothStyle.accent).preferredColorScheme(.dark)
    }
}

private struct CrewMark: View {
    let name: String
    var small = false
    var compact = false
    var body: some View {
        Text(name.split(whereSeparator: \.isWhitespace).prefix(2).compactMap(\.first).map(String.init).joined().uppercased())
            .boothFont(compact ? 8 : small ? 12 : 16, relativeTo: small ? .caption : .body, weight: .bold)
            .frame(width: compact ? 16 : small ? 38 : 46, height: compact ? 16 : small ? 38 : 46)
            .background(Circle().fill(BoothStyle.accent.opacity(0.18))).foregroundStyle(BoothStyle.accent)
    }
}
#endif

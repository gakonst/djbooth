import SwiftUI
import DJBoothKit

struct PlaylistBrowserView: View {
    @Bindable var model: BoothModel
    var folderPath: [String]? = nil
    private var path: [String] { folderPath ?? model.playlistFolderPath }
    #if os(macOS)
    @State private var search = ""
    #endif
    @State private var pendingDelete: Collection?
    @State private var editing: Collection?
    @State private var showUSBLibrary = false
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
        model.collections.sorted { first, second in
            let firstDownloaded = model.connectedPlaylist(first.id).map(model.musicIsDownloaded) ?? false
            let secondDownloaded = model.connectedPlaylist(second.id).map(model.musicIsDownloaded) ?? false
            if firstDownloaded != secondDownloaded { return firstDownloaded }
            let comparison = first.name.localizedStandardCompare(second.name)
            return comparison == .orderedSame ? first.id < second.id : comparison == .orderedAscending
        }
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
            if path.isEmpty, model.musicCatalog.sources.contains(where: { $0.providerName == name }) { continue }
            #endif
            folderCounts[name, default: 0] += 1
        }
        let visibleFolders = folderCounts.sorted { $0.key.localizedStandardCompare($1.key) == .orderedAscending }
        var rows: [PlaylistBrowserRow] = []
        rows.reserveCapacity(pinnedPlaylists.count + visiblePlaylists.count + visibleFolders.count + 2)
        #if os(iOS)
        if model.pendingQuickAddTrackID != nil { rows.append(.cancelQuickAdd) }
        #endif
        if !searching, let folder = path.last { rows.append(.back(folder)) }
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
            List {
                if path.isEmpty, model.pendingQuickAddTrackID == nil, model.usbConnected || model.usbDevice == nil {
                    Button {
                        if model.usbConnected, let device = model.usbDevice { model.openPlaylistFolder([device.folderName]) }
                        else { showUSBLibrary = true }
                    } label: {
                        browserNavigationRow(title: model.usbDevice?.name ?? "Open USB library",
                                             detail: model.usbDevice == nil ? "Rekordbox" : "USB · Connected", symbol: "externaldrive")
                    }.buttonStyle(.plain).accessibilityIdentifier("usb.open")
                        .accessibilityValue(model.usbConnected ? "Connected" : "Disconnected")
                        .contextMenu { Button("Choose USB folder") { showUSBLibrary = true } }
                        .boothLibraryCell()
                }
                if path.isEmpty, model.pendingQuickAddTrackID == nil {
                    ForEach(Array(Set(model.musicCatalog.sources.map(\.providerName))).sorted(), id: \.self) { name in
                        LibraryNavigationButton { model.openPlaylistFolder([name]) } label: {
                            browserNavigationRow(title: name, detail: "Connected account", symbol: name == "Spotify" ? "music.note" : "cloud")
                        }.buttonStyle(.plain).boothLibraryCell().accessibilityIdentifier("music.source.\(name)")
                    }
                    if model.musicLoading { ProgressView("Refreshing music accounts").boothLibraryCell() }
                    if let error = model.musicError {
                        VStack(alignment: .leading) { Text(error).font(.caption).foregroundStyle(.secondary); Button("Retry music accounts") { Task { await model.refreshMusic(force: true) } } }.boothLibraryCell()
                    }
                }
                browserContent(rows).boothLibraryCell()
            }.boothLibraryList()
            #else
            ScrollView(.vertical, showsIndicators: true) {
                LazyVStack(spacing: 0) { browserContent(rows) }
                    .animation(animation, value: sorted.map { "\($0.id):\($0.isPinned == true)" })
            }
            #endif
        }
        .accessibilityIdentifier("playlist.browser")
        .task { await model.refreshMusic() }
        .refreshable { await model.refreshMusic(force: true) }
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
                            ContentUnavailableView {
                                Label(searching ? "No matching playlists" : "No playlists here", systemImage: "music.note.list")
                            } description: {
                                Text(searching ? "Try another title or mood." : "Create a playlist to organize your music.")
                            } actions: {
                                if !searching {
                                    Button("New playlist") { model.showNewCollection = true }
                                        .accessibilityIdentifier("playlist.empty.create")
                                }
                            }
                        }
                    }
    }
    private func connectedRow(_ collection: Collection, item: MusicPlaylist) -> some View {
        HStack(spacing: 12) {
            LibraryNavigationButton { model.openCollection(collection) } label: {
                VStack(alignment: .leading, spacing: 4) {
                    Text(item.name).lineLimit(1)
                    Text("\(item.trackCount) tracks · \(model.musicIsDownloaded(item) ? "Downloaded" : "Stream")").font(.caption).foregroundStyle(.secondary)
                }.frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 8)
            }.buttonStyle(.plain).accessibilityIdentifier("music.playlist.\(item.remoteID)")
            if model.musicDownloads.contains(item.id) || model.musicPlaylistLoading.contains(item.id) { ProgressView() }
            if model.musicIsDownloaded(item) {
                Button { Task { await model.keepCollectionOffline(collection) } } label: { Image(systemName: "arrow.down.circle") }
                    .accessibilityLabel("Keep playlist on this phone")
            } else {
                Button { Task { await model.downloadMusic(item) } } label: { Image(systemName: "arrow.down.circle") }
                    .disabled(model.musicDownloads.contains(item.id)).accessibilityLabel("Download playlist")
                    .accessibilityIdentifier("music.download.\(item.remoteID)")
            }
        }.contextMenu {
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
        let layout = typeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 8))
            : AnyLayout(HStackLayout(spacing: 12))
        return HStack(spacing: 12) {
            layout {
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 5) {
                        Text(collection.name).boothFont(14, relativeTo: .subheadline, weight: .semibold)
                            .lineLimit(typeSize.isAccessibilitySize ? 3 : 1)
                        if collection.isPinned == true {
                            Image(systemName: "pin.fill").font(.caption).foregroundStyle(BoothStyle.accent).accessibilityHidden(true)
                        }
                    }
                    let detail = [collection.mood ?? "", (collection.folderPath ?? []).joined(separator: " / ")].filter { !$0.isEmpty }.joined(separator: " · ")
                    if !detail.isEmpty {
                        Text(detail).boothFont(11, relativeTo: .caption2).foregroundStyle(.secondary)
                            .lineLimit(typeSize.isAccessibilitySize ? 2 : 1)
                    }
                }.frame(maxWidth: .infinity, alignment: .leading)
                VStack(alignment: typeSize.isAccessibilitySize ? .leading : .trailing, spacing: 4) {
                    Text(durationLabel(duration)).boothFont(12, relativeTo: .caption, design: .monospaced).foregroundStyle(.primary)
                    if let lower = lowerBPM, let upper = upperBPM {
                        Text(lower.rounded() == upper.rounded() ? "\(Int(lower.rounded())) BPM" : "\(Int(lower.rounded()))–\(Int(upper.rounded())) BPM")
                            .boothFont(11, relativeTo: .caption2, design: .monospaced).foregroundStyle(.secondary)
                            .accessibilityIdentifier("playlist.bpm.\(collection.id)")
                    }
                }.fixedSize(horizontal: true, vertical: false)
            }
            Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(.secondary).accessibilityHidden(true)
        }.frame(minHeight: 48).contentShape(Rectangle())
    }
    private func browserNavigationRow(title: String, detail: String, symbol: String) -> some View {
        HStack(spacing: 10) {
            Image(systemName: symbol).font(.body).foregroundStyle(BoothStyle.accent).frame(width: 32, height: 44).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text(title).boothFont(14, relativeTo: .subheadline, weight: .semibold).lineLimit(typeSize.isAccessibilitySize ? 2 : 1)
                #if os(macOS)
                Text(detail).font(.system(size: 10)).foregroundStyle(.secondary)
                #endif
            }
            Spacer()
            Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(.secondary).accessibilityHidden(true)
        }.padding(.horizontal, 12).padding(.vertical, 5).contentShape(Rectangle())
    }
    private func durationLabel(_ seconds: Double) -> String {
        let minutes = Int(max(0, seconds.isFinite ? seconds : 0) / 60)
        return minutes >= 60 ? "\(minutes / 60)h \(minutes % 60)m" : "\(minutes)m"
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
struct CrewListView: View {
    @Bindable var model: BoothModel
    @Environment(\.dismiss) private var dismiss
    @State private var creating = false
    @State private var joining = false
    @State private var crewName = ""
    @State private var inviteCode = ""
    @State private var actionRunning = false

    var body: some View {
        NavigationStack {
            Group {
                if model.crewsLoading && model.crews.isEmpty {
                    ProgressView("Loading crews")
                } else if model.crews.isEmpty {
                    ContentUnavailableView("No crews yet", systemImage: "person.3",
                                           description: Text("Make one with the DJs you share music with."))
                } else {
                    List(model.crews) { crew in
                        NavigationLink { CrewDetailView(model: model, crewID: crew.id) } label: {
                            HStack(spacing: 12) {
                                CrewMark(name: crew.name)
                                VStack(alignment: .leading, spacing: 3) {
                                    Text(crew.name).boothFont(15, relativeTo: .body, weight: .semibold)
                                    Text("\(crew.memberCount) DJs · \(crew.crateCount) crates")
                                        .boothFont(11, relativeTo: .caption).foregroundStyle(.secondary)
                                }
                                Spacer()
                                Text(crew.role.rawValue.uppercased()).boothFont(9, relativeTo: .caption2, weight: .semibold)
                                    .foregroundStyle(.secondary)
                            }.padding(.vertical, 4)
                        }.accessibilityIdentifier("crew.row.\(crew.id)")
                    }.boothLibraryList()
                }
            }
            .navigationTitle(model.crewTrackToAdd == nil ? "Crews" : "Add to crew")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Done") { model.crewTrackToAdd = nil; dismiss() } }
                ToolbarItem(placement: .primaryAction) {
                    Menu {
                        Button("New crew", systemImage: "plus") { creating = true }
                        Button("Join with invite", systemImage: "person.badge.plus") { joining = true }
                    } label: { Image(systemName: "plus") }.accessibilityLabel("Crew actions")
                }
            }
            .refreshable { await model.refreshCrews() }
            .task { await model.refreshCrews() }
            .alert("New crew", isPresented: $creating) {
                TextField("Crew name", text: $crewName)
                Button("Cancel", role: .cancel) { crewName = "" }
                Button("Create") { run { try await model.createCrew(crewName); crewName = "" } }
                    .disabled(crewName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || actionRunning)
            }
            .alert("Join crew", isPresented: $joining) {
                TextField("Invite link or code", text: $inviteCode)
                Button("Cancel", role: .cancel) { inviteCode = "" }
                Button("Join") { run { try await model.acceptCrewInvite(inviteCode); inviteCode = "" } }
                    .disabled(inviteCode.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || actionRunning)
            }
            .alert("Crew unavailable", isPresented: Binding(get: { model.crewError != nil }, set: { if !$0 { model.crewError = nil } })) {
                Button("OK") { model.crewError = nil }
            } message: { Text(model.crewError ?? "") }
        }.preferredColorScheme(.dark)
    }
    private func run(_ operation: @escaping @MainActor () async throws -> Void) {
        guard !actionRunning else { return }; actionRunning = true
        Task { defer { actionRunning = false }; do { try await operation() } catch { model.crewError = error.localizedDescription } }
    }
}

private struct CrewDetailView: View {
    @Bindable var model: BoothModel
    let crewID: String
    @State private var creating = false
    @State private var crateName = ""
    @State private var invite: CrewInvite?
    @State private var actionRunning = false
    private var detail: CrewDetail? { model.crewDetails[crewID] }

    var body: some View {
        List {
            if let detail {
                Section {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 12) {
                            ForEach(detail.members) { member in
                                VStack(spacing: 5) {
                                    CrewMark(name: member.displayName, small: true)
                                    Text(member.displayName).boothFont(10, relativeTo: .caption2).lineLimit(1)
                                }.frame(width: 58)
                            }
                        }.padding(.vertical, 4)
                    }
                }
                Section("Crates") {
                    if detail.crates.isEmpty {
                        Button("New crate", systemImage: "plus") { creating = true }
                    }
                    ForEach(detail.crates) { crate in
                        Group {
                            if model.crewTrackToAdd == nil {
                                NavigationLink { CrewCrateView(model: model, crewID: crewID, crate: crate) } label: { crateLabel(crate) }
                            } else {
                                Button { addPending(to: crate.id) } label: { crateLabel(crate) }.buttonStyle(.plain)
                            }
                        }
                        .accessibilityIdentifier("crew.crate.\(crate.id)")
                    }
                }
            } else {
                ProgressView("Loading crew").frame(maxWidth: .infinity)
            }
        }
        .boothLibraryList().navigationTitle(detail?.crew.name ?? "Crew")
        .toolbar {
            if detail?.crew.role.canEdit == true {
                ToolbarItem(placement: .primaryAction) { Button { creating = true } label: { Image(systemName: "plus") }.accessibilityLabel("New crate") }
            }
            if detail?.crew.role.canInvite == true {
                ToolbarItem(placement: .primaryAction) {
                    Button { createInvite() } label: { Image(systemName: "person.badge.plus") }.disabled(actionRunning).accessibilityLabel("Invite DJ")
                }
            }
        }
        .task(id: crewID) { await model.loadCrew(crewID) }
        .refreshable { await model.loadCrew(crewID) }
        .alert("New crate", isPresented: $creating) {
            TextField("Crate name", text: $crateName)
            Button("Cancel", role: .cancel) { crateName = "" }
            Button("Create") {
                actionRunning = true
                Task { defer { actionRunning = false }; do { try await model.createCrewCrate(crewID: crewID, name: crateName); crateName = "" } catch { model.crewError = error.localizedDescription } }
            }.disabled(crateName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || actionRunning)
        }
        .sheet(isPresented: Binding(get: { invite != nil }, set: { if !$0 { invite = nil } })) {
            if let invite { CrewInviteView(crewName: detail?.crew.name ?? "DJ Booth", invite: invite) }
        }
    }
    private func createInvite() {
        guard !actionRunning else { return }; actionRunning = true
        Task { defer { actionRunning = false }; do { invite = try await model.inviteToCrew(crewID) } catch { model.crewError = error.localizedDescription } }
    }
    private func addPending(to crateID: String) {
        guard !actionRunning else { return }; actionRunning = true
        Task { defer { actionRunning = false }; do { try await model.addPendingTrack(crewID: crewID, crateID: crateID) }
               catch { model.crewError = error.localizedDescription } }
    }
    private func crateLabel(_ crate: CrewCrate) -> some View {
        HStack(spacing: 11) {
            Image(systemName: "shippingbox").foregroundStyle(BoothStyle.accent).frame(width: 28)
            VStack(alignment: .leading, spacing: 3) {
                Text(crate.name).boothFont(14, relativeTo: .body, weight: .semibold).foregroundStyle(.primary)
                Text("\(crate.itemCount ?? 0) tracks").boothFont(11, relativeTo: .caption).foregroundStyle(.secondary)
            }
            Spacer()
            if model.crewTrackToAdd != nil { Image(systemName: "plus.circle").foregroundStyle(BoothStyle.accent) }
        }.padding(.vertical, 3).contentShape(Rectangle())
    }
}

private struct CrewCrateView: View {
    @Bindable var model: BoothModel
    let crewID: String
    let crate: CrewCrate
    @State private var adding = false
    private var detail: CrewCrateDetail? { model.crewCrates[crate.id] }
    private var canEdit: Bool { model.crewDetails[crewID]?.crew.role.canEdit == true }

    var body: some View {
        List {
            if let detail {
                if detail.items.isEmpty {
                    ContentUnavailableView("Empty crate", systemImage: "shippingbox", description: Text("Add tracks from your library."))
                }
                ForEach(detail.items) { item in
                    CrewTrackRow(model: model, item: item)
                        .moveDisabled(!canEdit)
                        .swipeActions(edge: .trailing) {
                            if canEdit {
                                Button("Remove", systemImage: "trash", role: .destructive) {
                                    Task { do { try await model.removeFromCrew(crewID: crewID, crateID: crate.id, itemID: item.id) }
                                           catch { model.crewError = error.localizedDescription } }
                                }
                            }
                        }
                }
                .onMove { source, destination in move(source, destination, items: detail.items) }
            } else { ProgressView("Loading crate").frame(maxWidth: .infinity) }
        }
        .boothLibraryList().navigationTitle(crate.name)
        .toolbar {
            if canEdit {
                ToolbarItem(placement: .primaryAction) { EditButton() }
                ToolbarItem(placement: .primaryAction) { Button { adding = true } label: { Image(systemName: "plus") }.accessibilityLabel("Add tracks") }
            }
        }
        .task(id: crate.id) { await model.loadCrewCrate(crewID: crewID, crateID: crate.id) }
        .refreshable { await model.loadCrewCrate(crewID: crewID, crateID: crate.id) }
        .sheet(isPresented: $adding) { CrewTrackPicker(model: model, crewID: crewID, crateID: crate.id) }
    }
    private func move(_ source: IndexSet, _ destination: Int, items: [CrewCrateItem]) {
        guard let from = source.first else { return }
        var reordered = items
        let item = reordered.remove(at: from)
        let target = min(destination > from ? destination - 1 : destination, reordered.count)
        reordered.insert(item, at: target)
        model.crewCrates[crate.id]?.items = reordered
        let after = target == 0 ? nil : reordered[target - 1].id
        Task { do { try await model.moveCrewItem(crewID: crewID, crateID: crate.id, itemID: item.id, afterItemID: after) }
               catch { model.crewError = error.localizedDescription; await model.loadCrewCrate(crewID: crewID, crateID: crate.id) } }
    }
}

private struct CrewTrackRow: View {
    @Bindable var model: BoothModel
    let item: CrewCrateItem
    var body: some View {
        let local = model.localTrack(for: item)
        Button { if let local { Task { await model.play(local, preservingQueue: false) } } } label: {
            HStack(spacing: 11) {
                Image(systemName: local == nil ? "exclamationmark.circle" : "checkmark.circle.fill")
                    .foregroundStyle(local == nil ? .secondary : BoothStyle.accent).accessibilityLabel(local == nil ? "Missing" : "Ready")
                VStack(alignment: .leading, spacing: 3) {
                    Text(item.title).boothFont(14, relativeTo: .body, weight: .semibold).lineLimit(1)
                    Text([item.artist, item.bpm.map { String(format: "%.0f BPM", $0) }, item.musicalKey].compactMap { $0 }.joined(separator: " · "))
                        .boothFont(11, relativeTo: .caption).foregroundStyle(.secondary).lineLimit(1)
                    if let note = item.note, !note.isEmpty { Text(note).boothFont(11, relativeTo: .caption).foregroundStyle(BoothStyle.accent).lineLimit(1) }
                }
                Spacer()
                Text(String(item.addedBy.suffix(2)).uppercased()).boothFont(9, relativeTo: .caption2, weight: .bold)
                    .frame(width: 25, height: 25).background(Circle().fill(Color.white.opacity(0.08)))
            }.contentShape(Rectangle()).padding(.vertical, 3)
        }.buttonStyle(.plain).disabled(local == nil)
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
                }.buttonStyle(.plain)
            }.boothLibraryList().searchable(text: $query, prompt: "Find tracks")
                .navigationTitle("Add tracks")
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }.preferredColorScheme(.dark)
    }
}

private struct CrewInviteView: View {
    let crewName: String
    let invite: CrewInvite
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            VStack(spacing: 22) {
                CrewMark(name: crewName)
                Text("Invite a DJ").font(.title2.bold())
                Text(crewName).foregroundStyle(.secondary)
                Text(invite.token).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                    .padding().background(RoundedRectangle(cornerRadius: 12).fill(Color.white.opacity(0.06)))
                ShareLink(item: "Join my \(crewName) crew in DJ Booth with this code: \(invite.token)") {
                    Label("Share invite", systemImage: "square.and.arrow.up").frame(maxWidth: .infinity)
                }.buttonStyle(.borderedProminent)
                Text("Single use · expires in 7 days").font(.caption).foregroundStyle(.secondary)
                Spacer()
            }.padding(24).navigationTitle("Crew invite")
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }.presentationDetents([.medium]).preferredColorScheme(.dark)
    }
}

private struct CrewMark: View {
    let name: String
    var small = false
    var body: some View {
        Text(name.split(separator: " ").prefix(2).compactMap(\.first).map(String.init).joined().uppercased())
            .boothFont(small ? 12 : 16, relativeTo: small ? .caption : .body, weight: .bold)
            .frame(width: small ? 38 : 46, height: small ? 38 : 46)
            .background(Circle().fill(BoothStyle.accent.opacity(0.18))).foregroundStyle(BoothStyle.accent)
    }
}
#endif

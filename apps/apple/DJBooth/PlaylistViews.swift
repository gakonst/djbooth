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
                if path.isEmpty, model.pendingQuickAddTrackID == nil {
                    Button {
                        if model.usbConnected, let device = model.usbDevice { model.openPlaylistFolder([device.folderName]) }
                        else { showUSBLibrary = true }
                    } label: {
                        browserNavigationRow(title: model.usbDevice == nil ? "Open USB library" : model.usbConnected ? "USB connected" : "Reconnect USB",
                                             detail: model.usbDevice?.name ?? "Rekordbox", symbol: "externaldrive")
                    }.buttonStyle(.plain).accessibilityIdentifier("usb.open")
                        .accessibilityValue(model.usbConnected ? "Connected" : "Disconnected")
                        .contextMenu { Button("Choose USB folder") { showUSBLibrary = true } }
                        .listRowInsets(EdgeInsets()).listRowSeparator(.hidden).listRowBackground(BoothStyle.background)
                }
                browserContent(rows)
                    .listRowInsets(EdgeInsets())
                    .listRowSeparator(.hidden).listRowBackground(BoothStyle.background)
            }.listStyle(.plain).scrollContentBackground(.hidden)
                .environment(\.defaultMinListRowHeight, 0)
                .background(BoothStyle.background)
            #else
            ScrollView(.vertical, showsIndicators: true) {
                LazyVStack(spacing: 0) { browserContent(rows) }
                    .animation(animation, value: sorted.map { "\($0.id):\($0.isPinned == true)" })
            }
            #endif
        }
        .accessibilityIdentifier("playlist.browser")
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
                            }.buttonStyle(.plain).accessibilityIdentifier("playlist.picker.cancel")
                        case .back(let title):
                            LibraryNavigationButton {
                                guard !path.isEmpty else { return }
                                model.openPlaylistFolder(Array(path.dropLast()))
                            } label: {
                                browserNavigationRow(title: title, detail: "Up one level", symbol: "arrow.left")
                            }.buttonStyle(.plain).accessibilityIdentifier("playlist.folder.back")
                        case .pinnedHeader:
                            Text("PINNED").font(.system(size: 9, weight: .semibold, design: .monospaced)).tracking(1)
                                .foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 12).padding(.vertical, 8)
                        case .folder(let name, let count):
                            LibraryNavigationButton {
                                model.openPlaylistFolder(path + [name])
                            } label: {
                                browserNavigationRow(title: name, detail: "\(count) playlists", symbol: "folder")
                            }.buttonStyle(.plain).accessibilityIdentifier("playlist.folder.\(name)")
                        case .playlist(let collection):
                            row(collection, trackMap: trackMap)
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
                }.buttonStyle(.plain).accessibilityIdentifier("playlist.row.\(collection.id)")
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
                .overlay(alignment: .bottom) { Rectangle().fill(BoothStyle.border.opacity(0.55)).frame(height: 0.5) }
        }
    }
    private func browserNavigationRow(title: String, detail: String, symbol: String) -> some View {
        HStack(spacing: 10) {
            Image(systemName: symbol).frame(width: 34, height: 34).background(BoothStyle.surface)
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.system(size: 13, weight: .semibold)).lineLimit(1)
                #if os(macOS)
                Text(detail).font(.system(size: 10)).foregroundStyle(.secondary)
                #endif
            }
            Spacer()
            Image(systemName: "chevron.right").font(.caption2).foregroundStyle(.secondary)
        }.padding(.horizontal, 12).padding(.vertical, 10).contentShape(Rectangle())
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

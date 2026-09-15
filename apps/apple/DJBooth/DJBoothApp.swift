import SwiftUI

@main struct DJBoothApp: App {
    @State private var model: BoothModel?
    @State private var startupError: String?
    init() { PerformanceProbe.applicationBegan() }
    var body: some Scene {
        WindowGroup {
            Group {
                if let model { BoothRoot(model: model).onAppear { PerformanceProbe.libraryRendered() } }
                else if let startupError {
                    ContentUnavailableView("Library could not open", systemImage: "externaldrive.badge.exclamationmark", description: Text(startupError))
                } else { ProgressView("Opening your music…") }
            }
            .task {
                guard model == nil, startupError == nil else { return }
                do { model = try await BoothModel() } catch { startupError = error.localizedDescription }
            }
            #if DEBUG
            .overlay(alignment: .top) {
                if PlaybackRaceProbeView.enabled, let model { PlaybackRaceProbeView(model: model) }
            }
            #endif
            .tint(BoothStyle.accent)
            .preferredColorScheme(.dark)
            #if os(macOS)
            .frame(minWidth: 980, minHeight: 680)
            #endif
        }
        #if os(macOS)
        .defaultSize(width: 1320, height: 860)
        .commands {
            CommandGroup(replacing: .newItem) {
                Button("New Playlist") { model?.showNewCollection = true }.keyboardShortcut("n")
                Button("Import Music…") { model?.showImport = true }.keyboardShortcut("i")
            }
            CommandMenu("Playback") {
                Button("Play / Pause") {
                    if let model { Task { await model.togglePlayback() } }
                }.keyboardShortcut(.space, modifiers: [])
                Button("Next Track") { model?.player.advance(1) }.keyboardShortcut(.rightArrow, modifiers: .command)
            }
        }
        #endif
        #if os(macOS)
        Settings {
            if let model { ConnectionSettings(model: model).frame(width: 580, height: 520) }
        }
        #endif
    }
}

struct BoothRoot: View {
    @Bindable var model: BoothModel
    @Environment(\.scenePhase) private var scenePhase
    @State private var collectionName = ""
    var body: some View {
        platformRoot
            .background(BoothStyle.background)
            .sheet(isPresented: $model.showSettings) { ConnectionSettings(model: model) }
            .sheet(isPresented: $model.showImport) { ImportSheet(model: model) }
            .alert("Remove from playlist?", isPresented: Binding(
                get: { model.pendingPlaylistRemoval != nil },
                set: { if !$0 { model.pendingPlaylistRemoval = nil } }), presenting: model.pendingPlaylistRemoval) { request in
                Button("Remove", role: .destructive) { model.confirmRemoval(request) }
                    .accessibilityIdentifier("playlist.removal.confirm")
                Button("Cancel", role: .cancel) { model.pendingPlaylistRemoval = nil }
                    .accessibilityIdentifier("playlist.removal.cancel")
            } message: { request in
                Text("Remove “\(request.trackTitle)” from “\(request.collectionName)”?")
            }
            .alert("New playlist", isPresented: $model.showNewCollection) {
                TextField("Playlist name", text: $collectionName)
                Button("Create") { model.createCollection(collectionName); collectionName = "" }
                Button("Cancel", role: .cancel) {}
            } message: { Text("Your playlist is saved locally and syncs across your devices.") }
            .alert("DJ Booth", isPresented: Binding(get: { model.message != nil || model.player.error != nil }, set: { if !$0 { model.message = nil; model.player.error = nil } })) {
                Button("OK") { model.message = nil; model.player.error = nil }
            } message: { Text(model.message ?? model.player.error ?? "") }
            .task {
                model.player.onAdvance = { track in Task { await model.play(track, preservingQueue: true) } }
                if !PerformanceProbe.offline { await model.startup() }
            }
            .onChange(of: scenePhase) { _, phase in
                if phase != .active { model.persistPlaybackSession() }
            }
            .task(id: scenePhase) {
                guard scenePhase == .active, !model.demo, !PerformanceProbe.offline else { return }
                while !Task.isCancelled {
                    do { try await Task.sleep(for: .seconds(20)) } catch { return }
                    await model.refreshImports()
                    await model.synchronize()
                }
            }
    }
    @ViewBuilder private var platformRoot: some View {
        #if os(macOS)
        NavigationSplitView {
            sidebar.navigationSplitViewColumnWidth(min: 210, ideal: 235, max: 280)
        } detail: {
            NavigationStack { content }
                .safeAreaInset(edge: .bottom, spacing: 0) {
                    VStack(spacing: 0) {
                        PlaylistRemovalNotice(model: model)
                        MiniPlayer(model: model).padding(8)
                    }
                }
        }
        #else
        MobileLibraryNavigation(model: model)
            .safeAreaInset(edge: .bottom, spacing: 0) {
                VStack(spacing: 0) {
                    PlaylistRemovalNotice(model: model)
                    MobileNowPlaying(model: model)
                }
            }
        #endif
    }
    #if os(macOS)
    private var sidebar: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 10) {
                Image(systemName: "waveform").font(.title2.bold()).foregroundStyle(BoothStyle.accent)
                Text("djbooth").font(.system(size: 19, weight: .semibold)).tracking(-0.5)
            }.padding(.horizontal, 16).padding(.top, 16).padding(.bottom, 12)
            List {
                Section {
                    Button { model.showLibrary() } label: { Label("All music", systemImage: "music.note.list") }
                    Button { model.showLibrary(filter: "Favorites") } label: { Label("Favorites", systemImage: "heart") }
                    Button { model.showLibrary(filter: "On this device") } label: { Label("On this Mac", systemImage: "internaldrive") }
                } header: { Text("QUICK ACCESS") }
                Section {
                    ForEach(model.collections) { collection in
                        Button { model.openCollection(collection) } label: {
                            Label(collection.name, systemImage: "square.stack")
                        }
                    }
                    Button { model.showNewCollection = true } label: { Label("New playlist", systemImage: "plus") }
                } header: { Text("PLAYLISTS") }
            }.listStyle(.sidebar).scrollContentBackground(.hidden)
            VStack(alignment: .leading, spacing: 8) {
                Label(model.demo ? "Preview library" : "Local library", systemImage: "internaldrive")
                    .font(.caption.weight(.semibold))
                Text(model.syncStatus).font(.caption2).foregroundStyle(.secondary).lineLimit(2)
                Button { model.showSettings = true } label: { Label("Sync & settings", systemImage: "gearshape") }.font(.caption)
            }.padding(16)
        }
    }
    #endif
    private var content: some View {
        LibraryView(model: model)
        #if os(macOS)
        .navigationTitle("Library")
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                if model.loading || model.syncing { ProgressView().controlSize(.small) }
                Button { Task { await model.refreshWorkstation(); await model.synchronize() } } label: { Image(systemName: "arrow.triangle.2.circlepath") }
                    .help("Refresh and sync").accessibilityLabel("Refresh and sync")
                Button { model.showImport = true } label: { Image(systemName: "plus") }.accessibilityLabel("Import music")
                Button { model.showSettings = true } label: { Image(systemName: "slider.horizontal.3") }.accessibilityLabel("Connection settings")
            }
        }
        #else
        .toolbar(.hidden, for: .navigationBar)
        #endif
        .safeAreaInset(edge: .top, spacing: 0) {
            if model.demo { Text("PREVIEW · Sample library, no accounts connected").font(.caption2.weight(.semibold)).frame(maxWidth: .infinity).padding(6).background(BoothStyle.accent.opacity(0.12)) }
        }
    }
}

private struct PlaylistRemovalNotice: View {
    @Bindable var model: BoothModel
    var body: some View {
        if let undo = model.undoablePlaylistRemoval {
            HStack(spacing: 8) {
                Text("Removed “\(undo.trackTitle)”")
                    .font(.system(size: 12)).lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityLabel("Removed \(undo.trackTitle) from \(undo.collectionName)")
                Button { model.undoPlaylistRemoval() } label: {
                    Text("Undo").font(.system(size: 13, weight: .semibold))
                        .frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
                }.foregroundStyle(BoothStyle.accent)
                    .accessibilityIdentifier("playlist.removal.undo")
                Button { model.dismissPlaylistRemovalUndo() } label: {
                    Image(systemName: "xmark").font(.system(size: 12, weight: .medium))
                        .frame(width: 44, height: 44).contentShape(Rectangle())
                }.foregroundStyle(.secondary).accessibilityLabel("Dismiss removal notice")
                    .accessibilityIdentifier("playlist.removal.dismiss")
            }.buttonStyle(.plain).padding(.leading, 12)
                .background(BoothStyle.surface)
                .overlay(alignment: .top) { Rectangle().fill(BoothStyle.border).frame(height: 0.5) }
                .accessibilityElement(children: .contain).accessibilityIdentifier("playlist.removal.notice")
        }
    }
}

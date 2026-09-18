import SwiftUI
import DJBoothKit

@main struct DJBoothApp: App {
    @State private var model: BoothModel?
    @State private var incomingInvite: URL?
    @State private var startupError: String?
    @State private var startupTask: Task<BoothModel, Error>
    init() {
        #if os(iOS)
        AppDiagnostics.shared.start()
        #if DEBUG
        DJLinkHardwareControl.shared.start()
        #endif
        #endif
        PerformanceProbe.applicationBegan()
        // Open the local library while SwiftUI creates the first window.
        _startupTask = State(initialValue: BoothModel.startLoading())
    }
    private func receive(_ url: URL) {
        guard url.host == "join" || url.path.hasPrefix("/join/") else { return }
        if let model { model.receiveCrewInvite(url.absoluteString) }
        else { incomingInvite = url }
    }
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
                do {
                    model = try await startupTask.value
                    if let incomingInvite { model?.receiveCrewInvite(incomingInvite.absoluteString); self.incomingInvite = nil }
                }
                catch {
                    startupError = error.localizedDescription
                    #if os(iOS)
                    AppDiagnostics.shared.event("library_start_failed", ["error": error.localizedDescription])
                    #endif
                }
            }
            .onOpenURL { url in receive(url) }
            .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { activity in
                if let url = activity.webpageURL { receive(url) }
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
    @State private var creatingSharedPlaylist = false
    var body: some View {
        platformRoot
            .background(BoothStyle.background)
            .sheet(isPresented: $model.showSettings) { ConnectionSettings(model: model) }
            #if os(macOS)
            .sheet(isPresented: $model.showAgent) { MusicAgentView(model: model) }
            #endif
            .task(id: "agent:\(model.accountConnectionID):\(model.agentPendingID ?? ""):\(model.agentRetry):\(scenePhase)") {
                guard scenePhase == .active else { return }
                await model.observeAgentTurn()
            }
            #if os(iOS)
            .sheet(item: $model.pendingCrewInvite) { invite in CrewJoinView(model: model, invite: invite) }
            .sheet(isPresented: $model.crewMembersPresented) {
                if let crewID = model.selectedCrewID { CrewMembersView(model: model, crewID: crewID) }
            }
            .alert("New playlist", isPresented: $model.newCrewPlaylistPresented) {
                TextField("Playlist name", text: $collectionName)
                Button("Cancel", role: .cancel) { collectionName = "" }
                Button("Create") {
                    guard let crewID = model.selectedCrewID else { return }
                    let name = collectionName; collectionName = ""; creatingSharedPlaylist = true
                    Task {
                        defer { creatingSharedPlaylist = false }
                        do { try await model.createCrewCrate(crewID: crewID, name: name) }
                        catch { model.message = error.localizedDescription }
                    }
                }.disabled(collectionName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || creatingSharedPlaylist)
            } message: { Text("Everyone in this folder will have access.") }
            .sheet(isPresented: $model.showDJLink) { DJLinkConnectionView(model: model) }
            .sheet(isPresented: $model.showSonosSettings) { SonosOutputSheet(model: model) }
            #endif
            .sheet(item: $model.spotifySignIn, onDismiss: { model.spotifySignInDismissed() }) { source in
                SpotifyStreamingSignIn(source: source) { token in try await model.authorizeSpotify(source, token: token) }
            }
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
                #if os(iOS) && DEBUG
                DJLinkHardwareControl.shared.model = model
                #endif
                model.player.onAdvance = { track in
                    let index = model.player.pendingStreamQueueIndex ?? model.player.queueIndex
                    Task { await model.play(track, preservingQueue: true, queuePosition: index) }
                }
                async let analysis: Void = model.finishLoadingLibrary()
                if !PerformanceProbe.offline { await model.startup() }
                await analysis
            }
            .onChange(of: scenePhase) { _, phase in
                if phase != .active { model.persistAgentConversation() }
                if phase != .active {
                    model.persistPlaybackSession()
                    model.stopPhoneTools()
                    #if os(iOS)
                    if phase == .background {
                        model.sonos.suspendVolumeControl()
                        model.djLink.sceneChanged(background: true, audioPlaying: model.player.playing)
                    }
                    #endif
                }
                #if os(iOS)
                if phase == .active { model.djLink.sceneChanged(background: false, audioPlaying: model.player.playing) }
                #endif
            }
            .task(id: "\(model.accountConnectionID):\(scenePhase)") {
                guard scenePhase == .active, !model.demo else { return }
                await model.servePhoneTools()
            }
            .task(id: scenePhase) {
                guard scenePhase == .active else { return }
                while !Task.isCancelled {
                    await model.refreshUSBConnection()
                    do { try await Task.sleep(for: .seconds(2)) } catch { return }
                }
            }
            #if os(iOS)
            .task { await model.djLink.monitor(model: model) }
            .task(id: "sonos:\(model.accountConnectionID):\(scenePhase)") {
                guard scenePhase == .active else { return }
                await model.reconnectSonos()
            }
            #endif
            .task(id: "crews:\(model.accountConnectionID):\(scenePhase):\(model.crews.map(\.id).sorted().joined(separator: ","))") {
                guard scenePhase == .active, !model.demo else { return }
                await withTaskGroup(of: Void.self) { group in
                    group.addTask { await model.observeCrewUpdates(nil) }
                    for crew in model.crews {
                        group.addTask { await model.observeCrewUpdates(crew.id) }
                    }
                }
            }
            .task(id: scenePhase) {
                guard scenePhase == .active, !model.demo, !PerformanceProbe.offline else { return }
                while !Task.isCancelled {
                    do { try await Task.sleep(for: .seconds(20)) } catch { return }
                    await model.refreshCrews()
                    if let crewID = model.selectedCrewID { await model.loadCrew(crewID) }
                    if let crewID = model.selectedCrewID, let crateID = model.selectedCrewCrateID { await model.loadCrewCrate(crewID: crewID, crateID: crateID) }
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
        if model.needsMobileSignIn {
            MobileSignInView(model: model)
        } else {
            ZStack {
                MobileLibraryNavigation(model: model)
                    .allowsHitTesting(!model.showAgent).accessibilityHidden(model.showAgent)
                if model.showAgent { MusicAgentView(model: model).zIndex(1) }
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

struct PlaylistRemovalNotice: View {
    @Bindable var model: BoothModel
    var body: some View {
        if let undo = model.undoablePlaylistRemoval {
            HStack(spacing: 8) {
                Text("Removed “\(undo.trackTitle)”")
                    .boothFont(12, relativeTo: .caption).lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityLabel("Removed \(undo.trackTitle) from \(undo.collectionName)")
                Button { model.undoPlaylistRemoval() } label: {
                    Text("Undo").boothFont(13, relativeTo: .subheadline, weight: .semibold)
                        .frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
                }.foregroundStyle(BoothStyle.accent)
                    .accessibilityIdentifier("playlist.removal.undo")
                Button { model.dismissPlaylistRemovalUndo() } label: {
                    Image(systemName: "xmark").boothFont(12, relativeTo: .caption, weight: .medium)
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

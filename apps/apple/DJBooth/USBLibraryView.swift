import SwiftUI
import UniformTypeIdentifiers
import DJBoothKit

/// USB snapshots stay separate from the editable, synced library.
struct USBLibraryView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var pickingFolder = false
    @State private var selection: URL?
    @State private var library: USBRekordboxLibrary?
    @State private var loading = false
    @State private var failure: String?

    var body: some View {
        NavigationStack {
            Group {
                if loading {
                    ProgressView("Reading USB library…")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if let library {
                    USBPlaylistList(library: library, parentID: 0)
                } else {
                    ContentUnavailableView {
                        Label(failure == nil ? "Open a USB library" : "Could not read USB library", systemImage: "externaldrive")
                    } description: {
                        Text(failure ?? "Connect your USB stick, then choose its top-level folder in Files. Browse its Rekordbox playlists and track details.")
                    } actions: {
                        Button("Choose USB folder") { chooseFolder() }
                            .accessibilityIdentifier("usb.chooseFolder")
                    }
                }
            }
            .navigationTitle(library?.name ?? "USB library")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }.accessibilityIdentifier("usb.done")
                }
                ToolbarItem(placement: .primaryAction) {
                    if library != nil {
                        Button("Open another", systemImage: "externaldrive.badge.plus") { chooseFolder() }
                            .disabled(loading).accessibilityIdentifier("usb.openAnother")
                    }
                }
            }
        }
        .fileImporter(isPresented: $pickingFolder, allowedContentTypes: [.folder]) { result in
            switch result {
            case .success(let url):
                openFolder(url)
            case .failure(let error): library = nil; failure = error.localizedDescription
            }
        }
        .task(id: selection) {
            guard let selection else { return }
            loading = true
            // Detached work keeps file coordination, parsing, and USB I/O off the UI thread.
            let read = Task.detached(priority: .userInitiated) { try USBRekordboxLibrary.read(root: selection) }
            let result = await withTaskCancellationHandler {
                await read.result
            } onCancel: { read.cancel() }
            guard !Task.isCancelled else { return }
            loading = false
            switch result {
            case .success(let snapshot): library = snapshot
            case .failure(let error): failure = error.localizedDescription
            }
            self.selection = nil
        }
        .accessibilityIdentifier("usb.browser")
    }

    private func chooseFolder() {
        #if DEBUG && targetEnvironment(simulator)
        // Replace only folder selection in isolated UI tests. The actual USB
        // read, security scope, parsing, errors, and browser stay on the real path.
        if ProcessInfo.processInfo.arguments.contains("--ui-test-library"),
           let path = ProcessInfo.processInfo.environment["DJBOOTH_TEST_USB_ROOT"] {
            openFolder(URL(fileURLWithPath: path, isDirectory: true))
            return
        }
        #endif
        pickingFolder = true
    }

    private func openFolder(_ url: URL) {
        library = nil; failure = nil
        selection = url
    }
}

private struct USBPlaylistList: View {
    let library: USBRekordboxLibrary
    let parentID: UInt32

    var body: some View {
        List {
            if parentID == 0 {
                Section {
                    NavigationLink {
                        USBTrackList(library: library, title: "All tracks", trackIDs: library.tracks.map(\.id))
                    } label: {
                        Label("All tracks (\(library.tracks.count))", systemImage: "music.note.list")
                    }.accessibilityIdentifier("usb.allTracks")
                } footer: {
                    Text("Read-only snapshot · \(library.playlists.filter { !$0.isFolder }.count) playlists. Reopen the folder to refresh after changes on the stick.")
                }
            }
            Section("Playlists") {
                let children = library.children(of: parentID)
                if children.isEmpty { Text("No playlists").foregroundStyle(.secondary) }
                ForEach(children) { playlist in
                    NavigationLink {
                        if playlist.isFolder {
                            USBPlaylistList(library: library, parentID: playlist.id).navigationTitle(playlist.name)
                        } else {
                            USBTrackList(library: library, title: playlist.name, trackIDs: playlist.trackIDs)
                        }
                    } label: {
                        HStack {
                            Label(playlist.name, systemImage: playlist.isFolder ? "folder" : "music.note.list")
                            Spacer()
                            if !playlist.isFolder {
                                Text("\(playlist.trackIDs.count)").foregroundStyle(.secondary).monospacedDigit()
                            }
                        }
                    }.accessibilityIdentifier("usb.playlist.\(playlist.id)")
                }
            }
            if parentID == 0, !library.histories.isEmpty {
                Section("CDJ histories") {
                    ForEach(library.histories) { history in
                        NavigationLink {
                            USBTrackList(library: library, title: history.name, trackIDs: history.trackIDs)
                        } label: {
                            Label("\(history.name) (\(history.trackIDs.count))", systemImage: "clock")
                        }.accessibilityIdentifier("usb.history.\(history.id)")
                    }
                }
            }
        }
    }
}

private struct USBTrackList: View {
    let library: USBRekordboxLibrary
    let title: String
    let trackIDs: [UInt32]

    var body: some View {
        List {
            if trackIDs.isEmpty { Text("No tracks").foregroundStyle(.secondary) }
            // Positions are identities: a Rekordbox playlist can repeat a track.
            ForEach(Array(trackIDs.enumerated()), id: \.offset) { index, id in
                if let track = library.tracksByID[id] {
                    NavigationLink {
                        USBTrackDetails(track: track)
                    } label: {
                        HStack(spacing: 10) {
                            Text("\(index + 1)").font(.caption).foregroundStyle(.secondary).monospacedDigit()
                            VStack(alignment: .leading, spacing: 4) {
                                Text(track.title.isEmpty ? "Untitled track" : track.title).font(.subheadline.weight(.medium))
                                if !track.artist.isEmpty { Text(track.artist).font(.caption).foregroundStyle(.secondary) }
                            }
                            Spacer()
                            VStack(alignment: .trailing, spacing: 4) {
                                if track.bpm > 0 { Text("\(track.bpm, format: .number.precision(.fractionLength(0...2))) BPM") }
                                if !track.key.isEmpty { Text(track.key) }
                            }.font(.caption2).foregroundStyle(.secondary)
                        }
                    }.accessibilityIdentifier("usb.track.\(index)")
                } else {
                    Label("\(index + 1). Missing track (ID \(id))", systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.secondary)
                }
            }
        }.navigationTitle(title)
    }
}

private struct USBTrackDetails: View {
    let track: USBRekordboxLibrary.Track
    var body: some View {
        Form {
            Section("Track") {
                LabeledContent("Title", value: track.title)
                LabeledContent("Artist", value: track.artist)
                LabeledContent("Album", value: track.album)
                LabeledContent("Genre", value: track.genre)
                LabeledContent("Key", value: track.key)
                LabeledContent("BPM", value: track.bpm > 0 ? track.bpm.formatted(.number.precision(.fractionLength(0...2))) : "—")
                LabeledContent("Duration", value: String(format: "%d:%02d", track.duration / 60, track.duration % 60))
            }
            if !track.comment.isEmpty { Section("Comments") { Text(track.comment) } }
            Section("File on USB") { Text(track.filePath).font(.caption).textSelection(.enabled) }
        }.navigationTitle("Track details")
    }
}

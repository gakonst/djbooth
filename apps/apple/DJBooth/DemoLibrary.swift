import DJBoothKit

enum DemoLibrary {
    // Debug previews only. These fixtures never fall back into a live or release library.
    static let tracks: [Track] = [
        Track(id: "demo-1", title: "Luminous Spaces", artist: "Jon Hopkins & Kelly Lee Owens", album: "Luminous Spaces", genre: "Electronic", key: "8A", bpm: 125, durationSeconds: 493),
        Track(id: "demo-2", title: "Glue", artist: "Bicep", album: "Bicep", genre: "Breakbeat", key: "6A", bpm: 129, durationSeconds: 269),
        Track(id: "demo-3", title: "LesAlpx", artist: "Floating Points", album: "Crush", genre: "Electronic", key: "5A", bpm: 130, durationSeconds: 281),
        Track(id: "demo-4", title: "Nespole", artist: "Floating Points", album: "Elaenia", genre: "Downtempo", key: "11A", bpm: 110, durationSeconds: 304),
        Track(id: "demo-5", title: "A Walk", artist: "Tycho", album: "Dive", genre: "Ambient", key: "3B", bpm: 100, durationSeconds: 316,
              waveform: Waveform(peaks: [0.12, 0.4, 0.72, 0.32, 0.84, 0.48, 0.3, 0.68, 0.22, 0.91, 0.6, 0.37, 0.8, 0.42, 0.66, 0.24], source: "demo", durationSeconds: 316)),
        Track(id: "demo-6", title: "Kerala", artist: "Bonobo", album: "Migration", genre: "Electronica", key: "9A", bpm: 125, durationSeconds: 237),
        Track(id: "demo-7", title: "Two Thousand and Seventeen", artist: "Four Tet", album: "New Energy", genre: "Downtempo", key: "7A", bpm: 90, durationSeconds: 252),
        Track(id: "demo-8", title: "Sundial", artist: "Bicep", album: "Isles", genre: "House", key: "10A", bpm: 128, durationSeconds: 274),
        Track(id: "demo-9", title: "Open Eye Signal", artist: "Jon Hopkins", album: "Immunity", genre: "Techno", key: "8A", bpm: 123, durationSeconds: 472)
    ]
    static let collections: [Collection] = [
        Collection(id: "demo-c1", name: "After hours", trackIDs: ["demo-1", "demo-3", "demo-9"]),
        Collection(id: "demo-c2", name: "Slow mornings", trackIDs: ["demo-4", "demo-5", "demo-7"]),
        Collection(id: "demo-c3", name: "The warm-up", trackIDs: ["demo-2", "demo-6", "demo-8"]),
        Collection(id: "demo-c4", name: "Left of center", trackIDs: ["demo-3", "demo-4", "demo-9"])
    ]
    #if DEBUG
    static let longPlaylistTracks: [Track] = (1...24).map { index in
        var track = tracks[4]
        track.id = "demo-scroll-\(index)"
        track.title = "Preview track \(index)"
        return track
    }
    static let longPlaylist = Collection(id: "demo-scroll", name: "Long preview playlist", trackIDs: longPlaylistTracks.map(\.id))
    #endif
}

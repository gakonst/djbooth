import SwiftUI
import DJBoothKit

extension TrackColor {
    var tint: Color {
        switch self {
        case .red: Color(red: 0.94, green: 0.27, blue: 0.27)
        case .blue: Color(red: 0.23, green: 0.51, blue: 0.96)
        case .pink: Color(red: 0.93, green: 0.28, blue: 0.60)
        case .cyan: Color(red: 0.13, green: 0.83, blue: 0.93)
        }
    }
    var label: String { rawValue.capitalized }
}

struct TrackColorMenu: View {
    let track: Track
    @Bindable var model: BoothModel
    var swatchSize: CGFloat = 11
    @Environment(\.accessibilityDifferentiateWithoutColor) private var differentiate
    @Environment(\.colorSchemeContrast) private var contrast
    var body: some View {
        let color = model.annotation(for: track).color
        Menu {
            Button("None") { model.setColor(nil, for: track) }.accessibilityIdentifier("track.color.none")
            ForEach(TrackColor.allCases, id: \.self) { color in
                Button { model.setColor(color, for: track) } label: {
                    Label(color.label, systemImage: model.annotation(for: track).color == color ? "checkmark.circle.fill" : "circle.fill")
                }.tint(color.tint).accessibilityIdentifier("track.color.\(color.rawValue)")
            }
        } label: {
            RoundedRectangle(cornerRadius: 2)
                .fill(color?.tint ?? BoothStyle.raised)
                .frame(width: differentiate ? max(24, swatchSize) : swatchSize, height: differentiate ? max(24, swatchSize) : swatchSize)
                .overlay(RoundedRectangle(cornerRadius: 2).stroke(.white.opacity(contrast == .increased ? 0.85 : 0.45), lineWidth: 1))
                .overlay {
                    if differentiate { Text(color.map { String($0.label.prefix(1)) } ?? "–").font(.caption2.bold()).foregroundStyle(color == nil ? .white : .black) }
                }
                .frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
        }.menuStyle(.borderlessButton)
            .accessibilityLabel("Color for \(track.title)")
            .accessibilityValue(model.annotation(for: track).color?.label ?? "None")
    }
}

struct TrackAnnotationEditor: View {
    let track: Track
    @Bindable var model: BoothModel
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    VStack(alignment: .leading, spacing: 5) {
                        Text(track.title).font(.headline)
                        Text(track.artist ?? "Unknown artist").font(.subheadline).foregroundStyle(.secondary)
                    }
                    AnalysisWaveform(waveform: track.waveform, compact: true)
                        .frame(height: 48).allowsHitTesting(false)
                    HStack {
                        Text(track.bpm.map { String(format: "%.1f BPM", $0) } ?? "— BPM")
                        Text(track.key ?? "—").foregroundStyle(BoothStyle.accent)
                        Spacer()
                        Text(timeLabel(track.durationSeconds))
                    }.font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                    Text("COLOR").font(.system(size: 10, weight: .semibold, design: .monospaced)).foregroundStyle(.secondary)
                    HStack(spacing: 12) {
                        colorButton(nil)
                        ForEach(TrackColor.allCases, id: \.self) { color in colorButton(color) }
                    }
                    Text("COMMENT").font(.system(size: 10, weight: .semibold, design: .monospaced)).foregroundStyle(.secondary)
                    TextField("Add a comment…", text: Binding(
                        get: { model.annotation(for: track).note },
                        set: { model.setNote($0, for: track) }), axis: .vertical)
                        .lineLimit(5...12).font(.body).textFieldStyle(.plain)
                        .padding(12).background(BoothStyle.surface, in: RoundedRectangle(cornerRadius: 8))
                        .accessibilityIdentifier("track.comment.editor")
                    Label("Saved on this device", systemImage: "checkmark.circle")
                        .font(.caption).foregroundStyle(.secondary)
                }.padding(16)
            }.background(BoothStyle.background)
                .navigationTitle("Comment & color")
                #if os(iOS)
                .navigationBarTitleDisplayMode(.inline)
                #endif
                .toolbar { ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }.accessibilityIdentifier("track.details.done")
                } }
        }
        #if os(macOS)
        .frame(minWidth: 440, minHeight: 500)
        #endif
    }
    private func colorButton(_ color: TrackColor?) -> some View {
        Button { model.setColor(color, for: track) } label: {
            ZStack {
                RoundedRectangle(cornerRadius: 6).fill(color?.tint ?? BoothStyle.raised)
                if model.annotation(for: track).color == color {
                    Image(systemName: "checkmark").font(.system(size: 15, weight: .bold)).foregroundStyle(color == nil ? Color.white : Color.black)
                } else if color == nil {
                    Image(systemName: "slash.circle").foregroundStyle(.secondary)
                }
            }.frame(width: 44, height: 44)
        }.buttonStyle(BoothRowButtonStyle())
            .accessibilityLabel(color?.label ?? "None")
            .accessibilityValue(model.annotation(for: track).color == color ? "Selected" : "Not selected")
            .accessibilityIdentifier("track.color.\(color?.rawValue ?? "none")")
    }
}

/// Current recording, its queue, and inline annotations stay anchored while browsing.
struct MobileNowPlaying: View {
    @Bindable var model: BoothModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.accessibilityDifferentiateWithoutColor) private var differentiateWithoutColor
    @Environment(\.colorSchemeContrast) private var contrast
    @FocusState private var noteFocused: Bool
    private var waveformCache: PlaybackWaveformCache { model.playbackWaveformCache }
    @State private var swipeOffset: CGFloat = 0
    @State private var horizontalSwipe: Bool?
    @State private var colorPaletteOpen = false
    var body: some View {
        let track = model.player.track
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                if let track {
                    Button {
                        noteFocused = false
                        colorPaletteOpen.toggle()
                    } label: {
                        colorSwatch(model.annotation(for: track).color)
                    }.buttonStyle(BoothRowButtonStyle())
                        .accessibilityLabel("Color for \(track.title)")
                        .accessibilityValue(model.annotation(for: track).color?.label ?? "None")
                        .accessibilityHint(colorPaletteOpen ? "Hide color choices" : "Show color choices")
                        .accessibilityIdentifier("nowPlaying.color")
                } else {
                    Rectangle().fill(.white.opacity(0.10)).frame(width: 24, height: 24).frame(width: 44, height: 44)
                        .accessibilityHidden(true)
                }
                ZStack(alignment: .leading) {
                    // Retain the field's Dynamic Type height while its palette is visible.
                    TextField("Add a comment…", text: Binding(
                        get: { track.map { model.annotation(for: $0).note } ?? "" },
                        set: { note in if let track { model.setNote(note, for: track) } }))
                        .boothFont(13, relativeTo: .subheadline).textFieldStyle(.plain)
                        .frame(minHeight: 44).padding(.horizontal, 8)
                        .background(BoothStyle.raised, in: RoundedRectangle(cornerRadius: 8))
                        .focused($noteFocused).submitLabel(.done).onSubmit { noteFocused = false }
                        .disabled(track == nil).id(track?.id)
                        .accessibilityLabel("Track comment").accessibilityIdentifier("nowPlaying.annotation")
                        .opacity(colorPaletteOpen ? 0 : 1).allowsHitTesting(!colorPaletteOpen)
                        .accessibilityHidden(colorPaletteOpen)
                    if colorPaletteOpen, let track {
                        HStack(spacing: 4) {
                            colorChoice(nil, for: track)
                            ForEach(TrackColor.allCases, id: \.self) { color in colorChoice(color, for: track) }
                        }.frame(maxWidth: .infinity, alignment: .leading)
                            .accessibilityElement(children: .contain).accessibilityIdentifier("nowPlaying.color.palette")
                            .transition(.identity)
                    }
                }
            }.padding(.horizontal, 8).padding(.vertical, 4)
                .overlay(alignment: .bottom) { Rectangle().fill(BoothStyle.border).frame(height: 0.5) }
                .transaction { transaction in
                    transaction.animation = nil
                    transaction.disablesAnimations = true
                }
            PlaybackWaveform(player: model.player, cache: waveformCache)
                .frame(height: 64)
            VStack(spacing: 5) {
                PlaybackQueueStrip(model: model)
                Group {
                    if typeSize.isAccessibilitySize {
                        VStack(alignment: .leading, spacing: 6) {
                            HStack(spacing: 12) {
                                swipeSurface { currentTitle(track).frame(maxWidth: .infinity, alignment: .leading) }
                                playButton
                            }
                            currentArtist(track).frame(maxWidth: .infinity, alignment: .leading)
                            ViewThatFits(in: .horizontal) {
                                HStack(spacing: 10) { currentAnalysis(track) }.fixedSize(horizontal: true, vertical: false)
                                VStack(alignment: .leading, spacing: 4) { currentAnalysis(track) }
                            }
                        }
                    } else {
                        HStack(spacing: 12) {
                            swipeSurface {
                                HStack(spacing: 10) {
                                    VStack(alignment: .leading, spacing: 4) {
                                        currentTitle(track)
                                        currentArtist(track)
                                    }.frame(maxWidth: .infinity, alignment: .leading)
                                    VStack(alignment: .trailing, spacing: 4) { currentAnalysis(track) }
                                        .fixedSize(horizontal: true, vertical: false)
                                }
                            }
                            playButton
                        }
                    }
                }.padding(.vertical, 5)
                    .background { PlaybackOverviewBackground(player: model.player, cache: waveformCache) }
                    .animation(reduceMotion ? nil : .easeOut(duration: 0.16), value: track?.id)
                PlaybackProgress(player: model.player)
            }.padding(.horizontal, 12).padding(.top, 9).padding(.bottom, 3)
                .clipped()
        }.background(BoothStyle.surface)
            .background { PlaybackWaveformLoader(player: model.player, cache: waveformCache) }
            .overlay(alignment: .top) { Rectangle().fill(BoothStyle.border).frame(height: 0.5) }
            .accessibilityElement(children: .contain).accessibilityIdentifier("nowPlaying.bottom")
            .onChange(of: track?.id) { _, _ in noteFocused = false; colorPaletteOpen = false }
    }
    private func colorChoice(_ color: TrackColor?, for track: Track) -> some View {
        let selected = model.annotation(for: track).color == color
        return Button {
            guard model.player.track?.id == track.id else { colorPaletteOpen = false; return }
            model.setColor(color, for: track)
            colorPaletteOpen = false
        } label: {
            colorSwatch(color, selected: selected)
        }.buttonStyle(BoothRowButtonStyle())
            .accessibilityLabel(color?.label ?? "None")
            .accessibilityValue(selected ? "Selected" : "Not selected")
            .accessibilityIdentifier("track.color.\(color?.rawValue ?? "none")")
    }
    private func colorSwatch(_ color: TrackColor?, selected: Bool = false) -> some View {
        Rectangle().fill(color?.tint ?? BoothStyle.raised).frame(width: 24, height: 24)
            .overlay(Rectangle().stroke(.white.opacity(contrast == .increased ? 0.85 : 0.45), lineWidth: 1))
            .overlay {
                if selected {
                    Image(systemName: "checkmark").font(.system(size: 13, weight: .bold))
                        .foregroundStyle(color == nil ? .white : .black)
                } else if differentiateWithoutColor {
                    Text(color.map { String($0.label.prefix(1)) } ?? "–").font(.caption2.bold())
                        .foregroundStyle(color == nil ? .white : .black)
                } else if color == nil {
                    Image(systemName: "slash.circle").font(.system(size: 14)).foregroundStyle(.secondary)
                }
            }.frame(width: 44, height: 44).contentShape(Rectangle())
    }
    private func currentTitle(_ track: Track?) -> some View {
        NowPlayingTitle(text: track?.title ?? "No track selected", trackID: track?.id,
            playing: model.player.playing,
            availability: track.map { model.offlineIDs.contains($0.id) ? "Available offline" : "Not on this device" } ?? "No track selected")
    }
    private func currentArtist(_ track: Track?) -> some View {
        Text(track.map { $0.artist ?? "Unknown artist" } ?? "Choose a track from your library")
            .boothFont(12, relativeTo: .caption).foregroundStyle(.secondary).lineLimit(1)
    }
    @ViewBuilder private func currentAnalysis(_ track: Track?) -> some View {
        Text("\(track?.bpm.map { String(format: "%.1f", $0) } ?? "—") BPM")
            .boothFont(12, relativeTo: .caption, weight: .semibold, design: .monospaced)
            .fixedSize(horizontal: true, vertical: false)
        Text(track?.key ?? "—").boothFont(11, relativeTo: .caption2, weight: .semibold, design: .monospaced)
            .fixedSize(horizontal: true, vertical: false)
            .padding(.horizontal, 8).padding(.vertical, 2)
            .background(.white.opacity(0.08)).overlay(Rectangle().stroke(.white.opacity(0.55), lineWidth: 0.5))
    }
    private func swipeSurface<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        content().offset(x: reduceMotion ? 0 : swipeOffset)
            .contentShape(Rectangle()).simultaneousGesture(playerSwipe)
            .accessibilityElement(children: .contain).accessibilityIdentifier("nowPlaying.surface")
            .accessibilityAction(named: "Previous track") { model.player.advance(-1) }
            .accessibilityAction(named: "Next track") { model.player.advance(1) }
    }
    private var playButton: some View {
        Button { Task { await model.togglePlayback() } } label: {
            Image(systemName: model.player.transportPlaying ? "pause.fill" : "play.fill")
                .font(.title3.weight(.semibold)).frame(minWidth: 24, minHeight: 24).padding(3)
                .foregroundStyle(.black)
        }.modifier(BoothTransportStyle()).controlSize(.large)
            .frame(minWidth: 44, minHeight: 44)
            .accessibilityLabel(model.player.transportPlaying ? "Pause" : "Play")
            .accessibilityIdentifier("nowPlaying.play").disabled(model.player.track == nil)
    }
    private var playerSwipe: some Gesture {
        DragGesture(minimumDistance: 8)
            .onChanged { value in
                if horizontalSwipe == nil {
                    horizontalSwipe = abs(value.translation.width) > abs(value.translation.height)
                }
                guard horizontalSwipe == true else { return }
                swipeOffset = min(80, max(-80, value.translation.width * 0.65))
            }
            .onEnded { value in
                if horizontalSwipe == true, abs(value.translation.width) >= 64 {
                    model.player.advance(value.translation.width < 0 ? 1 : -1)
                }
                withAnimation(reduceMotion ? nil : .easeOut(duration: 0.16)) { swipeOffset = 0 }
                horizontalSwipe = nil
            }
    }
}

/// Elapsed-time observations stay here instead of rebuilding the entire footer and queue.
private struct PlaybackProgress: View {
    let player: BoothPlayer
    @State private var scrubID: UUID?
    @Environment(\.scenePhase) private var scenePhase
    var body: some View {
        let trackID = player.track?.id
        let seekRevision = player.seekRevision
        let elapsed = player.scrubPosition ?? player.elapsed
        let duration = player.duration
        HStack(spacing: 8) {
            Text(timeLabel(elapsed)).fixedSize().accessibilityLabel("Elapsed time")
                .accessibilityValue(timeLabel(elapsed)).accessibilityIdentifier("nowPlaying.elapsed")
            #if os(iOS)
            PlaybackPositionSlider(trackID: trackID, seekRevision: seekRevision, value: elapsed, duration: duration,
                onBegin: {
                    guard trackID == player.track?.id, seekRevision == player.seekRevision else { return false }
                    scrubID = player.beginScrubbing()
                    return scrubID != nil
                },
                onPreview: { value in
                    if let scrubID { player.updateScrubbing(scrubID, to: value) }
                }, onCommit: { value in
                    guard trackID == player.track?.id, seekRevision == player.seekRevision else { return }
                    if let scrubID { player.endScrubbing(scrubID, at: value) }
                    else { player.seek(value) }
                    scrubID = nil
                }, onCancel: { cancelScrub() })
                .frame(minWidth: 44, minHeight: 44)
            #else
            Slider(value: Binding(
                get: { min(max(0, elapsed), max(1, duration)) },
                set: { value in
                    guard trackID == player.track?.id else { return }
                    if let scrubID { player.updateScrubbing(scrubID, to: value) }
                    else if player.track != nil { player.seek(value) }
                }), in: 0...max(1, duration), onEditingChanged: { active in
                    guard trackID == player.track?.id else { return }
                    if active {
                        scrubID = player.beginScrubbing()
                    } else {
                        if let scrubID { player.endScrubbing(scrubID, at: player.scrubPosition ?? player.elapsed) }
                        scrubID = nil
                    }
                })
                .tint(.white).frame(minWidth: 44, minHeight: 44)
                .disabled(player.track == nil || duration <= 0)
                .accessibilityLabel("Playback position")
                .accessibilityValue("\(timeLabel(elapsed)) of \(timeLabel(duration))")
                .accessibilityIdentifier("nowPlaying.progress")
                .id(trackID)
            #endif
            Text(timeLabel(duration)).fixedSize().accessibilityLabel("Duration")
                .accessibilityValue(timeLabel(duration)).accessibilityIdentifier("nowPlaying.duration")
        }.boothFont(11, relativeTo: .caption2, design: .monospaced).foregroundStyle(.secondary)
            .accessibilityElement(children: .contain).accessibilityIdentifier("nowPlaying.time")
            .onChange(of: player.track?.id) { _, _ in scrubID = nil }
            .onChange(of: player.seekRevision) { _, _ in scrubID = nil }
            .onChange(of: scenePhase) { _, phase in if phase != .active { cancelScrub() } }
            .onDisappear { cancelScrub() }
    }
    private func cancelScrub() {
        if let scrubID { player.cancelScrubbing(scrubID) }
        scrubID = nil
    }
}

private struct PlaybackQueueStrip: View {
    @Bindable var model: BoothModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorSchemeContrast) private var contrast
    @Environment(\.dynamicTypeSize) private var typeSize
    @ScaledMetric(relativeTo: .caption) private var itemWidth = 136.0
    @ScaledMetric(relativeTo: .caption) private var titleLine = 15.0
    @ScaledMetric(relativeTo: .caption2) private var artistLine = 14.0
    var body: some View {
        let currentIndex = model.player.queueIndex
        let queue = model.player.queue
        ScrollViewReader { proxy in
            ScrollView(.horizontal, showsIndicators: false) {
                LazyHStack(spacing: 6) {
                    ForEach(Array(queue.enumerated()), id: \.offset) { position, track in
                        let selected = position == currentIndex
                        Button { Task { await model.play(track, preservingQueue: true, queuePosition: position) } } label: {
                            VStack(alignment: .leading, spacing: 3) {
                                HStack(spacing: 4) {
                                    if selected { Image(systemName: "waveform").font(.caption2).accessibilityHidden(true) }
                                    Text(track.title).boothFont(12, relativeTo: .caption, weight: selected ? .semibold : .regular).lineLimit(1)
                                }
                                if !typeSize.isAccessibilitySize {
                                    Text(track.artist ?? "Unknown artist").boothFont(11, relativeTo: .caption2).foregroundStyle(.secondary).lineLimit(1)
                                }
                            }.frame(width: itemWidth, alignment: .leading).padding(.horizontal, 8).padding(.vertical, 7)
                                .frame(minHeight: 44)
                                .background(selected ? BoothStyle.raised : Color.white.opacity(contrast == .increased ? 0.08 : 0.025))
                                .overlay(alignment: .bottom) {
                                    Rectangle().fill(selected ? Color.white.opacity(0.85) : .clear).frame(height: 1)
                                }.contentShape(Rectangle())
                        }.buttonStyle(BoothRowButtonStyle()).id(position)
                            .accessibilityLabel("Play \(track.title)")
                            .accessibilityHint(track.artist ?? "Unknown artist")
                            .accessibilityValue(selected ? (model.player.playing ? "Playing" : "Paused") : "Queued")
                            .accessibilityIdentifier("nowPlaying.queue.track.\(track.id)")
                    }
                }
            }
            .frame(height: queue.isEmpty ? 0 : max(44, titleLine + (typeSize.isAccessibilitySize ? 0 : artistLine + 3) + 14))
            .accessibilityElement(children: .contain).accessibilityIdentifier("nowPlaying.queue")
            .onChange(of: currentIndex, initial: true) { _, index in
                withAnimation(reduceMotion ? nil : .easeOut(duration: 0.16)) { proxy.scrollTo(index, anchor: .leading) }
            }
            .onChange(of: model.player.track?.id) { _, _ in
                withAnimation(reduceMotion ? nil : .easeOut(duration: 0.16)) { proxy.scrollTo(currentIndex, anchor: .leading) }
            }
        }
    }
}

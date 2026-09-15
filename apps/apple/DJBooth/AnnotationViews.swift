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
    var body: some View {
        Menu {
            Button("None") { model.setColor(nil, for: track) }.accessibilityIdentifier("track.color.none")
            ForEach(TrackColor.allCases, id: \.self) { color in
                Button { model.setColor(color, for: track) } label: {
                    Label(color.label, systemImage: model.annotation(for: track).color == color ? "checkmark.circle.fill" : "circle.fill")
                }.tint(color.tint).accessibilityIdentifier("track.color.\(color.rawValue)")
            }
        } label: {
            RoundedRectangle(cornerRadius: 2)
                .fill(model.annotation(for: track).color?.tint ?? Color.white.opacity(0.16))
                .frame(width: swatchSize, height: swatchSize)
                .overlay(RoundedRectangle(cornerRadius: 2).stroke(.white.opacity(0.25), lineWidth: 0.5))
                .padding(8).contentShape(Rectangle())
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
            }.frame(width: 44, height: 38)
        }.buttonStyle(.plain)
            .accessibilityLabel(color?.label ?? "None")
            .accessibilityValue(model.annotation(for: track).color == color ? "Selected" : "Not selected")
            .accessibilityIdentifier("track.color.\(color?.rawValue ?? "none")")
    }
}

/// Current recording, its queue, and inline annotations stay anchored while browsing.
struct MobileNowPlaying: View {
    @Bindable var model: BoothModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @FocusState private var noteFocused: Bool
    @State private var waveformCache = PlaybackWaveformCache()
    @State private var swipeOffset: CGFloat = 0
    @State private var horizontalSwipe: Bool?
    var body: some View {
        let track = model.player.track
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                if let track {
                    TrackColorMenu(track: track, model: model, swatchSize: 24)
                        .accessibilityIdentifier("nowPlaying.color")
                } else {
                    Rectangle().fill(.white.opacity(0.10)).frame(width: 24, height: 24).padding(8)
                        .accessibilityHidden(true)
                }
                TextField("add note", text: Binding(
                    get: { track.map { model.annotation(for: $0).note } ?? "" },
                    set: { note in if let track { model.setNote(note, for: track) } }))
                    .font(.system(size: 13)).textFieldStyle(.plain)
                    .focused($noteFocused).submitLabel(.done).onSubmit { noteFocused = false }
                    .disabled(track == nil).id(track?.id)
                    .accessibilityLabel("Track comment").accessibilityIdentifier("nowPlaying.annotation")
            }.padding(.horizontal, 8).padding(.vertical, 2)
                .overlay(alignment: .bottom) { Rectangle().fill(BoothStyle.border).frame(height: 0.5) }
            PlaybackWaveform(player: model.player, cache: waveformCache)
                .frame(height: 64)
            VStack(spacing: 5) {
                PlaybackQueueStrip(model: model)
                HStack(spacing: 12) {
                    HStack(spacing: 10) {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(track?.title ?? "No track selected").font(.system(size: 17, weight: .semibold)).lineLimit(1)
                                .accessibilityIdentifier("nowPlaying.title")
                                .accessibilityValue(track.map { model.offlineIDs.contains($0.id) ? "Available offline" : "Not on this device" } ?? "No track selected")
                            Text(track.map { $0.artist ?? "Unknown artist" } ?? "Choose a track from your library")
                                .font(.system(size: 12)).foregroundStyle(.secondary).lineLimit(1)
                        }.frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
                        VStack(alignment: .trailing, spacing: 4) {
                            Text("\(track?.bpm.map { String(format: "%.1f", $0) } ?? "—") BPM")
                                .font(.system(size: 12, weight: .semibold, design: .monospaced))
                            Text(track?.key ?? "—").font(.system(size: 10, weight: .semibold, design: .monospaced))
                                .padding(.horizontal, 8).padding(.vertical, 2)
                                .background(.white.opacity(0.08)).overlay(Rectangle().stroke(.white.opacity(0.55), lineWidth: 0.5))
                        }.fixedSize(horizontal: true, vertical: false)
                    }.offset(x: reduceMotion ? 0 : swipeOffset)
                        .contentShape(Rectangle()).simultaneousGesture(playerSwipe)
                        .accessibilityElement(children: .contain).accessibilityIdentifier("nowPlaying.surface")
                        .accessibilityAction(named: "Previous track") { model.player.advance(-1) }
                        .accessibilityAction(named: "Next track") { model.player.advance(1) }
                    Button { Task { await model.togglePlayback() } } label: {
                        Image(systemName: model.player.playing ? "pause.fill" : "play.fill")
                            .font(.system(size: 17, weight: .semibold)).frame(width: 44, height: 44)
                            .background(.white).foregroundStyle(.black)
                    }.buttonStyle(.plain).accessibilityLabel(model.player.playing ? "Pause" : "Play")
                        .accessibilityIdentifier("nowPlaying.play").disabled(track == nil)
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
            .onChange(of: track?.id) { _, _ in noteFocused = false }
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
    var body: some View {
        let elapsed = player.elapsed
        let duration = player.duration
        let progress = min(1, max(0, elapsed / max(1, duration)))
        VStack(spacing: 5) {
            HStack {
                Text(timeLabel(elapsed))
                Spacer()
                Text(timeLabel(duration))
            }.font(.system(size: 9, design: .monospaced)).foregroundStyle(.secondary)
                .accessibilityElement(children: .combine).accessibilityIdentifier("nowPlaying.time")
            GeometryReader { geometry in
                ZStack(alignment: .leading) {
                    Rectangle().fill(.white.opacity(0.15))
                    Rectangle().fill(.white).frame(width: geometry.size.width * progress)
                }.frame(height: 3).frame(maxHeight: .infinity)
                    .contentShape(Rectangle())
                    .gesture(DragGesture(minimumDistance: 0).onChanged { value in
                        guard player.track != nil, geometry.size.width > 0 else { return }
                        player.seek(min(1, max(0, value.location.x / geometry.size.width)) * player.duration)
                    })
            }.frame(height: 10).accessibilityLabel("Playback position")
                .accessibilityValue("\(timeLabel(elapsed)) of \(timeLabel(duration))")
                .accessibilityAdjustableAction { direction in player.seek(player.elapsed + (direction == .increment ? 5 : -5)) }
                .accessibilityIdentifier("nowPlaying.progress")
        }
    }
}

private struct PlaybackQueueStrip: View {
    @Bindable var model: BoothModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        let currentID = model.player.track?.id
        let queue = model.player.queue
        ScrollViewReader { proxy in
            ScrollView(.horizontal, showsIndicators: false) {
                LazyHStack(spacing: 6) {
                    ForEach(queue) { track in
                        let selected = track.id == currentID
                        Button { Task { await model.play(track, preservingQueue: true) } } label: {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(track.title).font(.system(size: 11, weight: selected ? .semibold : .regular)).lineLimit(1)
                                Text(track.artist ?? "Unknown artist").font(.system(size: 9)).foregroundStyle(.secondary).lineLimit(1)
                            }.frame(width: 122, alignment: .leading).padding(.horizontal, 8).padding(.vertical, 7)
                                .background(selected ? Color.white.opacity(0.10) : Color.white.opacity(0.025))
                                .overlay(alignment: .bottom) {
                                    Rectangle().fill(selected ? Color.white.opacity(0.85) : .clear).frame(height: 1)
                                }.contentShape(Rectangle())
                        }.buttonStyle(.plain).id(track.id)
                            .accessibilityLabel("Play \(track.title)")
                            .accessibilityValue(selected ? (model.player.playing ? "Playing" : "Paused") : "Queued")
                            .accessibilityIdentifier("nowPlaying.queue.track.\(track.id)")
                    }
                }
            }
            .frame(height: queue.isEmpty ? 0 : 43)
            .accessibilityElement(children: .contain).accessibilityIdentifier("nowPlaying.queue")
            .onChange(of: currentID, initial: true) { _, id in
                guard let id else { return }
                withAnimation(reduceMotion ? nil : .easeOut(duration: 0.16)) { proxy.scrollTo(id, anchor: .leading) }
            }
        }
    }
}

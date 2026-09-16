import SwiftUI
import DJBoothKit
import CoreGraphics
#if os(iOS)
import UIKit
#endif

@MainActor @Observable final class PlaybackWaveformCache {
    fileprivate private(set) var content: PlaybackWaveformContent?
    private var loadedRequest: PlaybackWaveformRequest?
    private var generation = UUID()

    func load(_ waveform: Waveform?, trackID: String?) async {
        let request = PlaybackWaveformRequest(trackID: trackID, waveform: waveform)
        guard loadedRequest != request else { return }
        loadedRequest = nil
        let operation = UUID(); generation = operation
        if content?.trackID != trackID { content = nil }
        guard let waveform, let trackID else { content = nil; loadedRequest = request; return }
        let job = Task.detached(priority: .userInitiated) { PlaybackWaveformContent.make(waveform, trackID: trackID) }
        let result = await withTaskCancellationHandler {
            await job.value
        } onCancel: { job.cancel() }
        guard !Task.isCancelled, generation == operation else { return }
        content = result
        loadedRequest = request
    }
}

/// This node observes track data only: playback ticks do not hash the waveform task ID.
struct PlaybackWaveformLoader: View {
    let player: BoothPlayer
    let cache: PlaybackWaveformCache
    var body: some View {
        let request = PlaybackWaveformRequest(trackID: player.track?.id, waveform: player.track?.waveform)
        Color.clear.frame(width: 0, height: 0).accessibilityHidden(true)
            .task(id: request) { await cache.load(request.waveform, trackID: request.trackID) }
    }
}

private struct PlaybackWaveformRequest: Equatable {
    let trackID: String?
    let waveform: Waveform?
}

/// Eight musical bars from the actual Rekordbox grid, never a BPM-derived estimate.
struct PlaybackWaveform: View {
    let player: BoothPlayer
    let cache: PlaybackWaveformCache
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.colorSchemeContrast) private var contrast
    @State private var scrub: WaveformScrubPreview?

    var body: some View {
        let timing = player.timing
        let clock = player.mediaClock
        let trackID = player.track?.id
        let content = cache.content?.trackID == trackID ? cache.content : nil
        let waveformDuration = content?.duration ?? 0
        let duration = waveformDuration > 0 ? waveformDuration : timing.duration
        let heldPosition = player.scrubPosition
        let currentPosition = heldPosition ?? clock.position()
        let hasWindow = content?.grid?.centeredBarWindow(at: currentPosition, bars: 8, duration: duration) != nil
        let overview = reduceMotion || !hasWindow
        let preview = scrub.flatMap { $0.trackID == trackID && player.isScrubbing($0.id) ? $0 : nil }
        let animated = timing.playing && scenePhase == .active && !overview && content != nil && heldPosition == nil
        let highContrast = contrast == .increased
        TimelineView(.animation(minimumInterval: 1.0 / 60.0, paused: !animated)) { _ in
            let position = heldPosition ?? clock.position()
            let window = overview ? nil : content?.grid?.centeredBarWindow(at: position, bars: 8, duration: duration)
            Canvas { context, size in
                let mid = size.height / 2
                context.fill(Path(CGRect(x: 0, y: mid, width: size.width, height: 0.5)), with: .color(.white.opacity(0.12)))
                guard let content, duration > 0, size.width > 0 else { return }
                let span = preview?.span ?? window.map { $0.end - $0.start } ?? duration
                let start = preview.map { position - $0.span / 2 } ?? window?.start ?? 0
                guard span > 0 else { return }
                let scale = size.width / span
                context.opacity = 0.86
                context.draw(Image(decorative: content.raster.image, scale: 1),
                             in: CGRect(x: -start * scale, y: 0, width: duration * scale, height: size.height))
                context.opacity = 1
                if let grid = content.grid, preview != nil || window != nil {
                    var beats = Path(), downbeats = Path(), markers = Path()
                    for index in grid.beatRange(from: max(0, start), to: min(duration, start + span)) {
                        let x = (grid.times[index] - start) * scale
                        if grid.beats[index] == 1 {
                            downbeats.move(to: CGPoint(x: x, y: 0)); downbeats.addLine(to: CGPoint(x: x, y: size.height))
                            markers.move(to: CGPoint(x: x - 3, y: 0)); markers.addLine(to: CGPoint(x: x + 3, y: 0))
                            markers.addLine(to: CGPoint(x: x, y: 5)); markers.closeSubpath()
                        } else {
                            beats.move(to: CGPoint(x: x, y: 0)); beats.addLine(to: CGPoint(x: x, y: size.height))
                        }
                    }
                    context.stroke(beats, with: .color(.white.opacity(highContrast ? 0.65 : 0.28)), lineWidth: 0.5)
                    context.stroke(downbeats, with: .color(.red.opacity(highContrast ? 1 : 0.72)), lineWidth: 1)
                    context.fill(markers, with: .color(.red))
                }
                let playhead = min(size.width, max(0, (position - start) * scale))
                context.fill(Path(CGRect(x: playhead - 0.75, y: 0, width: 1.5, height: size.height)), with: .color(.white))
            }
        }
        .background(BoothStyle.background).clipped()
        #if os(iOS)
        .overlay {
            WaveformScrubSurface(trackID: trackID, enabled: scenePhase == .active && (hasWindow || preview != nil),
                                 began: { width in beginScrub(width: width, duration: duration) },
                                 changed: { translation in updateScrub(translation: translation) },
                                 ended: { translation in finishScrub(translation: translation) },
                                 cancelled: { cancelScrub() })
        }
        #endif
        .accessibilityElement(children: .ignore).accessibilityLabel("Current track waveform")
        .accessibilityValue(content == nil ? "Analysis unavailable" : "\(timing.playing ? "Playing" : "Paused"), \(overview ? "full duration" : "8 bars, Rekordbox beatgrid")")
        .accessibilityHint("Drag left to seek forward, right to seek backward.")
        .accessibilityAdjustableAction { direction in
            guard player.track != nil else { return }
            player.seek(player.elapsed + (direction == .increment ? 5 : -5))
        }
        .accessibilityIdentifier("nowPlaying.waveform")
        .onChange(of: trackID) { _, _ in scrub = nil }
        .onChange(of: player.seekRevision) { _, _ in scrub = nil }
        .onChange(of: scenePhase) { _, phase in if phase != .active { cancelScrub() } }
        .onDisappear { cancelScrub() }
    }
    private func beginScrub(width: Double, duration: Double) {
        guard let trackID = player.track?.id, cache.content?.trackID == trackID, width > 0, duration > 0 else { return }
        let position = player.mediaClock.position()
        guard let window = cache.content?.grid?.centeredBarWindow(at: position, bars: 8, duration: duration),
              let id = player.beginScrubbing() else { return }
        scrub = WaveformScrubPreview(id: id, trackID: trackID, start: position, span: window.end - window.start,
                                     width: width, duration: duration)
    }
    private func updateScrub(translation: Double) {
        guard let value = scrub, value.trackID == player.track?.id else { scrub = nil; return }
        player.updateScrubbing(value.id, to: value.target(translation: translation))
    }
    private func finishScrub(translation: Double) {
        guard let value = scrub, value.trackID == player.track?.id else { scrub = nil; return }
        scrub = nil
        player.endScrubbing(value.id, at: value.target(translation: translation))
    }
    private func cancelScrub() {
        if let scrub { player.cancelScrubbing(scrub.id) }
        scrub = nil
    }
}

private struct WaveformScrubPreview {
    let id: UUID
    let trackID: String
    let start: Double
    let span: Double
    let width: Double
    let duration: Double
    func target(translation: Double) -> Double { min(duration, max(0, start - translation * span / width)) }
}

#if os(iOS)
/// UIPan delivers an explicit cancellation callback, including navigation/app interruptions.
private struct WaveformScrubSurface: UIViewRepresentable {
    let trackID: String?
    let enabled: Bool
    let began: (Double) -> Void
    let changed: (Double) -> Void
    let ended: (Double) -> Void
    let cancelled: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeUIView(context: Context) -> UIView {
        let view = UIView()
        view.backgroundColor = .clear; view.isAccessibilityElement = false
        let pan = UIPanGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.handle(_:)))
        pan.maximumNumberOfTouches = 1; pan.delegate = context.coordinator
        view.addGestureRecognizer(pan)
        context.coordinator.pan = pan
        return view
    }
    func updateUIView(_ view: UIView, context: Context) {
        context.coordinator.parent = self
        if context.coordinator.pan?.isEnabled != enabled { context.coordinator.pan?.isEnabled = enabled }
    }
    static func dismantleUIView(_ view: UIView, coordinator: Coordinator) { coordinator.cancel() }

    @MainActor final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        var parent: WaveformScrubSurface
        weak var pan: UIPanGestureRecognizer?
        private var activeTrackID: String?
        init(_ parent: WaveformScrubSurface) { self.parent = parent }
        func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
            guard parent.enabled, parent.trackID != nil, let pan = gestureRecognizer as? UIPanGestureRecognizer else { return false }
            let velocity = pan.velocity(in: pan.view)
            return abs(velocity.x) > abs(velocity.y)
        }
        @objc func handle(_ pan: UIPanGestureRecognizer) {
            let translation = Double(pan.translation(in: pan.view).x)
            switch pan.state {
            case .began:
                activeTrackID = parent.trackID
                parent.began(Double(pan.view?.bounds.width ?? 0))
                parent.changed(translation)
            case .changed:
                guard activeTrackID == parent.trackID else { cancel(); return }
                parent.changed(translation)
            case .ended:
                guard activeTrackID != nil, activeTrackID == parent.trackID else { cancel(); return }
                activeTrackID = nil
                parent.ended(translation)
            case .cancelled, .failed: cancel()
            default: break
            }
        }
        func cancel() { activeTrackID = nil; parent.cancelled() }
    }
}
#endif

/// Reuses the same immutable raster behind the title, with full-track progress.
struct PlaybackOverviewBackground: View {
    let player: BoothPlayer
    let cache: PlaybackWaveformCache
    @Environment(\.colorSchemeContrast) private var contrast
    var body: some View {
        let content = cache.content?.trackID == player.track?.id ? cache.content : nil
        let progress = min(1, max(0, player.elapsed / max(1, player.duration)))
        let waveformOpacity = contrast == .increased ? 0.18 : 0.34
        Canvas { context, size in
            guard let content else { return }
            context.opacity = waveformOpacity
            context.draw(Image(decorative: content.raster.overview, scale: 1), in: CGRect(origin: .zero, size: size))
            context.opacity = 1
            context.fill(Path(CGRect(x: progress * size.width, y: 0, width: 1, height: size.height)), with: .color(.white.opacity(0.45)))
        }.clipped().allowsHitTesting(false)
            .accessibilityElement(children: .ignore).accessibilityLabel("Full track waveform")
            .accessibilityValue("Full duration, single-sided")
            .accessibilityIdentifier("nowPlaying.overview")
    }
}

fileprivate struct PlaybackWaveformContent: @unchecked Sendable {
    let trackID: String
    let raster: PlaybackWaveformRaster
    let grid: BeatGridIndex?
    let duration: Double
    static func make(_ waveform: Waveform, trackID: String) -> PlaybackWaveformContent? {
        guard let raster = PlaybackWaveformRaster.make(waveform) else { return nil }
        let duration = waveform.durationSeconds ?? 0
        return PlaybackWaveformContent(trackID: trackID, raster: raster, grid: waveform.beatGrid.map(BeatGridIndex.init),
                                       duration: duration.isFinite && duration > 0 ? duration : 0)
    }
}

/// Immutable image storage is safe to transfer from the renderer task to SwiftUI.
fileprivate struct PlaybackWaveformRaster: @unchecked Sendable {
    let image: CGImage
    let overview: CGImage

    static func make(_ waveform: Waveform) -> PlaybackWaveformRaster? {
        var supported = waveform.source == "rekordbox"
        #if DEBUG
        supported = supported || waveform.source == "demo"
        #endif
        guard supported, !waveform.peaks.isEmpty else { return nil }
        let count = waveform.peaks.count
        // A single isolated peak must not flatten the rest of a DJ waveform.
        // This monotonic display curve keeps silence and transient ordering intact;
        // it never modifies analysis data or feeds back into audio playback.
        let finitePeaks = waveform.peaks.compactMap { $0.isFinite ? min(1, max(0, $0)) : nil }.sorted()
        let reference = finitePeaks.isEmpty ? 0 : finitePeaks[Int(Double(finitePeaks.count - 1) * 0.98)]
        let gain = reference > 0 ? min(8, 1 / reference) : 1
        let width = max(2048, min(count, 2048) * 4)
        let height = 128
        guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                                      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        func amplitude(_ index: Int) -> Double {
            let value = waveform.peaks[index]
            return value.isFinite ? min(1, max(0, value)) : 0
        }
        for x in 0..<width {
            if Task.isCancelled { return nil }
            let exact = Double(x) / Double(width - 1) * Double(count - 1)
            let first = Int(exact), next = min(count - 1, first + 1)
            let fraction = exact - Double(first)
            var peak = amplitude(first) * (1 - fraction) + amplitude(next) * fraction
            // Preserve transients if a future higher-resolution payload exceeds the raster width.
            if count > width {
                let end = min(count, max(first + 1, (x + 1) * count / width))
                for index in first..<end { peak = max(peak, amplitude(index)) }
            }
            let firstColor = waveform.colors?.rgb(at: first) ?? (red: 0.267, green: 0.408, blue: 1)
            let nextColor = waveform.colors?.rgb(at: next) ?? (red: 0.267, green: 0.408, blue: 1)
            let red = firstColor.red * (1 - fraction) + nextColor.red * fraction
            let green = firstColor.green * (1 - fraction) + nextColor.green * fraction
            let blue = firstColor.blue * (1 - fraction) + nextColor.blue * fraction
            context.setFillColor(red: red, green: green, blue: blue, alpha: 1)
            let displayed = pow(tanh(peak * gain), 0.65)
            let half = displayed * Double(height) * 0.46
            context.fill(CGRect(x: Double(x), y: Double(height) / 2 - half, width: 1, height: half * 2))
        }
        guard let image = context.makeImage(),
              let overview = image.cropping(to: CGRect(x: 0, y: 0, width: width, height: height / 2)) else { return nil }
        return PlaybackWaveformRaster(image: image, overview: overview)
    }
}

struct AnalysisWaveform: View {
    var waveform: Waveform?
    var initialColumns: AnalysisWaveformColumns? = nil
    var progress: Double = 0
    var seek: ((Double) -> Void)?
    var compact = false
    @State private var prepared: AnalysisWaveformColumns?
    private var displayedWaveform: Waveform? {
        guard let waveform else { return nil }
        if waveform.source == "rekordbox" { return waveform }
        #if DEBUG
        if waveform.source == "demo" { return waveform }
        #endif
        return nil
    }
    var body: some View {
        GeometryReader { geometry in
            let waveform = displayedWaveform
            let count = min(waveform?.peaks.count ?? 0, max(1, min(1024, Int(geometry.size.width / 2))))
            let request = AnalysisWaveformRequest(waveform: waveform, count: count)
            let ready = prepared?.request == request ? prepared : initialColumns?.request == request ? initialColumns : nil
            let columns = ready?.columns ?? []
            ZStack {
                Canvas { context, size in
                    let mid = size.height / 2
                    context.fill(Path(CGRect(x: 0, y: mid, width: size.width, height: 1)), with: .color(.white.opacity(0.10)))
                    guard !columns.isEmpty else { return }
                    let count = columns.count
                    let step = size.width / Double(count)
                    for column in 0..<count {
                        let value = columns[column]
                        let height = max(1, value.peak * (size.height - 4))
                        let color = Color(red: value.red, green: value.green, blue: value.blue)
                        let played = Double(column) / Double(count) < progress
                        context.fill(Path(CGRect(x: Double(column) * step, y: mid - height / 2, width: max(1, step - 0.65), height: height)), with: .color(color.opacity(played ? 0.42 : 0.95)))
                    }
                    if progress > 0 {
                        context.fill(Path(CGRect(x: min(1, max(0, progress)) * size.width, y: 0, width: 1, height: size.height)), with: .color(.white))
                    }
                }
                if waveform == nil && !compact {
                    Text("ANALYSIS NOT YET AVAILABLE").font(.system(size: 9, weight: .medium, design: .monospaced))
                        .tracking(1.5).foregroundStyle(.secondary).padding(8).background(BoothStyle.surface)
                }
            }
            .contentShape(Rectangle())
            .gesture(DragGesture(minimumDistance: 0).onChanged { value in
                guard geometry.size.width > 0 else { return }
                seek?(min(1, max(0, value.location.x / geometry.size.width)))
            })
            .task(id: request) { await prepare(request) }
        }
        .accessibilityLabel("Recording waveform")
        .accessibilityValue("\(Int(max(0, min(1, progress)) * 100)) percent played")
        .accessibilityAdjustableAction { direction in
            guard let seek else { return }
            seek(min(1, max(0, progress + (direction == .increment ? 0.02 : -0.02))))
        }
    }
    private func prepare(_ request: AnalysisWaveformRequest) async {
        guard initialColumns?.request != request else { return }
        guard prepared?.request != request else { return }
        prepared = nil
        guard request.waveform != nil, request.count > 0 else { return }
        let job = Task.detached(priority: .utility) { AnalysisWaveformColumns.make(request) }
        let result = await withTaskCancellationHandler { await job.value } onCancel: { job.cancel() }
        guard !Task.isCancelled else { return }
        prepared = result
    }
}

struct AnalysisWaveformRequest: Sendable, Equatable {
    let waveform: Waveform?
    let count: Int
}

/// Only display columns are retained, not another waveform image. A 72-point row
/// keeps 36 columns (1,152 bytes) and never scans its 8,192 source peaks while drawing.
struct AnalysisWaveformColumns: Sendable {
    struct Column: Sendable {
        let peak: Double
        let red: Double
        let green: Double
        let blue: Double
    }
    let request: AnalysisWaveformRequest
    let columns: [Column]
    static func make(_ request: AnalysisWaveformRequest) -> Self? {
        guard let waveform = request.waveform, request.count > 0, !waveform.peaks.isEmpty else { return nil }
        var columns: [Column] = []
        columns.reserveCapacity(request.count)
        for column in 0..<request.count {
            if Task.isCancelled { return nil }
            let from = column * waveform.peaks.count / request.count
            let to = min(waveform.peaks.count, max(from + 1, (column + 1) * waveform.peaks.count / request.count))
            let raw = waveform.peaks[from..<to].max() ?? 0
            let color = waveform.colors?.rgb(at: from) ?? (red: 0.267, green: 0.408, blue: 1)
            columns.append(Column(peak: min(1, max(0, raw.isFinite ? raw : 0)),
                                  red: color.red, green: color.green, blue: color.blue))
        }
        return Self(request: request, columns: columns)
    }
}

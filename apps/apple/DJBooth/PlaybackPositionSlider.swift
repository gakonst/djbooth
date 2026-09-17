import SwiftUI
import DJBoothKit

#if os(iOS)
import UIKit

/// Native tracking distinguishes a held thumb from a completed or cancelled edit.
/// Accessibility value changes commit directly; physical drags warm the held
/// position and have distinct release/cancellation callbacks.
struct PlaybackPositionSlider: UIViewRepresentable {
    let trackID: String?
    let seekRevision: UInt64
    let value: Double
    let duration: Double
    let clock: PlaybackMediaClock?
    let animateClock: Bool
    let onBegin: () -> Bool
    let onPreview: (Double) -> Void
    let onCommit: (Double) -> Void
    let onCancel: () -> Void

    func makeUIView(context: Context) -> PlaybackUISlider {
        let slider = PlaybackUISlider()
        slider.minimumTrackTintColor = .white
        slider.accessibilityLabel = "Playback position"
        slider.accessibilityIdentifier = "nowPlaying.progress"
        slider.setContentHuggingPriority(.defaultLow, for: .horizontal)
        return slider
    }
    func updateUIView(_ slider: PlaybackUISlider, context: Context) {
        if slider.trackID != trackID || slider.seekRevision != seekRevision {
            slider.discardTracking()
            slider.trackID = trackID
            slider.seekRevision = seekRevision
        }
        slider.onBegin = onBegin
        slider.onPreview = onPreview
        slider.onCommit = onCommit
        slider.onCancel = onCancel
        slider.minimumValue = 0
        slider.maximumValue = Float(max(1, duration))
        slider.isEnabled = context.environment.isEnabled && trackID != nil && duration > 0
        // Unrelated SwiftUI updates can happen between renderer reports. Use
        // the same current clock as native frames instead of snapping backward
        // to the previous report's elapsed value on each updateUIView call.
        let position = clock?.position() ?? value
        if !slider.isTracking { slider.setValue(Float(position), animated: false) }
        slider.updateClock(clock, animated: animateClock, position: position, duration: duration)
    }
    func sizeThatFits(_ proposal: ProposedViewSize, uiView: PlaybackUISlider, context: Context) -> CGSize? {
        CGSize(width: proposal.width ?? uiView.intrinsicContentSize.width, height: 44)
    }
    static func dismantleUIView(_ uiView: PlaybackUISlider, coordinator: ()) {
        // Teardown must not write back into SwiftUI's disappearing state graph.
        uiView.stopClock()
        uiView.onBegin = nil
        uiView.onPreview = nil
        uiView.onCommit = nil
        uiView.onCancel = nil
        uiView.cancelTracking(with: nil)
    }
}

final class PlaybackUISlider: UISlider {
    var trackID: String?
    var seekRevision: UInt64 = 0
    var onBegin: (() -> Bool)?
    var onPreview: ((Double) -> Void)?
    var onCommit: ((Double) -> Void)?
    var onCancel: (() -> Void)?
    private var beganPhysicalEdit = false
    private var handlingTrackingCallback = false
    private var mediaClock: PlaybackMediaClock?
    private var clockAnimated = false
    private var clockDuration: Double = 0
    private var clockDisplayLink: CADisplayLink?
    private var accessibilitySeconds: (position: Int, duration: Int)?
    @MainActor private final class ClockTarget: NSObject {
        weak var slider: PlaybackUISlider?
        init(_ slider: PlaybackUISlider) { self.slider = slider }
        @objc func tick(_ link: CADisplayLink) {
            guard let slider else { link.invalidate(); return }
            slider.advanceClock()
        }
    }

    func updateClock(_ clock: PlaybackMediaClock?, animated: Bool, position: Double, duration: Double) {
        mediaClock = clock; clockAnimated = animated; clockDuration = duration
        updateClockActivity()
        updateAccessibility(position: position)
    }
    private func updateClockActivity() {
        guard clockAnimated, mediaClock != nil, window != nil else { stopClock(); return }
        guard clockDisplayLink == nil else { return }
        let link = CADisplayLink(target: ClockTarget(self), selector: #selector(ClockTarget.tick(_:)))
        link.preferredFrameRateRange = CAFrameRateRange(minimum: 30, maximum: 60, preferred: 60)
        link.add(to: .main, forMode: .common)
        clockDisplayLink = link
    }
    func stopClock() { clockDisplayLink?.invalidate(); clockDisplayLink = nil }
    private func advanceClock() {
        guard !isTracking, !beganPhysicalEdit, let mediaClock else { return }
        let position = mediaClock.position()
        // UISlider remains the ordinary interactive/accessibility control. No
        // SwiftUI state, seek callback, or surrounding layout changes per frame.
        setValue(Float(position), animated: false)
        updateAccessibility(position: position)
    }
    private func updateAccessibility(position: Double) {
        let seconds = (position: Int(position.isFinite ? max(0, position) : 0),
                       duration: Int(clockDuration.isFinite ? max(0, clockDuration) : 0))
        guard accessibilitySeconds?.position != seconds.position || accessibilitySeconds?.duration != seconds.duration else { return }
        accessibilitySeconds = seconds
        accessibilityValue = "\(timeLabel(position)) of \(timeLabel(clockDuration))"
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        isContinuous = true
        addTarget(self, action: #selector(valueChanged), for: .valueChanged)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    /// The owner already discards its preview when selection or seek revision changes.
    /// Avoid writing SwiftUI state from updateUIView while cancelling the native touch.
    func discardTracking() {
        let callback = onCancel
        onCancel = nil
        cancelTracking(with: nil)
        onCancel = callback
    }
    override func beginTracking(_ touch: UITouch, with event: UIEvent?) -> Bool {
        handlingTrackingCallback = true
        let began = super.beginTracking(touch, with: event)
        handlingTrackingCallback = false
        if began, onBegin?() != true {
            handlingTrackingCallback = true
            super.cancelTracking(with: event)
            handlingTrackingCallback = false
            return false
        }
        beganPhysicalEdit = began
        if began { onPreview?(Double(value)) }
        return began
    }
    override func endTracking(_ touch: UITouch?, with event: UIEvent?) {
        let commit = beganPhysicalEdit
        beganPhysicalEdit = false
        handlingTrackingCallback = true
        super.endTracking(touch, with: event)
        handlingTrackingCallback = false
        if commit { onCommit?(Double(value)) }
    }
    override func cancelTracking(with event: UIEvent?) {
        let wasEditing = beganPhysicalEdit
        beganPhysicalEdit = false
        handlingTrackingCallback = true
        super.cancelTracking(with: event)
        handlingTrackingCallback = false
        if wasEditing { onCancel?() }
    }
    override func didMoveToWindow() {
        super.didMoveToWindow()
        if window == nil { cancelTracking(with: nil) }
        updateClockActivity()
    }
    @objc private func valueChanged() {
        guard !handlingTrackingCallback else { return }
        if isTracking || beganPhysicalEdit { onPreview?(Double(value)) }
        else {
            onCommit?(Double(value))
        }
    }
}
#endif

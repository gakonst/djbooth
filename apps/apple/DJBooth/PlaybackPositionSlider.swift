import SwiftUI

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
        if !slider.isTracking { slider.setValue(Float(value), animated: false) }
        slider.accessibilityValue = "\(timeLabel(value)) of \(timeLabel(duration))"
    }
    func sizeThatFits(_ proposal: ProposedViewSize, uiView: PlaybackUISlider, context: Context) -> CGSize? {
        CGSize(width: proposal.width ?? uiView.intrinsicContentSize.width, height: 44)
    }
    static func dismantleUIView(_ uiView: PlaybackUISlider, coordinator: ()) {
        // Teardown must not write back into SwiftUI's disappearing state graph.
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

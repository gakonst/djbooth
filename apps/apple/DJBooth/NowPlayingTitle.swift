import SwiftUI

/// Only this native layer animates; playback ticks do not redraw the footer to move text.
struct NowPlayingTitle: View {
    let text: String
    let trackID: String?
    let playing: Bool
    let availability: String
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.legibilityWeight) private var legibility
    @ScaledMetric(relativeTo: .headline) private var fontSize: CGFloat = 17

    var body: some View {
        #if os(iOS)
        NativeNowPlayingTitle(text: text, trackID: trackID, active: playing && scenePhase == .active,
            reduceMotion: reduceMotion, fontSize: fontSize, bold: legibility == .bold, availability: availability)
            .frame(maxWidth: .infinity, alignment: .leading)
        #else
        Text(text).font(.headline).lineLimit(2)
            .accessibilityIdentifier("nowPlaying.title").accessibilityValue(availability)
        #endif
    }
}

#if os(iOS)
import UIKit

private struct NativeNowPlayingTitle: UIViewRepresentable {
    let text: String
    let trackID: String?
    let active: Bool
    let reduceMotion: Bool
    let fontSize: CGFloat
    let bold: Bool
    let availability: String

    func makeUIView(context: Context) -> MarqueeTitleView { MarqueeTitleView() }
    func updateUIView(_ view: MarqueeTitleView, context: Context) {
        view.configure(text: text, trackID: trackID, active: active,
            reduceMotion: reduceMotion, fontSize: fontSize, bold: bold, availability: availability)
    }
    func sizeThatFits(_ proposal: ProposedViewSize, uiView: MarqueeTitleView, context: Context) -> CGSize? {
        guard let width = proposal.width, width.isFinite else { return nil }
        return uiView.sizeThatFits(CGSize(width: max(0, width), height: .greatestFiniteMagnitude))
    }
    static func dismantleUIView(_ uiView: MarqueeTitleView, coordinator: ()) { uiView.stop() }
}

/// VoiceOver sees one full title within the visible viewport, never the moving duplicate.
private final class ViewportTitleLabel: UILabel {
    weak var viewport: UIView?
    override var accessibilityFrame: CGRect {
        get {
            guard let viewport else { return super.accessibilityFrame }
            return UIAccessibility.convertToScreenCoordinates(viewport.bounds, in: viewport)
        }
        set { super.accessibilityFrame = newValue }
    }
}

private final class MarqueeTitleView: UIView {
    private let content = UIView()
    private let title = ViewportTitleLabel()
    private let repeatTitle = UILabel()
    private var trackID: String?
    private var active = false
    private var reduceMotion = false
    private var needsAnimationLayout = true
    private var lastSize: CGSize = .zero
    private var animationPaused = false
    private let animationKey = "title.marquee"

    override init(frame: CGRect) {
        super.init(frame: frame)
        clipsToBounds = true
        isUserInteractionEnabled = false
        isAccessibilityElement = false
        content.isUserInteractionEnabled = false
        addSubview(content)
        for label in [title, repeatTitle] {
            label.textColor = .label
            label.backgroundColor = .clear
            label.lineBreakMode = .byTruncatingTail
            label.isUserInteractionEnabled = false
            content.addSubview(label)
        }
        title.viewport = self
        title.isAccessibilityElement = true
        title.accessibilityTraits = .staticText
        title.accessibilityIdentifier = "nowPlaying.title"
        repeatTitle.isAccessibilityElement = false
        accessibilityElements = [title]
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func configure(text: String, trackID: String?, active: Bool, reduceMotion: Bool,
                   fontSize: CGFloat, bold: Bool, availability: String) {
        let font = UIFont.systemFont(ofSize: fontSize, weight: bold ? .bold : .semibold)
        let changed = self.trackID != trackID || title.text != text || title.font != font || self.reduceMotion != reduceMotion
        self.trackID = trackID
        self.active = active
        self.reduceMotion = reduceMotion
        title.accessibilityLabel = text
        title.accessibilityValue = availability
        if changed {
            title.text = text; repeatTitle.text = text
            title.font = font; repeatTitle.font = font
            title.numberOfLines = reduceMotion ? 2 : 1
            repeatTitle.numberOfLines = 1
            needsAnimationLayout = true
            stop()
            invalidateIntrinsicContentSize()
            setNeedsLayout()
        } else { updateAnimationActivity() }
    }

    override var intrinsicContentSize: CGSize {
        CGSize(width: UIView.noIntrinsicMetric, height: ceil(title.font.lineHeight))
    }
    override func sizeThatFits(_ size: CGSize) -> CGSize {
        let height = title.sizeThatFits(CGSize(width: size.width, height: .greatestFiniteMagnitude)).height
        return CGSize(width: size.width, height: ceil(max(title.font.lineHeight, height)))
    }
    override func layoutSubviews() {
        super.layoutSubviews()
        guard bounds.width > 0, bounds.height > 0 else { return }
        guard needsAnimationLayout || lastSize != bounds.size else { return }
        needsAnimationLayout = false; lastSize = bounds.size
        stop()
        let textWidth = ceil(repeatTitle.sizeThatFits(CGSize(width: .greatestFiniteMagnitude, height: bounds.height)).width)
        let overflow = max(0, textWidth - bounds.width)
        let scrolling = overflow > 1 && !reduceMotion
        let gap: CGFloat = max(32, title.font.pointSize * 2)
        let cycleWidth = textWidth + gap
        content.frame = CGRect(x: 0, y: 0, width: scrolling ? cycleWidth + textWidth : bounds.width, height: bounds.height)
        title.frame = CGRect(x: 0, y: 0, width: scrolling ? textWidth : bounds.width, height: bounds.height)
        repeatTitle.frame = CGRect(x: cycleWidth, y: 0, width: textWidth, height: bounds.height)
        repeatTitle.isHidden = !scrolling
        guard scrolling else { return }

        // Pause at the start and when the final words are fully visible, then loop seamlessly.
        let speed = 28.0 // points per second, independent of title length
        let startHold = 1.6
        let endHold = 1.3
        let scroll = Double(overflow) / speed
        let wrap = Double(cycleWidth - overflow) / speed
        let duration = startHold + scroll + endHold + wrap
        let animation = CAKeyframeAnimation(keyPath: "transform.translation.x")
        animation.values = [0, 0, -Double(overflow), -Double(overflow), -Double(cycleWidth)]
        animation.keyTimes = [0, startHold / duration, (startHold + scroll) / duration,
            (startHold + scroll + endHold) / duration, 1].map { NSNumber(value: $0) }
        animation.calculationMode = .linear
        animation.duration = duration
        animation.repeatCount = .infinity
        content.layer.add(animation, forKey: animationKey)
        updateAnimationActivity()
    }
    override func didMoveToWindow() {
        super.didMoveToWindow()
        updateAnimationActivity()
    }
    private func updateAnimationActivity() {
        guard content.layer.animation(forKey: animationKey) != nil else { return }
        if active && window != nil && !reduceMotion {
            guard animationPaused else { return }
            let pausedTime = content.layer.timeOffset
            content.layer.speed = 1
            content.layer.timeOffset = 0
            content.layer.beginTime = 0
            content.layer.beginTime = content.layer.convertTime(CACurrentMediaTime(), from: nil) - pausedTime
            animationPaused = false
        } else {
            guard !animationPaused else { return }
            let pausedTime = content.layer.convertTime(CACurrentMediaTime(), from: nil)
            content.layer.speed = 0
            content.layer.timeOffset = pausedTime
            animationPaused = true
        }
    }
    func stop() {
        content.layer.removeAnimation(forKey: animationKey)
        content.layer.speed = 1
        content.layer.timeOffset = 0
        content.layer.beginTime = 0
        content.layer.transform = CATransform3DIdentity
        animationPaused = false
    }
}
#endif

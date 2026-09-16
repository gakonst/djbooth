import SwiftUI
#if os(iOS)
import UIKit
#endif

struct RowSwipeAction {
    let title: String
    let symbol: String
    let color: Color
    let perform: () -> Void
}

struct RowSwipeActivation {
    let canActivate: () -> Bool
}

/// Mirrors 0xcontrol's 72-point release threshold and 160 ms return animation.
/// Vertical drags stay with the scroll view; gestures never replace accessible actions.
struct SwipeRow<Content: View>: View {
    let left: RowSwipeAction?
    let right: RowSwipeAction?
    var maximum: CGFloat = 160
    var identity: String? = nil
    @ViewBuilder let content: (RowSwipeActivation) -> Content
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var drag = RowDrag()
    @State private var suppressTap = false
    @State private var gestureID = UUID()
    @GestureState private var gestureActive = false
    private let threshold: CGFloat = 72
    private var offset: CGFloat {
        guard drag.horizontal else { return 0 }
        if drag.offset < 0 && left == nil || drag.offset > 0 && right == nil { return 0 }
        return min(maximum, max(-maximum, drag.offset))
    }
    private var action: RowSwipeAction? { offset < 0 ? left : right }
    private var progress: Double { min(1, Double(abs(offset) / threshold)) }
    var body: some View {
        #if os(iOS)
        ZStack {
            if let action {
                action.color
                HStack(spacing: 8) {
                    if offset < 0 { Spacer() }
                    Image(systemName: action.symbol).font(.system(size: 18, weight: .semibold))
                    Text(action.title).font(.system(size: 11, weight: .semibold)).lineLimit(1)
                    if offset > 0 { Spacer() }
                }.padding(.horizontal, 14).foregroundStyle(.black).accessibilityHidden(true)
            }
            content(RowSwipeActivation(canActivate: { !suppressTap }))
                .background(BoothStyle.background).offset(x: offset)
        }.clipped()
            .background {
                RectangularRowPan(identity: identity, canSwipeLeft: left != nil, canSwipeRight: right != nil,
                    changed: { translation in
                        var transaction = Transaction(); transaction.disablesAnimations = true
                        withTransaction(transaction) {
                            suppressTap = true; drag.horizontal = true; drag.offset = translation
                        }
                    }, ended: { translation in
                        withAnimation(reduceMotion ? nil : .easeOut(duration: 0.16)) { drag = RowDrag() }
                        // The native recognizer cancels the underlying control's touch.
                        // Defer reopening activation until this touch-up has finished.
                        Task { @MainActor in await Task.yield(); suppressTap = false }
                        if translation < -threshold { left?.perform() }
                        else if translation > threshold { right?.perform() }
                    }, cancelled: {
                        withAnimation(reduceMotion ? nil : .easeOut(duration: 0.16)) { drag = RowDrag() }
                        suppressTap = false
                    })
            }
            .accessibilityActions {
                if let left { Button(left.title, action: left.perform) }
                if let right { Button(right.title, action: right.perform) }
            }
        #else
        ZStack {
            if let action {
                action.color.opacity(0.20 * progress)
                HStack {
                    if offset < 0 { Spacer() }
                    Label(action.title, systemImage: action.symbol)
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(action.color)
                        .opacity(min(1, progress + 0.2))
                        .scaleEffect(reduceMotion ? 1 : 0.85 + 0.15 * progress)
                    if offset > 0 { Spacer() }
                }.padding(.horizontal, 14).accessibilityHidden(true)
            }
            content(RowSwipeActivation(canActivate: { !suppressTap }))
                .background(BoothStyle.background)
                .offset(x: offset)
                .animation(reduceMotion ? nil : .easeOut(duration: 0.16), value: offset)
        }
        .clipped()
        .simultaneousGesture(
            DragGesture(minimumDistance: 14, coordinateSpace: .global)
                .updating($gestureActive) { _, active, _ in active = true }
                .onChanged { value in
                    var transaction = Transaction(); transaction.disablesAnimations = true
                    withTransaction(transaction) {
                        if !drag.decided {
                            gestureID = UUID()
                            drag.decided = true
                            drag.horizontal = abs(value.translation.width) > abs(value.translation.height) * 1.25
                        }
                        if drag.horizontal {
                            suppressTap = true
                            drag.offset = value.translation.width
                        }
                    }
                }
                .onEnded { value in
                    let horizontal = drag.horizontal
                    finishGesture()
                    guard horizontal else { return }
                    if value.translation.width < -threshold { left?.perform() }
                    else if value.translation.width > threshold { right?.perform() }
                }
        )
        .onChange(of: gestureActive) { _, active in
            // A cancelled recognizer has no onEnded callback. Defer cleanup past
            // touch-up so a child Button cannot reinterpret a swipe as a tap.
            if !active { releaseGestureLater() }
        }
        .accessibilityActions {
            if let left { Button(left.title, action: left.perform) }
            if let right { Button(right.title, action: right.perform) }
        }
        #endif
    }
    private func finishGesture() {
        withAnimation(reduceMotion ? nil : .easeOut(duration: 0.16)) { drag = RowDrag() }
        releaseGestureLater()
    }
    private func releaseGestureLater() {
        let id = gestureID
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(220))
            guard gestureID == id, !gestureActive else { return }
            withAnimation(reduceMotion ? nil : .easeOut(duration: 0.16)) { drag = RowDrag() }
            suppressTap = false
        }
    }
}

private struct RowDrag {
    var decided = false
    var horizontal = false
    var offset: CGFloat = 0
}

/// A standard button; native list/navigation recognizers arbitrate touch handling.
struct LibraryNavigationButton<Label: View>: View {
    let action: () -> Void
    @ViewBuilder let label: () -> Label
    var body: some View { Button(action: action, label: label) }
}

#if os(iOS)
/// Attach to the public cell content view so native controls keep their taps,
/// while UIKit arbitrates horizontal actions, vertical scrolling, and edge Back.
private struct RectangularRowPan: UIViewRepresentable {
    let identity: String?
    let canSwipeLeft: Bool
    let canSwipeRight: Bool
    let changed: (CGFloat) -> Void
    let ended: (CGFloat) -> Void
    let cancelled: () -> Void
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeUIView(context: Context) -> RowPanAnchor {
        let view = RowPanAnchor()
        view.isUserInteractionEnabled = false
        view.attach = { [weak coordinator = context.coordinator] view in coordinator?.attach(to: view) }
        return view
    }
    func updateUIView(_ view: RowPanAnchor, context: Context) {
        let coordinator = context.coordinator
        if coordinator.parent.identity != identity { coordinator.reset() }
        coordinator.parent = self
        coordinator.attach(to: view)
    }
    static func dismantleUIView(_ view: RowPanAnchor, coordinator: Coordinator) { coordinator.detach() }

    @MainActor final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        var parent: RectangularRowPan
        private let pan = UIPanGestureRecognizer()
        private weak var scroll: UIScrollView?
        private weak var navigation: UINavigationController?
        init(_ parent: RectangularRowPan) {
            self.parent = parent
            super.init()
            pan.addTarget(self, action: #selector(handle(_:)))
            pan.delegate = self; pan.maximumNumberOfTouches = 1
            pan.cancelsTouchesInView = true
        }
        func attach(to anchor: UIView) {
            guard anchor.window != nil else { detach(); return }
            var candidate = anchor.superview
            var content: UIView?
            while let view = candidate {
                if let cell = view as? UICollectionViewCell { content = cell.contentView; break }
                if let cell = view as? UITableViewCell { content = cell.contentView; break }
                candidate = view.superview
            }
            guard let content, pan.view !== content else { return }
            detach()
            content.addGestureRecognizer(pan)
            candidate = content.superview
            while let view = candidate {
                if let scrollView = view as? UIScrollView { scroll = scrollView; break }
                candidate = view.superview
            }
            var responder: UIResponder? = content
            while let value = responder {
                if let controller = value as? UIViewController, let stack = controller.navigationController {
                    navigation = stack
                    if let back = stack.interactivePopGestureRecognizer { pan.require(toFail: back) }
                    break
                }
                responder = value.next
            }
        }
        func detach() {
            reset(); pan.view?.removeGestureRecognizer(pan)
            scroll = nil; navigation = nil
        }
        func reset() { pan.isEnabled = false; pan.isEnabled = true }
        func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
            let velocity = pan.velocity(in: pan.view)
            guard abs(velocity.x) > abs(velocity.y) * 1.25 else { return false }
            if let navigation, navigation.viewControllers.count > 1 || navigation.splitViewController?.presentsWithGesture == true,
               pan.location(in: navigation.view).x <= 24 { return false }
            return velocity.x < 0 ? parent.canSwipeLeft : parent.canSwipeRight
        }
        func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldBeRequiredToFailBy otherGestureRecognizer: UIGestureRecognizer) -> Bool {
            otherGestureRecognizer === scroll?.panGestureRecognizer
        }
        @objc private func handle(_ recognizer: UIPanGestureRecognizer) {
            let translation = recognizer.translation(in: recognizer.view).x
            switch recognizer.state {
            case .began, .changed: parent.changed(translation)
            case .ended: parent.ended(translation)
            case .cancelled, .failed: parent.cancelled()
            default: break
            }
        }
    }
}

private final class RowPanAnchor: UIView {
    var attach: ((UIView) -> Void)?
    override func didMoveToWindow() { super.didMoveToWindow(); attach?(self) }
    override func didMoveToSuperview() { super.didMoveToSuperview(); attach?(self) }
}
#endif

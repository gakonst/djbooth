#if os(iOS)
import SwiftUI
import UIKit

/// Keep each folder/playlist alive in a real navigation stack. UIKit owns the
/// interactive edge gesture, cancellation, velocity, and reveal of the prior page.
struct MobileLibraryNavigation: View {
    @Bindable var model: BoothModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        let folder = model.playlistFolderPath
        let folders = (0...folder.count).map { LibraryDestination.folder(Array(folder.prefix($0))) }
        let selected = model.showPlaylistBrowser ? nil : model.collections.first { $0.id == model.selectedCollection }
        let destinations = folders + (selected.map { [.collection($0.id)] } ?? [])
        NativeLibraryStack(model: model, destinations: destinations, reduceMotion: reduceMotion)
            .safeAreaInset(edge: .top, spacing: 0) {
                HStack {
                    Menu {
                        Button { model.showImport = true } label: { Label("Download", systemImage: "arrow.down.circle") }
                            .accessibilityIdentifier("library.drawer.download")
                        if model.cloudAccountID != nil {
                            Button { model.showAgent = true } label: { Label("Music agent", systemImage: "bubble.left.and.bubble.right") }
                        }
                        Button { model.showDJLink = true } label: { Label("Connect to CDJ", systemImage: "network") }
                            .accessibilityIdentifier("library.drawer.djlink")
                        Button { model.showSettings = true } label: { Label("Sync & settings", systemImage: "gearshape") }
                            .accessibilityIdentifier("library.drawer.settings")
                    } label: { Label("Library", systemImage: "line.3.horizontal") }
                        .accessibilityIdentifier("library.drawer.open")
                    Spacer()
                }.padding(.horizontal, 16).padding(.vertical, 8).background(BoothStyle.background)
            }
    }
}

private enum LibraryDestination: Hashable {
    case folder([String])
    case collection(String)
}

private struct LibraryPage: View {
    let model: BoothModel
    let destination: LibraryDestination
    var body: some View {
        Group {
            switch destination {
            case .folder(let path): PlaylistBrowserView(model: model, folderPath: path)
            case .collection(let id): MobileTrackList(model: model, collectionID: id)
            }
        }.background(BoothStyle.background).tint(BoothStyle.accent).preferredColorScheme(.dark)
    }
}

private final class LibraryPageController: UIHostingController<LibraryPage> {
    let destination: LibraryDestination
    init(model: BoothModel, destination: LibraryDestination) {
        self.destination = destination
        super.init(rootView: LibraryPage(model: model, destination: destination))
        view.backgroundColor = UIColor(BoothStyle.background)
    }
    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is unavailable") }
}

private struct NativeLibraryStack: UIViewControllerRepresentable {
    let model: BoothModel
    let destinations: [LibraryDestination]
    let reduceMotion: Bool

    func makeCoordinator() -> Coordinator { Coordinator(model: model) }
    func makeUIViewController(context: Context) -> UINavigationController {
        let navigation = UINavigationController()
        navigation.setNavigationBarHidden(true, animated: false)
        navigation.view.backgroundColor = UIColor(BoothStyle.background)
        navigation.delegate = context.coordinator
        context.coordinator.navigation = navigation
        navigation.interactivePopGestureRecognizer?.delegate = context.coordinator
        context.coordinator.update(destinations, animated: false)
        return navigation
    }
    func updateUIViewController(_ navigation: UINavigationController, context: Context) {
        context.coordinator.update(destinations, animated: !reduceMotion && navigation.view.window != nil)
    }

    @MainActor final class Coordinator: NSObject, UINavigationControllerDelegate, UIGestureRecognizerDelegate {
        let model: BoothModel
        weak var navigation: UINavigationController?
        private var desired: [LibraryDestination] = []
        private var programmaticTransition = false
        private var interactiveStart: [LibraryDestination]?
        private var animateChanges = true
        init(model: BoothModel) { self.model = model }

        func update(_ destinations: [LibraryDestination], animated: Bool) {
            desired = destinations; animateChanges = animated
            applyDesiredStack()
        }
        private func applyDesiredStack() {
            guard let navigation, navigation.transitionCoordinator == nil, !programmaticTransition else { return }
            let existing = navigation.viewControllers.compactMap { $0 as? LibraryPageController }
            guard existing.map(\.destination) != desired else { return }
            let controllers = desired.enumerated().map { index, destination in
                if index < existing.count, existing[index].destination == destination { return existing[index] }
                return LibraryPageController(model: model, destination: destination)
            }
            interactiveStart = nil
            programmaticTransition = true
            navigation.setViewControllers(controllers, animated: animateChanges)
            // UIKit may not issue didShow before this controller is onscreen.
            if !animateChanges { programmaticTransition = false }
            navigation.interactivePopGestureRecognizer?.isEnabled = controllers.count > 1
        }
        func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
            guard let navigation else { return false }
            guard navigation.viewControllers.count > 1, navigation.transitionCoordinator == nil, !programmaticTransition else { return false }
            interactiveStart = navigation.viewControllers.compactMap { ($0 as? LibraryPageController)?.destination }
            return true
        }
        func navigationController(_ navigationController: UINavigationController, willShow viewController: UIViewController, animated: Bool) {
            if !programmaticTransition, animated, interactiveStart == nil { interactiveStart = desired }
        }
        func navigationController(_ navigationController: UINavigationController, didShow viewController: UIViewController, animated: Bool) {
            let actual = navigationController.viewControllers.compactMap { ($0 as? LibraryPageController)?.destination }
            if programmaticTransition {
                programmaticTransition = false
            } else if let origin = interactiveStart, actual != origin, desired == origin,
                      let destination = (viewController as? LibraryPageController)?.destination {
                // A cancelled native swipe leaves the original stack intact and
                // never changes the persisted selection or playlist contents.
                desired = actual
                switch destination {
                case .folder(let path): model.openPlaylistFolder(path)
                case .collection(let id):
                    if let collection = model.collections.first(where: { $0.id == id }) { model.openCollection(collection) }
                }
            }
            // A newer model navigation request wins over either a cancelled or
            // completed gesture; it must not be overwritten by the old screen.
            interactiveStart = nil
            navigationController.interactivePopGestureRecognizer?.isEnabled = actual.count > 1
            applyDesiredStack()
        }
    }
}
#endif

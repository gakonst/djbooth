#if os(iOS)
import SwiftUI
import UIKit

/// Keep each folder/playlist alive in a real navigation stack. UIKit owns the
/// interactive edge gesture, cancellation, velocity, and reveal of the prior page.
struct MobileLibraryNavigation: View {
    @Bindable var model: BoothModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var drawerOpen = false
    @State private var edgeDrag: CGFloat = 0
    private var isRoot: Bool {
        model.selectedCollection == nil && model.playlistFolderPath.isEmpty && model.browseGroup == nil && model.pendingQuickAddTrackID == nil
    }
    private var animation: Animation? { reduceMotion ? nil : .easeOut(duration: 0.18) }
    var body: some View {
        let folder = model.playlistFolderPath
        let folders = (0...folder.count).map { LibraryDestination.folder(Array(folder.prefix($0))) }
        let selected = model.showPlaylistBrowser ? nil : model.collections.first { $0.id == model.selectedCollection }
        let browsing = model.browseMode != .playlists && selected == nil && model.pendingQuickAddTrackID == nil
        let destinations: [LibraryDestination] = browsing
            ? [.browse(model.browseMode)] + (model.browseGroup.map { [.group(model.browseMode, $0)] } ?? [])
            : folders + (selected.map { [.collection($0.id)] } ?? [])
        GeometryReader { geometry in
            let width = min(320.0, geometry.size.width * 0.85)
            ZStack(alignment: .leading) {
                VStack(spacing: 0) {
                    if isRoot {
                        Button { withAnimation(animation) { drawerOpen = true } } label: {
                            HStack(spacing: 12) {
                                Image(systemName: "line.3.horizontal").frame(width: 24)
                                Text(model.browseMode.rawValue).font(.headline)
                                Spacer()
                            }.padding(.horizontal, 16).frame(minHeight: 44).contentShape(Rectangle())
                        }.buttonStyle(.plain).accessibilityLabel("Library menu")
                            .accessibilityIdentifier("library.drawer.open")
                    }
                    NativeLibraryStack(model: model, destinations: destinations, reduceMotion: reduceMotion)
                }.accessibilityHidden(drawerOpen)
                if isRoot && !drawerOpen {
                    Color.clear.frame(width: 24).contentShape(Rectangle())
                        .gesture(DragGesture(minimumDistance: 12)
                            .onChanged { value in
                                guard value.translation.width > abs(value.translation.height) else { return }
                                edgeDrag = min(width, max(0, value.translation.width))
                            }
                            .onEnded { value in
                                withAnimation(animation) {
                                    drawerOpen = edgeDrag > 40 || (edgeDrag > 0 && value.predictedEndTranslation.width > 100)
                                    edgeDrag = 0
                                }
                            })
                        .accessibilityHidden(true)
                }
                if drawerOpen || edgeDrag > 0 {
                    Color.black.opacity(0.45 * (drawerOpen ? 1 : edgeDrag / width))
                        .contentShape(Rectangle()).onTapGesture { closeDrawer() }
                        .accessibilityLabel("Close library menu").accessibilityAddTraits(.isButton)
                    drawer.frame(width: width).frame(maxHeight: .infinity)
                        .background(BoothStyle.surface)
                        .offset(x: drawerOpen ? 0 : edgeDrag - width)
                        .gesture(DragGesture(minimumDistance: 20).onEnded { value in
                            if value.translation.width < -40 { closeDrawer() }
                        })
                        .accessibilityAction(.escape) { closeDrawer() }
                }
            }.background(BoothStyle.background)
        }
        .onChange(of: isRoot) { _, root in if !root { drawerOpen = false; edgeDrag = 0 } }
    }
    private func closeDrawer() { withAnimation(animation) { drawerOpen = false; edgeDrag = 0 } }
    private var drawer: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text("Library").font(.title2.bold())
                    Spacer()
                    Button(action: closeDrawer) { Image(systemName: "xmark").frame(width: 44, height: 44) }
                        .accessibilityLabel("Close library menu").accessibilityIdentifier("library.drawer.close")
                }.padding(.leading, 12)
                ForEach(LibraryBrowseMode.allCases, id: \.self) { mode in
                    Button { model.browse(mode); closeDrawer() } label: {
                        HStack {
                            Label(mode.rawValue, systemImage: mode.symbol)
                            Spacer()
                            if model.browseMode == mode { Image(systemName: "checkmark") }
                        }.padding(12).frame(minHeight: 48).contentShape(Rectangle())
                    }.accessibilityIdentifier("library.drawer.\(mode)")
                        .accessibilityValue(model.browseMode == mode ? "Selected" : "")
                }
                Divider().padding(.vertical, 8)
                Button { closeDrawer(); model.showImport = true } label: {
                    VStack(alignment: .leading, spacing: 4) {
                        Label("Download", systemImage: "arrow.down.circle")
                        let active = model.importJobs.filter(\.isActive).count
                        Text(active > 0 ? "\(active) imports running" : "Paste a playlist or set link")
                            .font(.caption).foregroundStyle(.secondary)
                    }.frame(maxWidth: .infinity, alignment: .leading).padding(12).contentShape(Rectangle())
                }.accessibilityIdentifier("library.drawer.download")
                Button { closeDrawer(); model.showAgent = true } label: {
                    Label("Music agent", systemImage: "bubble.left.and.bubble.right").padding(12).frame(minHeight: 48)
                }.accessibilityIdentifier("library.drawer.agent")
                Button { closeDrawer(); model.showSettings = true } label: {
                    Label("Sync & settings", systemImage: "gearshape").padding(12).frame(minHeight: 48)
                }.accessibilityIdentifier("library.drawer.settings")
            }.padding(12)
        }.buttonStyle(.plain).accessibilityIdentifier("library.drawer")
    }
}

private enum LibraryDestination: Hashable {
    case folder([String])
    case collection(String)
    case browse(LibraryBrowseMode)
    case group(LibraryBrowseMode, String)
}

private struct LibraryPage: View {
    let model: BoothModel
    let destination: LibraryDestination
    var body: some View {
        Group {
            switch destination {
            case .folder(let path): PlaylistBrowserView(model: model, folderPath: path)
            case .collection(let id): MobileTrackList(model: model, collectionID: id)
            case .browse(let mode):
                if mode == .tracks { MobileTrackList(model: model, collectionID: nil) }
                else { MobileGroupBrowser(model: model, mode: mode) }
            case .group(let mode, let name):
                MobileTrackList(model: model, collectionID: nil, groupMode: mode, groupName: name)
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
                case .browse(let mode): model.browse(mode)
                case .group(let mode, let name): model.browse(mode, group: name)
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

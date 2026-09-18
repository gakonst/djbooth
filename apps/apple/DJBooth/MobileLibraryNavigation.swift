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
        let browsing = model.browseMode != .playlists && selected == nil && model.pendingQuickAddTrackID == nil
        let libraryPages: [LibraryDestination] = browsing
            ? [.browse(model.browseMode)] + (model.browseGroup.map { [.group(model.browseMode, $0)] } ?? [])
            : folders + (selected.map { [.collection($0.id)] } ?? [])
        let pages: [LibraryDestination] = model.selectedCrewID.map { crewID in
            [.folder([]), .crewFolder(crewID)] + (model.selectedCrewCrateID.map { [.crewPlaylist(crewID, $0)] } ?? [])
        } ?? libraryPages
        NativeLibraryStack(model: model, destinations: pages, reduceMotion: reduceMotion, obscured: model.showAgent)
            .safeAreaInset(edge: .top, spacing: 0) { DJLinkConnectionCard(model: model) }
            .alert("Shared folder unavailable", isPresented: Binding(get: { model.crewError != nil }, set: { if !$0 { model.crewError = nil } })) {
                Button("OK") { model.crewError = nil }
            } message: { Text(model.crewError ?? "") }
    }
}

private struct LibrarySidebar: View {
    @Bindable var model: BoothModel
    let close: () -> Void
    @Environment(\.dynamicTypeSize) private var typeSize
    @State private var suppressSelection = false
    var body: some View {
        List {
            Group {
                ForEach(LibraryBrowseMode.allCases, id: \.self) { mode in
                    Button { guard !suppressSelection else { return }; model.browse(mode); close() } label: {
                        row(mode.rawValue, symbol: mode.symbol, selected: model.browseMode == mode)
                    }.accessibilityIdentifier("library.drawer.\(mode)")
                        .accessibilityValue(model.browseMode == mode ? "Selected" : "")
                }
                Button { guard !suppressSelection else { return }; close(); model.showImport = true } label: {
                    row("Download", symbol: "arrow.down.circle", count: model.importJobs.filter(\.isActive).count)
                }.accessibilityIdentifier("library.drawer.download")
                if model.hasCloudSession {
                    Button { guard !suppressSelection else { return }; close(); model.showAgent = true } label: {
                        row("Ask DJ Booth", symbol: "bubble.left.and.bubble.right")
                    }.accessibilityIdentifier("library.agent")
                }
                Button { guard !suppressSelection else { return }; close(); model.showDJLink = true } label: {
                    row("CDJs", symbol: "network")
                }.accessibilityIdentifier("library.drawer.djlink")
                Button { guard !suppressSelection else { return }; close(); model.showSettings = true } label: {
                    row("Sync & settings", symbol: "gearshape")
                }.accessibilityIdentifier("library.drawer.settings")
            }.boothLibraryCell()
            Section {
                SonosSidebarControl(model: model) { close(); model.showSonosSettings = true }
            }
        }
        .buttonStyle(BoothRowButtonStyle())
        .boothLibraryList()
        .accessibilityIdentifier("library.sidebar")
        .simultaneousGesture(
            DragGesture(minimumDistance: 12)
                .onChanged { value in
                    if abs(value.translation.width) > abs(value.translation.height) { suppressSelection = true }
                }
                .onEnded { value in
                    if suppressSelection && value.translation.width < -44 { close() }
                    // Keep touch-up from turning a closing swipe into a menu tap.
                    Task { @MainActor in await Task.yield(); suppressSelection = false }
                }
        )
    }
    private func row(_ title: String, symbol: String, selected: Bool = false, count: Int = 0) -> some View {
        HStack(spacing: 10) {
            Image(systemName: symbol).font(.body).foregroundStyle(BoothStyle.accent)
                .frame(width: 32).accessibilityHidden(true)
            Text(title).boothFont(14, relativeTo: .subheadline, weight: .semibold)
                .foregroundStyle(.primary).lineLimit(typeSize.isAccessibilitySize ? 2 : 1)
                .frame(maxWidth: .infinity, alignment: .leading)
            if selected {
                Image(systemName: "checkmark").font(.caption.weight(.semibold)).foregroundStyle(BoothStyle.accent)
                    .accessibilityHidden(true)
            } else if count > 0 {
                Text("\(count)").boothFont(11, relativeTo: .caption2, design: .monospaced).foregroundStyle(.secondary)
            }
        }.padding(.horizontal, 12).frame(minHeight: 48).contentShape(Rectangle())
            .background(selected ? BoothStyle.accent.opacity(0.12) : .clear)
            .overlay(alignment: .bottom) { Rectangle().fill(BoothStyle.border).frame(height: 0.5) }
    }
}

/// One contextual menu for every library navigation bar.
@MainActor private func libraryActionsMenu(model: BoothModel, crewID: String?) -> UIMenu {
    UIMenu(children: [UIDeferredMenuElement.uncached { completion in
        Task { @MainActor in
            var actions: [UIMenuElement] = []
            let canEdit = crewID.map { id in
                model.crewDetails[id]?.crew.role.canEdit ?? model.crews.first(where: { $0.id == id })?.role.canEdit ?? false
            } ?? true
            if canEdit {
                actions.append(UIAction(title: "New playlist", image: UIImage(systemName: "plus")) { _ in
                    if crewID != nil { model.newCrewPlaylistPresented = true }
                    else { model.showNewCollection = true }
                })
            }
            if crewID != nil {
                actions.append(UIAction(title: "Members", image: UIImage(systemName: "person.2")) { _ in model.crewMembersPresented = true })
            }
            if model.hasCloudSession {
                actions.append(UIMenu(title: "Shared folder", image: UIImage(systemName: "folder.badge.person.crop"), children: [
                    UIAction(title: "New shared folder", image: UIImage(systemName: "folder.badge.plus")) { _ in model.newSharedFolderPresented = true },
                    UIAction(title: "Join shared folder", image: UIImage(systemName: "person.badge.plus")) { _ in model.joinSharedFolderPresented = true }
                ]))
            }
            completion(actions)
        }
    }])
}

private enum LibraryDestination: Hashable {
    case folder([String])
    case collection(String)
    case browse(LibraryBrowseMode)
    case group(LibraryBrowseMode, String)
    case crewFolder(String)
    case crewPlaylist(String, String)
}

private struct LibraryPage: View {
    let model: BoothModel
    let destination: LibraryDestination
    var body: some View {
        Group {
            switch destination {
            case .folder(let path): PlaylistBrowserView(model: model, folderPath: path)
            case .collection(let id): MobileTrackList(model: model, collectionID: id)
            case .crewFolder(let id): CrewFolderView(model: model, crewID: id)
            case .crewPlaylist(let crewID, let crateID): CrewPlaylistView(model: model, crewID: crewID, crateID: crateID)
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
    init(model: BoothModel, destination: LibraryDestination, openSidebar: @escaping () -> Void) {
        self.destination = destination
        super.init(rootView: LibraryPage(model: model, destination: destination))
        view.backgroundColor = UIColor(BoothStyle.background)
        refreshTitle(model: model)
        let agent = UIBarButtonItem(image: UIImage(systemName: "wand.and.stars"),
                                    primaryAction: UIAction { _ in model.showAgent = true })
        agent.accessibilityLabel = "Your DJ Booth companion"
        agent.accessibilityIdentifier = "library.agent"
        agent.tintColor = UIColor(BoothStyle.accent)
        let crewID: String?
        switch destination {
        case .crewFolder(let id), .crewPlaylist(let id, _): crewID = id
        default: crewID = nil
        }
        let actions = UIBarButtonItem(image: UIImage(systemName: "ellipsis"), menu: libraryActionsMenu(model: model, crewID: crewID))
        actions.tintColor = .label
        actions.accessibilityLabel = "Library actions"; actions.accessibilityIdentifier = "library.actions"
        navigationItem.rightBarButtonItems = [actions, agent]
        navigationItem.largeTitleDisplayMode = .never
        navigationItem.backButtonDisplayMode = .minimal
        let hasDrawer: Bool
        switch destination {
        case .folder(let path): hasDrawer = path.isEmpty
        case .browse: hasDrawer = true
        case .collection, .group, .crewFolder, .crewPlaylist: hasDrawer = false
        }
        if hasDrawer {
            let button = UIBarButtonItem(image: UIImage(systemName: "sidebar.left"),
                                         primaryAction: UIAction { _ in openSidebar() })
            button.accessibilityLabel = "Show Sidebar"
            button.accessibilityIdentifier = "library.drawer.open"
            navigationItem.leftBarButtonItem = button
        }
        switch destination {
        case .collection, .group:
            let groupMode: LibraryBrowseMode?
            if case .group(let mode, _) = destination { groupMode = mode } else { groupMode = nil }
            let label = UILabel()
            label.font = .preferredFont(forTextStyle: .headline)
            label.adjustsFontForContentSizeCategory = true
            label.textColor = .label
            label.lineBreakMode = .byTruncatingTail
            label.accessibilityIdentifier = groupMode == nil ? "playlist.title" : "library.group.title"
            navigationItem.titleView = label
            refreshTitle(model: model)
        default: break
        }
    }
    func refreshTitle(model: BoothModel) {
        switch destination {
        case .folder(let path): title = path.last ?? (model.pendingQuickAddTrackID == nil ? "Playlists" : "Add to playlist")
        case .browse(let mode): title = mode.rawValue
        case .group(_, let name): title = name
        case .collection(let id): title = model.collections.first { $0.id == id }?.name ?? "Playlist"
        case .crewFolder(let id): title = model.crews.first { $0.id == id }?.name ?? "Shared folder"
        case .crewPlaylist(let crewID, let crateID): title = model.crewDetails[crewID]?.crates.first { $0.id == crateID }?.name ?? "Playlist"
        }
        if let label = navigationItem.titleView as? UILabel, label.text != title {
            label.text = title
            label.sizeToFit()
        }
    }
    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is unavailable") }
}

private final class LibrarySplitController: UISplitViewController {
    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let width = view.bounds.width * 2 / 3
        guard width > 0, maximumPrimaryColumnWidth != width else { return }
        maximumPrimaryColumnWidth = width
        minimumPrimaryColumnWidth = width
    }
}

private struct LibraryPlayerFooter: View {
    let model: BoothModel
    var maximumPlayerHeight: CGFloat = 420
    var body: some View {
        VStack(spacing: 0) {
            PlaylistRemovalNotice(model: model)
            if model.djLink.status.running, !model.djLink.detectedDecks.isEmpty {
                DJLinkPlayerDock(model: model, maximumHeight: maximumPlayerHeight)
            } else {
                MobileNowPlaying(model: model)
            }
        }.background(BoothStyle.background).tint(BoothStyle.accent).preferredColorScheme(.dark)
    }
}

/// The player belongs to the secondary column, and stays put as its pages move.
/// The primary column can then cover both the library and the player.
private final class LibraryNavigationController: UINavigationController {
    private let footer: UIHostingController<LibraryPlayerFooter>
    private var footerBottom: NSLayoutConstraint?
    private var playerHeight: CGFloat = 420

    init(model: BoothModel) {
        footer = UIHostingController(rootView: LibraryPlayerFooter(model: model))
        super.init(nibName: nil, bundle: nil)
    }
    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is unavailable") }

    override func viewDidLoad() {
        super.viewDidLoad()
        footer.safeAreaRegions = []
        footer.sizingOptions = .intrinsicContentSize
        addChild(footer)
        footer.view.backgroundColor = UIColor(BoothStyle.background)
        footer.view.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(footer.view)
        let bottom = footer.view.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        bottom.priority = .defaultHigh
        footerBottom = bottom
        view.keyboardLayoutGuide.usesBottomSafeArea = false
        NSLayoutConstraint.activate([
            footer.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            footer.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            bottom,
            footer.view.bottomAnchor.constraint(lessThanOrEqualTo: view.keyboardLayoutGuide.topAnchor),
        ])
        footer.didMove(toParent: self)
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let availableHeight = view.keyboardLayoutGuide.layoutFrame.minY - view.safeAreaInsets.top
        let maximumPlayerHeight = max(180, min(540, availableHeight * 0.6))
        if abs(playerHeight - maximumPlayerHeight) > 1 {
            playerHeight = maximumPlayerHeight
            footer.rootView.maximumPlayerHeight = maximumPlayerHeight
        }
        let bottom = max(0, view.safeAreaInsets.bottom - additionalSafeAreaInsets.bottom)
        if footerBottom?.constant != -bottom { footerBottom?.constant = -bottom }
        let height = max(0, view.bounds.maxY - footer.view.frame.minY - bottom)
        if additionalSafeAreaInsets.bottom != height { additionalSafeAreaInsets.bottom = height }
        view.bringSubviewToFront(footer.view)
    }
}

private struct NativeLibraryStack: UIViewControllerRepresentable {
    let model: BoothModel
    let destinations: [LibraryDestination]
    let reduceMotion: Bool
    let obscured: Bool

    func makeCoordinator() -> Coordinator { Coordinator(model: model) }
    func makeUIViewController(context: Context) -> UISplitViewController {
        let split = LibrarySplitController(style: .doubleColumn)
        // Keep the real overlay sidebar on a portrait phone instead of adapting
        // the primary column into a full-screen navigation destination.
        split.traitOverrides.horizontalSizeClass = .regular
        split.preferredSplitBehavior = .overlay
        split.primaryBackgroundStyle = .none
        split.preferredDisplayMode = .secondaryOnly
        // Own the buttons in each navigation bar; UIKit's automatic button moves
        // between columns and can disappear while the secondary stack changes.
        split.displayModeButtonVisibility = .never
        split.preferredPrimaryColumnWidthFraction = 2.0 / 3.0
        split.overrideUserInterfaceStyle = .dark
        split.view.tintColor = UIColor(BoothStyle.accent)
        let sidebar = UIHostingController(rootView: LibrarySidebar(model: model, close: { [weak split] in split?.hide(.primary) }))
        sidebar.title = "Library"
        sidebar.navigationItem.largeTitleDisplayMode = .never
        let closeButton = UIBarButtonItem(image: UIImage(systemName: "sidebar.left"),
                                         primaryAction: UIAction { [weak split] _ in split?.hide(.primary) })
        closeButton.accessibilityLabel = "Hide Sidebar"
        closeButton.accessibilityIdentifier = "library.drawer.close"
        sidebar.navigationItem.leftBarButtonItem = closeButton
        sidebar.view.backgroundColor = UIColor(BoothStyle.background)
        let primary = UINavigationController(rootViewController: sidebar)
        BoothStyle.configureLibraryNavigation(primary)
        split.setViewController(primary, for: .primary)
        let navigation = LibraryNavigationController(model: model)
        BoothStyle.configureLibraryNavigation(navigation)
        navigation.delegate = context.coordinator
        split.setViewController(navigation, for: .secondary)
        context.coordinator.split = split
        context.coordinator.navigation = navigation
        navigation.interactivePopGestureRecognizer?.delegate = context.coordinator
        context.coordinator.update(destinations, animated: false)
        return split
    }
    func updateUIViewController(_ split: UISplitViewController, context: Context) {
        // SwiftUI accessibilityHidden does not hide this UIKit navigation tree.
        // Keep its controllers mounted so returning preserves the browsing stack.
        split.view.isHidden = obscured
        split.view.accessibilityElementsHidden = obscured
        context.coordinator.update(destinations, animated: !reduceMotion && split.view.window != nil)
    }

    @MainActor final class Coordinator: NSObject, UINavigationControllerDelegate, UIGestureRecognizerDelegate {
        let model: BoothModel
        weak var navigation: UINavigationController?
        weak var split: UISplitViewController?
        private var desired: [LibraryDestination] = []
        private var programmaticTransition = false
        private var awaitingParentTransition = false
        private var interactiveStart: [LibraryDestination]?
        private var animateChanges = true
        init(model: BoothModel) { self.model = model }

        func update(_ destinations: [LibraryDestination], animated: Bool) {
            desired = destinations; animateChanges = animated
            let atRoot = destinations.count == 1 && model.pendingQuickAddTrackID == nil
            split?.presentsWithGesture = atRoot
            if !atRoot { split?.hide(.primary) }
            applyDesiredStack()
        }
        private func applyDesiredStack() {
            guard let navigation, !programmaticTransition else { return }
            if let transition = navigation.transitionCoordinator {
                // A sidebar dismissal can still be animating when its selection
                // changes the secondary page. Apply that selection after UIKit settles.
                if !awaitingParentTransition {
                    awaitingParentTransition = true
                    transition.animate(alongsideTransition: nil) { [weak self] _ in
                        Task { @MainActor in
                            self?.awaitingParentTransition = false
                            self?.applyDesiredStack()
                        }
                    }
                }
                return
            }
            let existing = navigation.viewControllers.compactMap { $0 as? LibraryPageController }
            existing.forEach { $0.refreshTitle(model: model) }
            guard existing.map(\.destination) != desired else { return }
            let controllers = desired.enumerated().map { index, destination in
                if index < existing.count, existing[index].destination == destination { return existing[index] }
                return LibraryPageController(model: model, destination: destination,
                                             openSidebar: { [weak split] in split?.show(.primary) })
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
            // Every page keeps the same native bar and top safe area throughout
            // pushes, back taps, and interactive pops; only its contents change.
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
                case .crewFolder(let id): model.openCrewFolder(id)
                case .crewPlaylist(let crewID, let crateID): model.openCrewPlaylist(crewID: crewID, crateID: crateID)
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

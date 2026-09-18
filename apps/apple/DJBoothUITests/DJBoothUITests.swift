import XCTest

@MainActor
final class DJBoothUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    #if os(iOS)
    func testSharedPlaylistContributorBadges() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-test-library", UUID().uuidString, "--ui-test-crews", "--ui-test-crew-contributors"]
        app.launch()
        let folder = app.buttons["crew.folder.crew-demo"]
        XCTAssertTrue(folder.waitForExistence(timeout: 15))
        folder.tap()
        app.buttons["crew.playlist.crate-demo"].tap()

        let georgios = app.buttons["crew.contributor.item-georgios"]
        XCTAssertTrue(georgios.waitForExistence(timeout: 5))
        XCTAssertEqual(georgios.label, "Added by Georgios Konstantopoulos")
        let alex = app.buttons["crew.contributor.item-alex"]
        XCTAssertEqual(alex.label, "Added by Alex Rivera")
        XCTAssertTrue(alex.isEnabled, "Attribution stays available when audio is missing")
        XCTAssertTrue(app.otherElements["track.row.crew:item-alex"].exists)
        XCTAssertTrue(app.buttons["track.waveform.crew:item-alex"].exists)
        XCTAssertEqual(app.staticTexts["track.bpm.crew:item-alex"].label, "100.0")
        XCTAssertEqual(app.staticTexts["track.key.crew:item-alex"].label, "3B")
        let row = app.otherElements["track.row.crew:item-alex"]
        XCTAssertTrue(row.buttons["crew.contributor.item-alex"].exists)
        XCTAssertLessThanOrEqual(alex.frame.maxX, app.staticTexts["track.bpm.crew:item-alex"].frame.minX)
        XCTAssertLessThanOrEqual(alex.frame.width, 18)
        XCTAssertEqual(alex.frame.midY, app.staticTexts["track.bpm.crew:item-alex"].frame.midY, accuracy: 2)
        app.buttons["track.waveform.crew:item-alex"].tap()
        capture(app, "Shared playlist contributor initials")
        alex.tap()
        let contributorName = app.staticTexts["crew.contributor.name"]
        XCTAssertTrue(contributorName.waitForExistence(timeout: 5))
        XCTAssertEqual(contributorName.label, "Alex Rivera")
        capture(app, "Contributor full name")
        app.navigationBars["Friday Warmup"].tap()

        let unknown = app.buttons["crew.contributor.item-unknown"]
        XCTAssertEqual(unknown.label, "Added by unknown contributor")
        unknown.tap()
        XCTAssertTrue(contributorName.waitForExistence(timeout: 5))
        XCTAssertEqual(contributorName.label, "Unknown contributor")
        XCTAssertTrue(app.staticTexts["Member details are unavailable."].exists)
        app.terminate()
        app.launch()
        let restored = app.buttons["nowPlaying.queue.track.crew:item-alex"]
        XCTAssertTrue(restored.waitForExistence(timeout: 15), "Shared playback queue survives an app restart")
        XCTAssertEqual(app.descendants(matching: .any)["nowPlaying.title"].firstMatch.label, "A Walk")
    }

    func testSharedFolderInviteSharesLinkAndQRCode() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-test-library", UUID().uuidString, "--ui-test-crews"]
        app.launch()
        let folder = app.buttons["crew.folder.crew-demo"]
        XCTAssertTrue(folder.waitForExistence(timeout: 15)); folder.tap()
        app.buttons["crew.members"].tap()
        app.buttons["crew.members.add"].tap()
        XCTAssertTrue(app.images["crew.invite.qr"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["crew.invite.share"].exists)
        XCTAssertFalse(app.staticTexts[String(repeating: "a", count: 43)].exists)
        app.buttons["crew.invite.copy"].tap()
        XCTAssertEqual(app.buttons["crew.invite.copy"].label, "Link copied")
        capture(app, "Crew invite QR and share link")
    }

    func testSharedFolderNavigationAndMembers() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-test-library", UUID().uuidString, "--ui-test-crews"]
        app.launch()
        let folder = app.buttons["crew.folder.crew-demo"]
        XCTAssertTrue(folder.waitForExistence(timeout: 15))
        folder.tap()
        XCTAssertTrue(app.navigationBars["No Static"].waitForExistence(timeout: 5))
        app.buttons["crew.members"].tap()
        XCTAssertTrue(app.staticTexts["Alex"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["crew.members.add"].isHittable)
        capture(app, "Shared folder members")
        app.buttons["Done"].tap()
        XCTAssertTrue(app.buttons["crew.playlist.create"].waitForExistence(timeout: 5))
        app.buttons["crew.playlist.crate-demo"].tap()
        XCTAssertTrue(app.navigationBars["Friday Warmup"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["crew.playlist.addTracks"].isHittable)
        app.navigationBars.buttons["BackButton"].tap()
        XCTAssertTrue(app.buttons["crew.members"].waitForExistence(timeout: 5))
        app.navigationBars.buttons["BackButton"].tap()
        XCTAssertTrue(folder.waitForExistence(timeout: 5))
        capture(app, "Shared folder at playlist root")

        openPlaylist("demo-c2", in: app)
        longPressTrack("A Walk", in: app)
        app.buttons["Add to playlist"].tap()
        XCTAssertTrue(folder.waitForExistence(timeout: 5))
        folder.tap()
        XCTAssertTrue(app.buttons["crew.playlist.crate-demo"].waitForExistence(timeout: 5))
        app.buttons["playlist.picker.cancel"].tap()
        XCTAssertTrue(app.buttons["playlist.back"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.staticTexts["playlist.title"].label, "Slow mornings")
    }

    func testSharedFolderViewerCannotEditOrInvite() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-test-library", UUID().uuidString, "--ui-test-crews", "--ui-test-crew-viewer"]
        app.launch()
        let folder = app.buttons["crew.folder.crew-demo"]
        XCTAssertTrue(folder.waitForExistence(timeout: 15))
        folder.tap()
        XCTAssertTrue(app.buttons["crew.members"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["crew.playlist.create"].exists)
        app.buttons["crew.members"].tap()
        XCTAssertTrue(app.staticTexts["Alex"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["crew.members.add"].exists)
        app.buttons["Done"].tap()
        app.buttons["crew.playlist.crate-demo"].tap()
        XCTAssertTrue(app.staticTexts["Empty playlist"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["crew.playlist.addTracks"].exists)
        app.navigationBars.buttons["BackButton"].tap()
        app.navigationBars.buttons["BackButton"].tap()

        openPlaylist("demo-c2", in: app)
        longPressTrack("A Walk", in: app)
        app.buttons["Add to playlist"].tap()
        XCTAssertTrue(folder.waitForExistence(timeout: 5))
        XCTAssertFalse(folder.isEnabled)
    }

    func testOpenUSBLibraryAndReturnToPlaylists() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-test-library", UUID().uuidString]
        app.launch()
        XCTAssertTrue(app.buttons["library.drawer.open"].waitForExistence(timeout: 15))
        XCTAssertFalse(app.buttons["usb.open"].exists)
        app.buttons["library.drawer.open"].tap()
        app.buttons["library.drawer.settings"].tap()
        let openUSB = app.buttons["settings.usb.chooseFolder"]
        XCTAssertTrue(openUSB.waitForExistence(timeout: 5)); openUSB.tap()
        let choose = app.buttons["usb.chooseFolder"]
        XCTAssertTrue(choose.waitForExistence(timeout: 5))
        XCTAssertTrue(choose.isHittable)
        capture(app, "USB library folder selection")
        app.buttons["usb.done"].tap()
        XCTAssertTrue(openUSB.waitForExistence(timeout: 5))
        app.buttons["connect.done"].tap()
        XCTAssertFalse(app.buttons["usb.open"].exists)
        XCTAssertTrue(app.buttons["playlist.row.demo-c2"].exists)
    }
    #endif

    #if os(macOS)
    func testLibrarySearchFavoritesAndOfflineFilter() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--demo"]
        app.launch()
        XCTAssertTrue(app.staticTexts["PREVIEW · Sample library, no accounts connected"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.buttons["All music"].waitForExistence(timeout: 5))
        capture(app, "Library")
        let search = app.textFields["library.search"]
        XCTAssertTrue(search.waitForExistence(timeout: 5))
        search.tap()
        search.typeText("no-such-track-49271")
        XCTAssertTrue(app.staticTexts["No matching tracks"].waitForExistence(timeout: 5))
        capture(app, "Search empty state")
        search.typeKey("a", modifierFlags: .command)
        search.typeKey(XCUIKeyboardKey.delete, modifierFlags: [])
        let favorite = app.buttons["Favorite A Walk"]
        XCTAssertTrue(favorite.waitForExistence(timeout: 5))
        favorite.tap()
        XCTAssertTrue(app.buttons["Unfavorite A Walk"].waitForExistence(timeout: 5))
        selectFilter("Favorites", in: app)
        XCTAssertTrue(app.buttons["Play A Walk"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["Play Glue"].exists)
        capture(app, "Favorites")
        selectFilter("On this device", in: app)
        XCTAssertTrue(app.staticTexts["No tracks"].waitForExistence(timeout: 5))
        capture(app, "Offline library")
    }

    func testConnectionSettingsFromLibrary() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--demo"]
        app.launch()
        XCTAssertTrue(app.staticTexts["PREVIEW · Sample library, no accounts connected"].waitForExistence(timeout: 15))
        let settings = app.buttons["Connection settings"].firstMatch
        XCTAssertTrue(settings.waitForExistence(timeout: 5))
        settings.tap()
        XCTAssertTrue(app.textFields.firstMatch.waitForExistence(timeout: 5))
        capture(app, "Connection settings")
    }

    func testCreateCollectionWithoutAnAccount() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--demo"]
        app.launch()
        XCTAssertTrue(app.staticTexts["PREVIEW · Sample library, no accounts connected"].waitForExistence(timeout: 15))
        let menu = app.buttons["library.collectionMenu"]
        XCTAssertTrue(menu.waitForExistence(timeout: 5))
        menu.tap()
        app.buttons["New playlist"].tap()
        let field = app.alerts.textFields.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap()
        field.typeText("Late night selections")
        app.alerts.buttons["Create"].tap()
        XCTAssertTrue(app.staticTexts["Late night selections"].firstMatch.waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["No tracks"].waitForExistence(timeout: 5))
        capture(app, "New local playlist")
    }
    #endif

    func testTrackCommentsAndColorSurviveRelaunch() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-test-library", UUID().uuidString]
        app.launch()
        #if os(iOS)
        openPlaylist("demo-c2", in: app)
        #else
        XCTAssertTrue(app.staticTexts["PREVIEW · Sample library, no accounts connected"].waitForExistence(timeout: 15))
        #endif

        #if os(iOS)
        let row = app.descendants(matching: .any)["track.row.demo-5"].firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 5))
        XCTAssertTrue(app.descendants(matching: .any)["track.waveform.demo-5"].firstMatch.exists)
        XCTAssertTrue(app.descendants(matching: .any)["track.bpm.demo-5"].firstMatch.exists)
        XCTAssertTrue(app.descendants(matching: .any)["track.key.demo-5"].firstMatch.exists)
        #endif
        capture(app, "Compact track metadata")

        openTrackDetails("A Walk", in: app)
        let comment = app.descendants(matching: .any)["track.comment.editor"].firstMatch
        XCTAssertTrue(comment.waitForExistence(timeout: 5))
        comment.tap()
        comment.typeText("Warm opening — blend after the break.")
        app.buttons["track.color.red"].tap()
        app.buttons["track.details.done"].tap()
        capture(app, "Saved track annotation")
        app.terminate()
        app.launch()
        #if os(iOS)
        XCTAssertTrue(app.buttons["track.waveform.demo-5"].waitForExistence(timeout: 15))
        #else
        XCTAssertTrue(app.buttons["Options for A Walk"].waitForExistence(timeout: 15))
        #endif
        openTrackDetails("A Walk", in: app)
        XCTAssertEqual(app.descendants(matching: .any)["track.comment.editor"].firstMatch.value as? String, "Warm opening — blend after the break.")
        let red = app.buttons["track.color.red"]
        XCTAssertTrue(red.isSelected || (red.value as? String) == "Selected")
        capture(app, "Annotation after cold launch")
        app.buttons["track.details.done"].tap()
    }

    #if os(iOS)
    func testAccessiblePlayerAndRemovalConfirmation() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-test-library", UUID().uuidString]
        app.launch()
        openPlaylist("demo-c2", in: app)
        let waveform = app.buttons["track.waveform.demo-4"]
        XCTAssertTrue(waveform.waitForExistence(timeout: 5))
        XCTAssertTrue(waveform.isHittable)
        waveform.tap()
        let player = app.descendants(matching: .any)["nowPlaying.bottom"].firstMatch
        let playerTitle = player.staticTexts["nowPlaying.title"]
        expectation(for: NSPredicate(format: "label == %@", "Nespole"), evaluatedWith: playerTitle)
        waitForExpectations(timeout: 5)
        for control in [player.buttons["nowPlaying.play"], player.buttons["nowPlaying.color"], waveform] {
            XCTAssertTrue(control.isHittable)
            XCTAssertGreaterThanOrEqual(control.frame.height, 44)
            XCTAssertGreaterThanOrEqual(control.frame.width, 44)
        }
        XCTAssertTrue(player.textFields["nowPlaying.annotation"].isHittable)
        XCTAssertTrue(player.scrollViews["nowPlaying.queue"].isHittable)
        let viewport = app.windows.firstMatch.frame
        for element in [playerTitle, player.buttons["nowPlaying.play"], player.buttons["nowPlaying.color"],
                        player.textFields["nowPlaying.annotation"], player.sliders["nowPlaying.progress"]] {
            XCTAssertGreaterThanOrEqual(element.frame.minX, viewport.minX - 1, "\(element.identifier) extends past the leading edge")
            XCTAssertLessThanOrEqual(element.frame.maxX, viewport.maxX + 1, "\(element.identifier) extends past the trailing edge")
        }
        capture(app, "Readable library and accessible player controls")

        let row = app.descendants(matching: .any)["track.row.demo-4"].firstMatch
        fullRowSwipe(in: app, through: row, right: false)
        let confirmation = app.alerts["Remove from playlist?"]
        XCTAssertTrue(confirmation.waitForExistence(timeout: 5))
        XCTAssertTrue(waveform.exists, "Removal waits for confirmation")
        capture(app, "Accessible removal confirmation")
        confirmation.buttons["playlist.removal.confirm"].firstMatch.tap()
        let undo = app.buttons["playlist.removal.undo"]
        XCTAssertTrue(undo.waitForExistence(timeout: 5))
        XCTAssertTrue(undo.isHittable)
        XCTAssertGreaterThanOrEqual(undo.frame.height, 44)
        capture(app, "Accessible persistent Undo")
        undo.tap()
        XCTAssertTrue(waveform.waitForExistence(timeout: 5))
        XCTAssertTrue(waveform.isHittable)
        XCTAssertEqual(playerTitle.label, "Nespole", "Undo preserves the selected player track")
        app.buttons["playlist.back"].tap()
        XCTAssertTrue(app.buttons["playlist.row.demo-c2"].waitForExistence(timeout: 5))
    }

    func testMinimalListsAndScrollingPlaylistTitle() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-test-library", UUID().uuidString, "--ui-test-long-playlist"]
        app.launch()
        XCTAssertTrue(app.buttons["playlist.row.demo-scroll"].waitForExistence(timeout: 15))
        assertMinimalChrome(app)
        XCTAssertFalse(app.textFields["playlist.search"].exists)
        XCTAssertFalse(app.buttons["playlist.create"].exists)
        XCTAssertFalse(app.buttons["playlist.sort.title"].exists)
        XCTAssertFalse(app.buttons["Options for playlist Long preview playlist"].exists)
        XCTAssertFalse(app.descendants(matching: .any)["playlist.waveform.demo-scroll"].firstMatch.exists)
        capture(app, "Plain playlist browser")

        openPlaylist("demo-scroll", in: app)
        assertMinimalChrome(app)
        let title = app.staticTexts["playlist.title"]
        let back = app.buttons["playlist.back"]
        let tracks = app.descendants(matching: .any)["library.tracks"].firstMatch
        let player = app.descendants(matching: .any)["nowPlaying.bottom"].firstMatch
        XCTAssertTrue(title.waitForExistence(timeout: 5))
        XCTAssertTrue(back.isHittable)
        XCTAssertTrue(tracks.descendants(matching: .any)["playlist.title"].firstMatch.exists,
                      "Playlist title belongs inside the track scroll view")
        let playerY = player.frame.minY
        tracks.swipeUp()
        expectation(for: NSPredicate(format: "hittable == false"), evaluatedWith: title)
        waitForExpectations(timeout: 5)
        XCTAssertFalse(back.isHittable, "Title and back control must scroll away together")
        XCTAssertTrue(player.isHittable)
        XCTAssertEqual(player.frame.minY, playerY, accuracy: 1)
        capture(app, "Scrolled playlist with pinned footer")
    }

    func testBottomPlayerStaysBelowLibrary() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-test-library", UUID().uuidString, "--ui-test-long-playlist"]
        app.launch()
        openPlaylist("demo-c2", in: app)
        app.buttons["track.waveform.demo-5"].tap()
        XCTAssertFalse(app.tabBars.firstMatch.exists)
        let player = app.descendants(matching: .any)["nowPlaying.bottom"].firstMatch
        XCTAssertTrue(player.waitForExistence(timeout: 5))
        XCTAssertFalse(player.buttons["nowPlaying.expand"].exists)
        XCTAssertTrue(player.isHittable)
        XCTAssertGreaterThan(player.frame.minY, app.frame.midY)
        XCTAssertFalse(player.staticTexts["NOW PLAYING"].exists)
        let playerComment = player.textFields["nowPlaying.annotation"]
        XCTAssertTrue(playerComment.exists)
        XCTAssertTrue(player.buttons["nowPlaying.color"].exists)
        XCTAssertTrue(player.descendants(matching: .any)["nowPlaying.waveform"].firstMatch.exists)
        XCTAssertTrue(player.descendants(matching: .any)["nowPlaying.overview"].firstMatch.exists)
        let queue = player.descendants(matching: .any)["nowPlaying.queue"].firstMatch
        XCTAssertTrue(queue.isHittable, "The queue stays visible without opening a sheet")
        XCTAssertTrue(player.scrollViews["nowPlaying.queue"].exists, "The full ordered queue scrolls horizontally")
        XCTAssertTrue(queue.buttons["nowPlaying.queue.track.demo-5"].exists)
        let row = app.descendants(matching: .any)["track.row.demo-5"].firstMatch
        XCTAssertTrue(row.exists)
        XCTAssertLessThanOrEqual(row.frame.maxY, player.frame.minY, "Player must stay below the library")
        capture(app, "Bottom player and single library")
        playerComment.tap()
        playerComment.typeText("Opening cue from player\n")
        player.buttons["nowPlaying.color"].tap()
        app.buttons["track.color.red"].tap()
        openTrackDetails("A Walk", in: app)
        XCTAssertTrue(app.descendants(matching: .any)["track.comment.editor"].firstMatch.waitForExistence(timeout: 5))
        XCTAssertEqual(app.descendants(matching: .any)["track.comment.editor"].firstMatch.value as? String, "Opening cue from player")
        let red = app.buttons["track.color.red"]
        XCTAssertTrue(red.isSelected || (red.value as? String) == "Selected")
        capture(app, "Footer annotation in track editor")
        app.buttons["track.details.done"].tap()
        let surface = player.descendants(matching: .any)["nowPlaying.surface"].firstMatch
        surface.tap()
        XCTAssertFalse(app.navigationBars["Now playing"].exists)
        XCTAssertTrue(app.buttons["playlist.back"].exists, "Tapping the footer must not navigate to another screen")
        surface.swipeLeft()
        XCTAssertTrue(player.staticTexts["Two Thousand and Seventeen"].waitForExistence(timeout: 5))
        XCTAssertTrue(surface.isHittable)
        XCTAssertFalse(app.navigationBars["Now playing"].exists, "Swiping must not open the player sheet")
        surface.swipeRight()
        XCTAssertTrue(player.staticTexts["A Walk"].waitForExistence(timeout: 5))
        XCTAssertTrue(surface.isHittable)
        XCTAssertFalse(app.navigationBars["Now playing"].exists)
        app.buttons["playlist.back"].tap()
        XCTAssertTrue(app.buttons["playlist.row.demo-c2"].waitForExistence(timeout: 5))
        XCTAssertTrue(queue.isHittable, "The queue stays visible while browsing playlists")
        let next = queue.buttons["nowPlaying.queue.track.demo-7"]
        XCTAssertTrue(next.isHittable)
        next.tap()
        XCTAssertTrue(player.staticTexts["Two Thousand and Seventeen"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["playlist.row.demo-c2"].exists, "Queue selection preserves library navigation")
        surface.swipeRight()
        XCTAssertTrue(player.staticTexts["A Walk"].waitForExistence(timeout: 5), "Queue selection preserves its ordered source")
        queue.swipeRight()
        let previous = queue.buttons["nowPlaying.queue.track.demo-4"]
        XCTAssertTrue(previous.isHittable, "Earlier tracks remain in the full queue")
        previous.tap()
        surface.swipeLeft()
        XCTAssertTrue(player.staticTexts["A Walk"].waitForExistence(timeout: 5), "Selecting an earlier queue item retains its following track")
        capture(app, "Visible queue in playlist browser")

        openPlaylist("demo-scroll", in: app)
        app.buttons["track.waveform.demo-scroll-1"].tap()
        XCTAssertTrue(player.staticTexts["Preview track 1"].waitForExistence(timeout: 5))
        queue.swipeLeft()
        XCTAssertTrue(player.staticTexts["Preview track 1"].exists, "Scrolling the queue must not change playback")
        let later = try XCTUnwrap(queue.buttons.allElementsBoundByIndex.last { $0.isHittable && $0.identifier != "nowPlaying.queue.track.demo-scroll-1" })
        let index = try XCTUnwrap(Int(later.identifier.components(separatedBy: "demo-scroll-").last ?? ""))
        XCTAssertGreaterThan(index, 2)
        later.tap()
        XCTAssertTrue(player.staticTexts["Preview track \(index)"].waitForExistence(timeout: 5))
        surface.swipeRight()
        XCTAssertTrue(player.staticTexts["Preview track \(index - 1)"].waitForExistence(timeout: 5), "Later queue selection must preserve the preceding track")
        let footerY = player.frame.minY
        let list = app.descendants(matching: .any)["library.tracks"].firstMatch
        // UIKit lays the collection view behind the pinned footer and uses a
        // content inset. Its default swipe can start on the player instead of
        // a library row, so drag within the visible library viewport.
        let origin = app.coordinate(withNormalizedOffset: .zero)
        let start = origin.withOffset(CGVector(dx: list.frame.midX - app.frame.minX,
                                              dy: min(list.frame.maxY, footerY) - app.frame.minY - 30))
        let end = origin.withOffset(CGVector(dx: list.frame.midX - app.frame.minX,
                                            dy: list.frame.minY - app.frame.minY + 30))
        start.press(forDuration: 0.05, thenDragTo: end)
        XCTAssertFalse(app.staticTexts["playlist.title"].isHittable, "Row pans must leave vertical list scrolling intact")
        XCTAssertEqual(player.frame.minY, footerY, accuracy: 1)
        capture(app, "Full queue scrolled to later recordings")
    }

    func testInlineFooterColorPersistsAndCloses() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-test-library", UUID().uuidString]
        app.launch()
        openPlaylist("demo-c2", in: app)
        app.buttons["track.waveform.demo-5"].tap()
        let footer = app.descendants(matching: .any)["nowPlaying.bottom"].firstMatch
        let color = footer.buttons["nowPlaying.color"]
        let palette = footer.descendants(matching: .any)["nowPlaying.color.palette"].firstMatch
        let note = footer.textFields["nowPlaying.annotation"]
        note.tap()
        note.typeText("Cue before drop\n")
        let footerY = footer.frame.minY
        let waveformY = footer.descendants(matching: .any)["nowPlaying.waveform"].firstMatch.frame.minY
        XCTAssertEqual(color.value as? String, "None")
        XCTAssertFalse(palette.exists)
        color.tap()
        XCTAssertTrue(palette.waitForExistence(timeout: 3))
        XCTAssertTrue(footer.buttons["track.color.red"].isHittable, "Color choices belong to the footer, not a popup")
        XCTAssertFalse(app.menus.firstMatch.exists)
        XCTAssertFalse(app.sheets.firstMatch.exists)
        XCTAssertEqual(footer.frame.minY, footerY, accuracy: 1)
        XCTAssertEqual(footer.descendants(matching: .any)["nowPlaying.waveform"].firstMatch.frame.minY, waveformY, accuracy: 1)
        XCTAssertGreaterThanOrEqual(palette.frame.minX, app.frame.minX)
        XCTAssertLessThanOrEqual(palette.frame.maxX, app.frame.maxX)
        XCTAssertTrue(app.buttons["playlist.back"].isHittable)
        capture(app, "Inline footer color palette")
        color.tap()
        XCTAssertFalse(palette.exists, "Tapping the swatch closes the inline palette")
        color.tap()
        footer.buttons["track.color.red"].tap()
        XCTAssertFalse(palette.exists)
        XCTAssertEqual(color.value as? String, "Red")
        XCTAssertEqual(note.value as? String, "Cue before drop")
        XCTAssertEqual(app.staticTexts["track.key.demo-5"].value as? String, "Red color")
        capture(app, "Inline footer color selection")
        app.terminate()
        app.launch()
        XCTAssertTrue(color.waitForExistence(timeout: 15))
        XCTAssertEqual(footer.staticTexts["nowPlaying.title"].label, "A Walk")
        XCTAssertEqual(color.value as? String, "Red")
        XCTAssertEqual(note.value as? String, "Cue before drop")
        XCTAssertFalse(palette.exists, "Transient palette state must not return after relaunch")
        color.tap()
        footer.buttons["track.color.none"].tap()
        XCTAssertEqual(color.value as? String, "None")
        XCTAssertFalse(palette.exists)
        app.terminate()
        app.launch()
        XCTAssertTrue(color.waitForExistence(timeout: 15))
        XCTAssertEqual(color.value as? String, "None", "Clearing the color must persist")
        color.tap()
        footer.buttons["nowPlaying.queue.track.demo-7"].tap()
        XCTAssertFalse(palette.exists, "Changing the current recording closes the palette")
        XCTAssertEqual(footer.staticTexts["nowPlaying.title"].label, "Two Thousand and Seventeen")
    }

    func testPlayerRestoresTrackQueuePositionAndCollection() throws {
        let app = XCUIApplication()
        let libraryID = UUID().uuidString
        app.launchArguments = ["--ui-test-library", libraryID, "--ui-test-session"]
        app.launch()
        let player = app.descendants(matching: .any)["nowPlaying.bottom"].firstMatch
        XCTAssertTrue(player.waitForExistence(timeout: 15))
        XCTAssertTrue(player.staticTexts["LesAlpx"].waitForExistence(timeout: 5))
        XCTAssertEqual(player.descendants(matching: .any)["nowPlaying.progress"].firstMatch.value as? String, "0:45 of 4:41")
        app.terminate()

        app.launchArguments = ["--ui-test-library", libraryID]
        app.launch()
        XCTAssertTrue(player.waitForExistence(timeout: 15))
        XCTAssertTrue(player.staticTexts["LesAlpx"].waitForExistence(timeout: 5))
        XCTAssertEqual(player.descendants(matching: .any)["nowPlaying.progress"].firstMatch.value as? String, "0:45 of 4:41")
        XCTAssertTrue(player.buttons["Play"].exists, "Restored playback must stay paused")
        XCTAssertFalse(player.buttons["Pause"].exists)
        XCTAssertTrue(app.staticTexts["After hours"].firstMatch.exists)
        XCTAssertFalse(app.buttons["Play A Walk"].exists, "Restore the selected collection filter")
        capture(app, "Restored player and collection")

        let surface = player.descendants(matching: .any)["nowPlaying.surface"].firstMatch
        surface.swipeLeft()
        XCTAssertTrue(player.staticTexts["Open Eye Signal"].waitForExistence(timeout: 5))
        surface.swipeRight()
        XCTAssertTrue(player.staticTexts["LesAlpx"].waitForExistence(timeout: 5))
        surface.swipeRight()
        XCTAssertTrue(player.staticTexts["Luminous Spaces"].waitForExistence(timeout: 5))
        capture(app, "Restored ordered queue")
    }

    func testLeftEdgeBackPreservesPlaylistAndFolders() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-test-library", UUID().uuidString]
        app.launch()
        let playlist = app.buttons["playlist.row.demo-c2"]
        XCTAssertTrue(playlist.waitForExistence(timeout: 15))
        fullRowSwipe(in: app, through: playlist, right: true)
        expectation(for: NSPredicate(format: "exists == true AND value == %@", "Pinned"), evaluatedWith: playlist)
        waitForExpectations(timeout: 5)
        XCTAssertEqual(playlist.value as? String, "Pinned")
        capture(app, "Pinned playlist browser")
        playlist.tap()
        XCTAssertTrue(app.buttons["playlist.back"].waitForExistence(timeout: 5))
        let track = app.descendants(matching: .any)["track.row.demo-5"].firstMatch
        XCTAssertTrue(track.waitForExistence(timeout: 5))
        let originalX = track.frame.minX
        edgeBack(in: app, through: track, complete: false)
        XCTAssertTrue(track.isHittable, "Cancelling edge Back must keep the current playlist interactive")
        XCTAssertEqual(app.staticTexts["playlist.title"].label, "Slow mornings")
        XCTAssertEqual(track.frame.minX, originalX, accuracy: 1, "The cancelled page must settle in its original position")
        XCTAssertFalse(app.buttons["playlist.picker.cancel"].exists)
        edgeBack(in: app, through: track)
        XCTAssertTrue(playlist.waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["playlist.picker.cancel"].exists, "Edge Back must not also trigger row right-add")
        playlist.tap()
        XCTAssertTrue(track.waitForExistence(timeout: 5), "Edge Back must preserve the recording")
        app.buttons["playlist.back"].tap()
        app.terminate()
        app.launch()
        XCTAssertTrue(playlist.waitForExistence(timeout: 15))
        XCTAssertEqual(playlist.value as? String, "Pinned")
        playlist.tap()
        XCTAssertTrue(app.buttons["playlist.back"].waitForExistence(timeout: 5))
        XCTAssertTrue(track.exists)
        app.buttons["playlist.back"].tap()

        let nestedPlaylist = app.buttons["playlist.row.demo-c4"]
        XCTAssertTrue(nestedPlaylist.waitForExistence(timeout: 5))
        nestedPlaylist.press(forDuration: 0.7)
        let edit = app.buttons["Edit playlist"]
        XCTAssertTrue(edit.waitForExistence(timeout: 5))
        edit.tap()
        let folder = app.textFields["playlist.edit.folder"]
        XCTAssertTrue(folder.waitForExistence(timeout: 5))
        folder.tap()
        folder.typeText("Demo sets / Nested")
        app.buttons["Save"].tap()
        let parentFolder = app.buttons["playlist.folder.Demo sets"]
        XCTAssertTrue(parentFolder.waitForExistence(timeout: 5))
        parentFolder.tap()
        let childFolder = app.buttons["playlist.folder.Nested"]
        XCTAssertTrue(childFolder.waitForExistence(timeout: 5))
        childFolder.tap()
        XCTAssertTrue(nestedPlaylist.waitForExistence(timeout: 5))
        edgeBack(in: app, through: nestedPlaylist)
        XCTAssertTrue(childFolder.waitForExistence(timeout: 5), "One edge gesture must return exactly one folder level")
        XCTAssertFalse(parentFolder.exists)
        XCTAssertTrue(app.navigationBars.buttons["BackButton"].exists)
        edgeBack(in: app, through: childFolder)
        XCTAssertTrue(parentFolder.waitForExistence(timeout: 5))
        XCTAssertFalse(app.navigationBars.buttons["BackButton"].exists)
        parentFolder.tap()
        childFolder.tap()
        XCTAssertTrue(nestedPlaylist.waitForExistence(timeout: 5), "Folder navigation must preserve its playlist")
        XCTAssertEqual(nestedPlaylist.value as? String, "Not pinned", "Edge Back must not also pin the row")
        capture(app, "Nested playlist preserved after edge back")
    }

    func testPlaylistCreationAndTrackSwipeActions() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-test-library", UUID().uuidString]
        app.launch()
        let source = app.buttons["playlist.row.demo-c2"]
        XCTAssertTrue(source.waitForExistence(timeout: 15))
        source.press(forDuration: 0.7)
        let create = app.buttons["New playlist"]
        XCTAssertTrue(create.waitForExistence(timeout: 5))
        create.tap()
        let field = app.alerts.textFields.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap()
        field.typeText("Late night selections")
        app.alerts.buttons["Create"].tap()
        XCTAssertTrue(app.staticTexts["playlist.title"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.staticTexts["playlist.title"].label, "Late night selections")
        app.buttons["playlist.back"].tap()

        openPlaylist("demo-c2", in: app)
        let track = app.descendants(matching: .any)["track.row.demo-5"].firstMatch
        XCTAssertTrue(track.waitForExistence(timeout: 5))
        app.buttons["track.waveform.demo-5"].tap()
        let player = app.descendants(matching: .any)["nowPlaying.bottom"].firstMatch
        let currentTitle = player.staticTexts["nowPlaying.title"]
        XCTAssertEqual(currentTitle.label, "A Walk")
        let availability = currentTitle.value as? String
        let queue = player.descendants(matching: .any)["nowPlaying.queue"].firstMatch
        let queueIDs = queue.buttons.allElementsBoundByIndex.map(\.identifier)
        let position = player.descendants(matching: .any)["nowPlaying.progress"].firstMatch.value as? String
        func assertPlaybackUnchanged() {
            XCTAssertEqual(currentTitle.label, "A Walk")
            XCTAssertEqual(currentTitle.value as? String, availability)
            XCTAssertEqual(player.buttons["nowPlaying.play"].label, "Play")
            XCTAssertEqual(player.descendants(matching: .any)["nowPlaying.progress"].firstMatch.value as? String, position)
            XCTAssertEqual(queue.buttons.allElementsBoundByIndex.map(\.identifier), queueIDs)
        }
        func assertOriginalOrder() {
            let before = app.descendants(matching: .any)["track.row.demo-4"].firstMatch
            let after = app.descendants(matching: .any)["track.row.demo-7"].firstMatch
            XCTAssertTrue(track.waitForExistence(timeout: 5))
            XCTAssertLessThan(before.frame.midY, track.frame.midY)
            XCTAssertLessThan(track.frame.midY, after.frame.midY)
        }
        fullRowSwipe(in: app, through: track, right: true)
        XCTAssertTrue(app.buttons["playlist.picker.cancel"].waitForExistence(timeout: 5))
        let created = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label CONTAINS %@", "playlist.row.", "Late night selections")).firstMatch
        XCTAssertTrue(created.isHittable)
        created.tap()
        XCTAssertTrue(app.buttons["playlist.back"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.staticTexts["playlist.title"].label, "Slow mornings", "Right-add preserves the source playlist")
        XCTAssertTrue(track.exists)
        fullRowSwipe(in: app, through: track, right: false)
        let confirmation = app.alerts["Remove from playlist?"]
        XCTAssertTrue(confirmation.waitForExistence(timeout: 5))
        XCTAssertTrue(track.exists, "Swiping must request confirmation before changing membership")
        capture(app, "Playlist removal confirmation")
        confirmation.buttons["playlist.removal.cancel"].firstMatch.tap()
        XCTAssertTrue(track.isHittable)
        XCTAssertFalse(app.descendants(matching: .any)["playlist.removal.notice"].firstMatch.exists)
        assertPlaybackUnchanged()

        fullRowSwipe(in: app, through: track, right: false)
        XCTAssertTrue(confirmation.waitForExistence(timeout: 5))
        confirmation.buttons["playlist.removal.confirm"].firstMatch.tap()
        expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: track)
        waitForExpectations(timeout: 5)
        let undo = app.buttons["playlist.removal.undo"]
        XCTAssertTrue(undo.waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["playlist.back"].exists, "Middle-row left swipe removes without navigating Back")
        XCTAssertEqual(app.staticTexts["playlist.title"].label, "Slow mornings")
        assertPlaybackUnchanged()
        capture(app, "Removed playlist member with Undo")
        undo.tap()
        assertOriginalOrder()
        assertPlaybackUnchanged()
        XCTAssertFalse(undo.exists)

        longPressTrack("A Walk", in: app)
        let remove = app.buttons["Remove from playlist"]
        XCTAssertTrue(remove.waitForExistence(timeout: 5))
        remove.tap()
        XCTAssertTrue(confirmation.waitForExistence(timeout: 5), "Context-menu removal uses the same confirmation")
        XCTAssertTrue(track.exists)
        confirmation.buttons["playlist.removal.confirm"].firstMatch.tap()
        expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: track)
        waitForExpectations(timeout: 5)
        assertPlaybackUnchanged()
        app.buttons["playlist.back"].tap()
        XCTAssertTrue(created.waitForExistence(timeout: 5))
        created.tap()
        XCTAssertTrue(app.buttons["track.waveform.demo-5"].waitForExistence(timeout: 5), "Removing from source must preserve the added target membership")
        XCTAssertTrue(undo.isHittable, "Undo remains available after navigating to another playlist")
        undo.tap()
        XCTAssertEqual(app.staticTexts["playlist.title"].label, "Late night selections")
        app.buttons["playlist.back"].tap()
        openPlaylist("demo-c2", in: app)
        assertOriginalOrder()
        assertPlaybackUnchanged()
        capture(app, "Undo restores original playlist order")
    }

    func testDeletingPlaylistKeepsEarlierRemovalUndo() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-test-library", UUID().uuidString]
        app.launch()
        let confirmation = app.alerts["Remove from playlist?"]

        openPlaylist("demo-c2", in: app)
        let first = app.descendants(matching: .any)["track.row.demo-5"].firstMatch
        fullRowSwipe(in: app, through: first, right: false)
        XCTAssertTrue(confirmation.waitForExistence(timeout: 5))
        confirmation.buttons["playlist.removal.confirm"].firstMatch.tap()
        XCTAssertFalse(first.exists)
        app.buttons["playlist.back"].tap()

        openPlaylist("demo-c3", in: app)
        let second = app.descendants(matching: .any)["track.row.demo-2"].firstMatch
        fullRowSwipe(in: app, through: second, right: false)
        XCTAssertTrue(confirmation.waitForExistence(timeout: 5))
        confirmation.buttons["playlist.removal.confirm"].firstMatch.tap()
        XCTAssertFalse(second.exists)
        app.buttons["playlist.back"].tap()
        let deletedPlaylist = app.buttons["playlist.row.demo-c3"]
        deletedPlaylist.press(forDuration: 0.7)
        app.buttons["Delete playlist"].tap()
        let deleteConfirmation = app.alerts["Delete playlist?"]
        XCTAssertTrue(deleteConfirmation.waitForExistence(timeout: 5))
        deleteConfirmation.buttons["Delete playlist"].tap()
        expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: deletedPlaylist)
        waitForExpectations(timeout: 5)

        let undo = app.buttons["playlist.removal.undo"]
        XCTAssertTrue(undo.isHittable, "Deleting the newest removal's playlist must preserve earlier valid Undo")
        undo.tap()
        XCTAssertFalse(deletedPlaylist.exists, "Undo must not resurrect the deleted playlist")
        openPlaylist("demo-c2", in: app)
        XCTAssertTrue(first.waitForExistence(timeout: 5))
        XCTAssertLessThan(app.descendants(matching: .any)["track.row.demo-4"].firstMatch.frame.midY, first.frame.midY)
        XCTAssertLessThan(first.frame.midY, app.descendants(matching: .any)["track.row.demo-7"].firstMatch.frame.midY)
        XCTAssertFalse(undo.exists)
        capture(app, "Earlier Undo survives playlist deletion")
    }

    /// Opt-in process launches against the same on-device library, with sync disabled.
    func testCachedStartupPerformance() throws {
        let run = ProcessInfo.processInfo.environment["DJBOOTH_STARTUP_RUN"] ?? ""
        try XCTSkipUnless(UUID(uuidString: run) != nil, "Set DJBOOTH_STARTUP_RUN to a UUID to measure the cached library")
        print("DJBooth startup run: \(run)")
        let app = XCUIApplication()
        app.launchArguments = ["--ui-test-muted", "--performance-probe", "--performance-offline", "--performance-run", run]
        var restoredTitle: String?
        for _ in 0..<5 {
            app.launch()
            let footer = app.descendants(matching: .any)["nowPlaying.bottom"].firstMatch
            XCTAssertTrue(footer.waitForExistence(timeout: 20))
            let title = app.descendants(matching: .any)["nowPlaying.title"].firstMatch
            XCTAssertTrue(title.exists)
            XCTAssertNotEqual(title.label, "No track selected")
            if let restoredTitle { XCTAssertEqual(title.label, restoredTitle, "Last-played track survives a process restart") }
            else { restoredTitle = title.label }
            XCTAssertEqual(app.buttons["nowPlaying.play"].label, "Play", "Startup restores the player paused")
            let waveform = app.descendants(matching: .any)["nowPlaying.waveform"].firstMatch
            XCTAssertTrue(waveform.exists)
            XCTAssertNotEqual(waveform.value as? String, "Analysis unavailable", "The first screen includes the saved track's waveform")
            app.terminate()
        }
    }

    /// Opt-in, read-only media workload on the dedicated simulator. No library mutations or network.
    func testRealCachedPerformanceWorkload() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["DJBOOTH_PERFORMANCE_TEST"] == "1",
                          "Performance workload requires the dedicated simulator's cached Brunello library")
        let run = ProcessInfo.processInfo.environment["DJBOOTH_PERFORMANCE_RUN"] ?? UUID().uuidString
        XCTAssertNotNil(UUID(uuidString: run))
        print("DJBooth performance run: \(run)")
        let app = XCUIApplication()
        app.launchArguments = ["--ui-test-muted", "--performance-probe", "--performance-offline", "--performance-run", run]
        let player = app.descendants(matching: .any)["nowPlaying.bottom"].firstMatch
        let play = player.buttons["nowPlaying.play"]
        // Canonicalize only this simulator's playback session before timing either binary.
        // Library membership, annotations, downloads, and cloud state remain untouched.
        app.launchArguments = ["--ui-test-muted", "--performance-probe", "--performance-offline"]
        app.launch()
        XCTAssertTrue(player.waitForExistence(timeout: 30))
        let initialTrack = app.buttons["track.waveform.65582957"]
        XCTAssertTrue(initialTrack.waitForExistence(timeout: 5))
        initialTrack.tap()
        expectation(for: NSPredicate(format: "label == %@", "Pause"), evaluatedWith: play)
        waitForExpectations(timeout: 10)
        play.tap()
        seek(player.descendants(matching: .any)["nowPlaying.progress"].firstMatch, fraction: 0)
        app.terminate()
        app.launchArguments += ["--performance-run", run]
        for _ in 0..<3 {
            app.launch()
            XCTAssertTrue(player.waitForExistence(timeout: 30))
            XCTAssertTrue(play.waitForExistence(timeout: 5))
            XCTAssertEqual(play.label, "Play", "Restored sessions start paused")
            app.terminate()
        }
        app.launch()
        XCTAssertTrue(player.waitForExistence(timeout: 30))
        let ids = ["65582957", "6861975", "133924369", "157607543", "261330937", "130676973"]
        for _ in 0..<4 {
            for id in ids {
                let row = app.buttons["track.waveform.\(id)"]
                XCTAssertTrue(row.waitForExistence(timeout: 5), "Keep the existing Brunello playlist selected for this opt-in workload")
                XCTAssertTrue(row.isHittable)
                row.tap()
                expectation(for: NSPredicate(format: "label == %@", "Pause"), evaluatedWith: play)
                waitForExpectations(timeout: 10)
                XCTAssertEqual(player.staticTexts["nowPlaying.title"].value as? String, "Available offline")
            }
        }
        play.tap()
        XCTAssertEqual(play.label, "Play")
        // Settle retired AVPlayerItems and background raster work before the final footprint samples.
        RunLoop.current.run(until: Date().addingTimeInterval(5))
        capture(app, "Performance workload completed with cached media paused")
        app.terminate()
    }

    func testRealCachedPlaybackRestoresAndAdvances() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["DJBOOTH_REAL_PLAYBACK_TEST"] == "1",
                          "Opt in only on the dedicated simulator with its existing offline library")
        let app = XCUIApplication()
        app.launchArguments = ["--ui-test-muted"]
        app.launch()
        let player = app.descendants(matching: .any)["nowPlaying.bottom"].firstMatch
        XCTAssertTrue(player.waitForExistence(timeout: 15))
        let play = player.buttons["nowPlaying.play"]
        XCTAssertTrue(play.waitForExistence(timeout: 5))
        XCTAssertTrue(play.isEnabled)
        let currentTitle = player.staticTexts["nowPlaying.title"]
        let title = currentTitle.label
        XCTAssertEqual(currentTitle.value as? String, "Available offline")
        XCTAssertFalse(player.buttons["nowPlaying.expand"].exists)
        let progress = player.descendants(matching: .any)["nowPlaying.progress"].firstMatch
        if play.label == "Pause" { play.tap() }
        seek(progress, fraction: 0)
        XCTAssertLessThanOrEqual(playbackSeconds(progress), 1)
        let waveform = player.descendants(matching: .any)["nowPlaying.waveform"].firstMatch
        expectation(for: NSPredicate(format: "value CONTAINS %@", "8 bars, Rekordbox beatgrid"), evaluatedWith: waveform)
        waitForExpectations(timeout: 10)
        XCTAssertTrue(player.descendants(matching: .any)["nowPlaying.overview"].firstMatch.exists)
        capture(app, "Real 8-bar waveform paused at start")
        let queue = player.descendants(matching: .any)["nowPlaying.queue"].firstMatch
        let queueIDs = queue.buttons.allElementsBoundByIndex.map(\.identifier)
        dragWaveform(waveform, forward: false)
        XCTAssertLessThanOrEqual(playbackSeconds(progress), 1, "Rewinding the focused waveform clamps at zero")
        dragWaveform(waveform, forward: true)
        let scrubbed = playbackSeconds(progress)
        XCTAssertGreaterThan(scrubbed, 2, "Dragging the focused waveform left must seek forward")
        XCTAssertEqual(play.label, "Play", "Scrubbing paused audio must remain paused")
        XCTAssertEqual(currentTitle.label, title)
        XCTAssertEqual(queue.buttons.allElementsBoundByIndex.map(\.identifier), queueIDs)
        dragWaveform(waveform, forward: false)
        XCTAssertLessThan(playbackSeconds(progress), scrubbed, "Dragging the focused waveform right must seek backward")
        seek(progress, fraction: 1)
        let duration = playbackClockSeconds(identifier: "nowPlaying.duration")
        dragWaveform(waveform, forward: true)
        XCTAssertEqual(playbackSeconds(progress), duration, accuracy: 1, "Forward scrubbing clamps at the recording end")
        XCTAssertEqual(currentTitle.label, title)
        XCTAssertEqual(play.label, "Play")

        seek(progress, fraction: 0.25)
        let sought = playbackSeconds(progress)
        XCTAssertGreaterThan(sought, 5, "Real cached media must seek away from its start")
        if play.label == "Pause" { play.tap() }
        app.terminate()

        app.launch()
        XCTAssertTrue(player.waitForExistence(timeout: 15))
        XCTAssertTrue(player.staticTexts[title].waitForExistence(timeout: 5))
        XCTAssertEqual(play.label, "Play")
        XCTAssertEqual(playbackSeconds(progress), sought, accuracy: 2)
        play.tap()
        defer { if play.exists, play.label == "Pause" { play.tap() } }
        capture(app, "Long current title at playback start")
        let advancing = NSPredicate { _, _ in self.playbackSeconds(progress) > sought + 3 }
        expectation(for: advancing, evaluatedWith: progress)
        waitForExpectations(timeout: 10)
        capture(app, "Long current title scrolling during playback")
        XCTAssertEqual(play.label, "Pause")
        XCTAssertTrue((waveform.value as? String)?.contains("Playing, 8 bars") == true)
        let beforePlayingScrub = playbackSeconds(progress)
        dragWaveform(waveform, forward: true)
        XCTAssertGreaterThan(playbackSeconds(progress), beforePlayingScrub + 2)
        XCTAssertEqual(play.label, "Pause", "Scrubbing playing audio must keep playing")
        XCTAssertEqual(currentTitle.label, title)
        XCTAssertEqual(queue.buttons.allElementsBoundByIndex.map(\.identifier), queueIDs)
        capture(app, "Real 8-bar waveform during cached playback")
        play.tap()
        capture(app, "Real cached playback after restored seek")
    }

    func testRealCachedPreparationRaces() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["DJBOOTH_REAL_PLAYBACK_TEST"] == "1",
                          "Requires the dedicated simulator's existing offline media")
        let app = XCUIApplication()
        let runID = UUID().uuidString
        print("Playback race diagnostics run: \(runID)")
        app.launchArguments = ["--ui-test-muted", "--performance-probe", "--performance-run", runID, "--performance-offline", "--ui-test-playback-races"]
        app.launch()
        let result = app.staticTexts["playback.race.result"]
        XCTAssertTrue(result.waitForExistence(timeout: 30))
        expectation(for: NSPredicate(format: "label BEGINSWITH %@ OR label BEGINSWITH %@", "Passed", "Failed"), evaluatedWith: result)
        waitForExpectations(timeout: 35)
        XCTAssertEqual(result.label, "Passed 3 playback races")
        XCTAssertEqual(app.buttons["nowPlaying.play"].label, "Play")
    }

    func testRealCachedLiveScrubbingReadiness() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["DJBOOTH_REAL_PLAYBACK_TEST"] == "1",
                          "Requires the dedicated simulator's existing offline media")
        let app = XCUIApplication()
        let runID = UUID().uuidString
        print("Live scrub diagnostics run: \(runID)")
        app.launchArguments = ["--ui-test-muted", "--performance-probe", "--performance-run", runID,
                               "--performance-offline", "--ui-test-playback-races", "--ui-test-live-scrubbing"]
        app.launch()
        let result = app.staticTexts["playback.race.result"]
        XCTAssertTrue(result.waitForExistence(timeout: 30))
        expectation(for: NSPredicate(format: "label BEGINSWITH %@ OR label BEGINSWITH %@", "Passed", "Failed"), evaluatedWith: result)
        waitForExpectations(timeout: 45)
        XCTAssertEqual(result.label, "Passed live scrub checks")
        XCTAssertEqual(app.buttons["nowPlaying.play"].label, "Play")
        capture(app, "Native decoder ready before scrub release")
    }

    /// Slow, held gestures are also recorded for visual comparison during the touch.
    /// The direct probe above checks decoder time while the shared scrub session stays held.
    func testRealCachedCoordinatedScrubControls() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["DJBOOTH_REAL_PLAYBACK_TEST"] == "1",
                          "Requires the dedicated simulator's existing offline media")
        let app = XCUIApplication()
        app.launchArguments = ["--ui-test-muted", "--performance-probe", "--performance-offline"]
        app.launch()
        let footer = app.descendants(matching: .any)["nowPlaying.bottom"].firstMatch
        XCTAssertTrue(footer.waitForExistence(timeout: 30))
        let play = footer.buttons["nowPlaying.play"]
        let title = footer.staticTexts["nowPlaying.title"]
        let originalTitle = title.label
        XCTAssertEqual(title.value as? String, "Available offline")
        let slider = footer.sliders["nowPlaying.progress"]
        let waveform = footer.descendants(matching: .any)["nowPlaying.waveform"].firstMatch
        let originalPosition = playbackSeconds(slider)
        let duration = playbackClockSeconds(identifier: "nowPlaying.duration")
        let queue = footer.descendants(matching: .any)["nowPlaying.queue"].firstMatch
        let queueIDs = queue.buttons.allElementsBoundByIndex.map(\.identifier)
        defer {
            if play.exists, play.label == "Pause" { play.tap() }
            if slider.exists { seek(slider, fraction: originalPosition / duration) }
        }
        if play.label == "Pause" { play.tap() }
        seek(slider, fraction: 0.25)
        capture(app, "Paused before held timeline scrub")
        slider.coordinate(withNormalizedOffset: CGVector(dx: 0.25, dy: 0.5))
            .press(forDuration: 0.1,
                   thenDragTo: slider.coordinate(withNormalizedOffset: CGVector(dx: 0.60, dy: 0.5)),
                   withVelocity: .slow, thenHoldForDuration: 1)
        let afterTimeline = playbackSeconds(slider)
        XCTAssertGreaterThan(afterTimeline, duration * 0.5)
        XCTAssertEqual(play.label, "Play")
        capture(app, "Paused after held timeline scrub")
        waveform.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.5))
            .press(forDuration: 0.1,
                   thenDragTo: waveform.coordinate(withNormalizedOffset: CGVector(dx: 0.2, dy: 0.5)),
                   withVelocity: .slow, thenHoldForDuration: 1)
        let afterWaveform = playbackSeconds(slider)
        XCTAssertGreaterThan(afterWaveform, afterTimeline + 2)
        XCTAssertEqual(play.label, "Play")
        capture(app, "Timeline follows held eight-bar waveform")
        play.tap()
        expectation(for: NSPredicate { _, _ in self.playbackSeconds(slider) > afterWaveform + 1 }, evaluatedWith: slider)
        waitForExpectations(timeout: 8)
        let beforePlayingDrag = playbackSeconds(slider)
        waveform.coordinate(withNormalizedOffset: CGVector(dx: 0.2, dy: 0.5))
            .press(forDuration: 0.1,
                   thenDragTo: waveform.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.5)),
                   withVelocity: .slow, thenHoldForDuration: 1)
        let afterPlayingDrag = playbackSeconds(slider)
        XCTAssertLessThan(afterPlayingDrag, beforePlayingDrag - 2)
        XCTAssertEqual(play.label, "Pause", "Held scrub preserves playback intent")
        expectation(for: NSPredicate { _, _ in self.playbackSeconds(slider) > afterPlayingDrag + 1 }, evaluatedWith: slider)
        waitForExpectations(timeout: 8)
        XCTAssertEqual(title.label, originalTitle)
        XCTAssertEqual(queue.buttons.allElementsBoundByIndex.map(\.identifier), queueIDs)
        XCTAssertFalse(app.alerts.firstMatch.exists)
        capture(app, "Playback continues after live waveform scrub")
    }

    func testRealCachedPlaybackWithServerUnavailable() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["DJBOOTH_REAL_PLAYBACK_TEST"] == "1",
                          "Requires the dedicated simulator's existing offline media")
        let app = XCUIApplication()
        app.launchArguments = ["--ui-test-muted", "--ui-test-server-unavailable"]
        app.launch()
        let player = app.descendants(matching: .any)["nowPlaying.bottom"].firstMatch
        XCTAssertTrue(player.waitForExistence(timeout: 30))
        let title = player.staticTexts["nowPlaying.title"].label
        XCTAssertEqual(player.staticTexts["nowPlaying.title"].value as? String, "Available offline")
        let play = player.buttons["nowPlaying.play"]
        let progress = player.descendants(matching: .any)["nowPlaying.progress"].firstMatch
        XCTAssertFalse(app.alerts.firstMatch.exists, "Cloud failure must not block local playback")
        play.tap()
        expectation(for: NSPredicate(format: "label == %@", "Pause"), evaluatedWith: play)
        waitForExpectations(timeout: 10)
        let before = playbackSeconds(progress)
        expectation(for: NSPredicate { _, _ in self.playbackSeconds(progress) > before + 1 }, evaluatedWith: progress)
        waitForExpectations(timeout: 8)
        play.tap()
        seek(progress, fraction: 0.25)
        let sought = playbackSeconds(progress)
        XCTAssertGreaterThan(sought, 5)
        app.terminate()
        app.launch()
        XCTAssertTrue(player.waitForExistence(timeout: 30))
        XCTAssertEqual(player.staticTexts["nowPlaying.title"].label, title)
        XCTAssertEqual(play.label, "Play")
        XCTAssertEqual(playbackSeconds(progress), sought, accuracy: 2)
        XCTAssertFalse(app.alerts.firstMatch.exists)
        play.tap()
        expectation(for: NSPredicate { _, _ in self.playbackSeconds(progress) > sought + 1 }, evaluatedWith: progress)
        waitForExpectations(timeout: 8)
        player.descendants(matching: .any)["nowPlaying.surface"].firstMatch.swipeLeft()
        expectation(for: NSPredicate(format: "label != %@", title), evaluatedWith: player.staticTexts["nowPlaying.title"])
        waitForExpectations(timeout: 10)
        XCTAssertEqual(play.label, "Pause")
        XCTAssertEqual(player.staticTexts["nowPlaying.title"].value as? String, "Available offline")
        XCTAssertFalse(app.alerts.firstMatch.exists)
        play.tap()
        capture(app, "Cached library works with both services unavailable")
    }

    private func seek(_ progress: XCUIElement, fraction: CGFloat) {
        if progress.elementType == .slider {
            progress.adjust(toNormalizedSliderPosition: fraction)
        } else {
            progress.coordinate(withNormalizedOffset: CGVector(dx: max(0.001, min(0.999, fraction)), dy: 0.5)).tap()
        }
    }

    private func playbackSeconds(_ progress: XCUIElement) -> Double {
        playbackClockSeconds(identifier: "nowPlaying.elapsed")
    }

    private func playbackClockSeconds(identifier: String, file: StaticString = #filePath, line: UInt = #line) -> Double {
        let clock = XCUIApplication().staticTexts[identifier].firstMatch
        XCTAssertTrue(clock.exists, "Playback clock is missing: \(identifier)", file: file, line: line)
        let value = (clock.value as? String) ?? clock.label
        let components = value.split(separator: ":", omittingEmptySubsequences: false)
        let numbers = components.compactMap { Double($0) }
        guard (2...3).contains(components.count), numbers.count == components.count,
              numbers.allSatisfy({ $0.isFinite && $0 >= 0 }) else {
            XCTFail("Invalid playback clock \(identifier): \(value)", file: file, line: line)
            return .nan
        }
        return numbers.reduce(0) { $0 * 60 + $1 }
    }

    private func openPlaylist(_ id: String, in app: XCUIApplication) {
        let playlist = app.buttons["playlist.row.\(id)"]
        let browser = app.collectionViews["playlist.browser"]
        XCTAssertTrue(browser.waitForExistence(timeout: 15))
        for _ in 0..<5 {
            if playlist.exists && playlist.isHittable { break }
            browser.swipeUp()
        }
        XCTAssertTrue(playlist.waitForExistence(timeout: 15))
        playlist.tap()
        XCTAssertTrue(app.buttons["playlist.back"].waitForExistence(timeout: 5))
    }

    private func assertMinimalChrome(_ app: XCUIApplication) {
        XCTAssertFalse(app.tabBars.firstMatch.exists)
        XCTAssertFalse(app.navigationBars["Library"].exists)
        XCTAssertFalse(app.buttons["Connection settings"].exists)
        XCTAssertFalse(app.scrollViews["library.filters"].exists)
        XCTAssertFalse(app.buttons["library.playlists"].exists)
        XCTAssertFalse(app.buttons["library.collectionMenu"].exists)
        XCTAssertFalse(app.textFields["library.search"].exists)
        XCTAssertFalse(app.buttons["track.sort.default"].exists)
        XCTAssertFalse(app.buttons["Options for A Walk"].exists)
    }

    private func longPressTrack(_ title: String, in app: XCUIApplication) {
        let rows = app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier BEGINSWITH %@", "track.row."))
            .containing(.button, identifier: "Play \(title)")
        XCTAssertTrue(rows.firstMatch.waitForExistence(timeout: 5))
        let row = rows.allElementsBoundByIndex.last(where: { $0.isHittable }) ?? rows.firstMatch
        row.buttons.matching(identifier: "Play \(title)").firstMatch.press(forDuration: 0.7)
    }

    private func edgeBack(in app: XCUIApplication, through row: XCUIElement, complete: Bool = true) {
        let origin = app.coordinate(withNormalizedOffset: .zero)
        let y = row.frame.midY - app.frame.minY
        origin.withOffset(CGVector(dx: 2, dy: y))
            .press(forDuration: 0.05,
                   thenDragTo: origin.withOffset(CGVector(dx: app.frame.width * (complete ? 0.72 : 0.10), dy: y)),
                   withVelocity: .slow, thenHoldForDuration: 0.2)
    }

    private func fullRowSwipe(in app: XCUIApplication, through row: XCUIElement, right: Bool) {
        let origin = app.coordinate(withNormalizedOffset: .zero)
        let y = row.frame.midY - app.frame.minY
        origin.withOffset(CGVector(dx: app.frame.width * (right ? 0.15 : 0.90), dy: y))
            .press(forDuration: 0.05,
                   thenDragTo: origin.withOffset(CGVector(dx: app.frame.width * (right ? 0.98 : 0.02), dy: y)),
                   withVelocity: .fast, thenHoldForDuration: 0)
    }

    private func dragWaveform(_ waveform: XCUIElement, forward: Bool) {
        waveform.coordinate(withNormalizedOffset: CGVector(dx: forward ? 0.8 : 0.2, dy: 0.5))
            .press(forDuration: 0.05,
                   thenDragTo: waveform.coordinate(withNormalizedOffset: CGVector(dx: forward ? 0.2 : 0.8, dy: 0.5)),
                   withVelocity: .slow, thenHoldForDuration: 0.1)
    }
    #endif

    #if os(macOS)
    private func selectFilter(_ title: String, in app: XCUIApplication) {
        let button = app.buttons[title].firstMatch
        XCTAssertTrue(button.waitForExistence(timeout: 5))
        button.tap()
    }
    #endif

    private func openTrackDetails(_ title: String, in app: XCUIApplication) {
        #if os(iOS)
        longPressTrack(title, in: app)
        #else
        let menus = app.buttons.matching(identifier: "Options for \(title)")
        XCTAssertTrue(menus.firstMatch.waitForExistence(timeout: 5))
        // SwiftUI can expose the covered library while its queue sheet is open.
        let menu = menus.allElementsBoundByIndex.last(where: { $0.isHittable }) ?? menus.firstMatch
        menu.tap()
        #endif
        let details = app.buttons["Comment & color"]
        XCTAssertTrue(details.waitForExistence(timeout: 5))
        details.tap()
    }

    private func capture(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}

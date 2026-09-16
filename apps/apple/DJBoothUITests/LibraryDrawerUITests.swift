#if os(iOS)
import XCTest
import UIKit

@MainActor
final class LibraryDrawerUITests: XCTestCase {
    override func setUpWithError() throws { continueAfterFailure = false }

    func testDrawerBrowsingAndDownload() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-test-library", UUID().uuidString]
        app.launch()
        let playlist = app.buttons["playlist.row.demo-c2"]
        XCTAssertTrue(playlist.waitForExistence(timeout: 15))
        let drawerButtonFrame = app.buttons["Show Sidebar"].frame
        assertDrawerButton(app, at: drawerButtonFrame)
        edgeSwipe(app, through: playlist)
        let artists = app.buttons["library.drawer.artists"]
        XCTAssertTrue(artists.waitForExistence(timeout: 5))
        assertDrawerButton(app, at: drawerButtonFrame, label: "Hide Sidebar")
        let sidebar = app.collectionViews["library.sidebar"]
        XCTAssertEqual(sidebar.frame.width, app.frame.width * 2 / 3, accuracy: 2, "Drawer leaves a third of the library visible")
        XCTAssertGreaterThan(sidebar.frame.maxY, app.frame.maxY - 50, "Drawer extends below the player to the bottom safe area")
        for id in ["playlists", "artists", "albums", "tracks", "download", "settings"] {
            let row = app.buttons["library.drawer.\(id)"]
            XCTAssertTrue(row.isHittable, "Every drawer option is visible without scrolling")
            XCTAssertGreaterThanOrEqual(row.frame.height, 44)
            XCTAssertLessThanOrEqual(row.frame.height, 56, "Drawer uses compact library rows")
        }
        capture(app, "Drawer matches library style")
        let play = app.buttons["nowPlaying.play"]
        let transportLabel = play.label
        app.coordinate(withNormalizedOffset: .zero)
            .withOffset(CGVector(dx: app.frame.width * 0.9, dy: play.frame.midY - app.frame.minY)).tap()
        expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: artists)
        waitForExpectations(timeout: 5)
        XCTAssertEqual(play.label, transportLabel, "Tapping the backdrop dismisses the drawer without changing playback")
        edgeSwipe(app, through: playlist)
        XCTAssertTrue(artists.waitForExistence(timeout: 5))
        sidebar.swipeLeft()
        expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: artists)
        waitForExpectations(timeout: 5)
        XCTAssertFalse(app.navigationBars["Sync & settings"].exists, "Dismissing must not select a menu item")
        XCTAssertTrue(playlist.waitForExistence(timeout: 5))
        edgeSwipe(app, through: playlist)
        XCTAssertTrue(artists.waitForExistence(timeout: 5))
        artists.tap()
        let tycho = app.buttons["library.group.Tycho"]
        reveal(tycho, in: app.collectionViews["library.groups"])
        assertDrawerButton(app, at: drawerButtonFrame)
        capture(app, "Artists use the library theme")
        tycho.tap()
        let walk = app.buttons["track.waveform.demo-5"]
        XCTAssertTrue(walk.waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["Show Sidebar"].exists)
        XCTAssertFalse(app.buttons["track.waveform.demo-4"].exists)
        walk.tap()
        XCTAssertTrue(app.buttons["nowPlaying.queue.track.demo-5"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["nowPlaying.queue.track.demo-4"].exists)
        let player = app.descendants(matching: .any)["nowPlaying.bottom"].firstMatch
        XCTAssertTrue(player.isHittable)
        XCTAssertGreaterThan(player.frame.minY, app.frame.midY)
        XCTAssertLessThanOrEqual(walk.frame.maxY, player.frame.minY, "Library content stays above the pinned player")
        let comment = player.textFields["nowPlaying.annotation"]
        comment.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        XCTAssertLessThanOrEqual(comment.frame.maxY, app.keyboards.firstMatch.frame.minY, "Player editing stays above the keyboard")
        comment.typeText("\n")
        app.terminate(); app.launch()
        XCTAssertTrue(walk.waitForExistence(timeout: 15))
        XCTAssertTrue(app.buttons["library.group.back"].exists)
        XCTAssertFalse(app.buttons["track.waveform.demo-4"].exists, "Artist selection survives relaunch")
        edgeSwipe(app, through: walk)
        reveal(tycho, in: app.collectionViews["library.groups"])
        XCTAssertFalse(artists.exists, "Inside a group, edge swipe goes back instead of opening the drawer")
        assertDrawerButton(app, at: drawerButtonFrame)
        app.buttons["Show Sidebar"].tap()
        app.buttons["library.drawer.albums"].tap()
        let dive = app.buttons["library.group.Dive"]
        reveal(dive, in: app.collectionViews["library.groups"])
        assertDrawerButton(app, at: drawerButtonFrame)
        capture(app, "Albums use the library theme")
        dive.tap()
        XCTAssertTrue(walk.waitForExistence(timeout: 5))
        capture(app, "Album tracks use the library theme")
        app.buttons["library.group.back"].tap()
        app.buttons["Show Sidebar"].tap()
        app.buttons["library.drawer.tracks"].tap()
        XCTAssertTrue(walk.waitForExistence(timeout: 5))
        capture(app, "All tracks use the library theme")
        reveal(app.buttons["track.waveform.demo-4"], in: app.collectionViews["library.tracks"])
        assertDrawerButton(app, at: drawerButtonFrame)
        app.buttons["Show Sidebar"].tap()
        app.buttons["library.drawer.download"].tap()
        let source = app.textFields["import.source"]
        XCTAssertTrue(source.waitForExistence(timeout: 5))
        app.buttons["import.done"].tap()
        app.buttons["Show Sidebar"].tap()
        app.buttons["library.drawer.playlists"].tap()
        XCTAssertTrue(playlist.waitForExistence(timeout: 5))
        playlist.tap()
        XCTAssertTrue(app.buttons["playlist.back"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["Show Sidebar"].exists)
        edgeSwipe(app, through: walk)
        XCTAssertTrue(playlist.waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["library.drawer.download"].exists)
        assertDrawerButton(app, at: drawerButtonFrame)
    }

    private func assertDrawerButton(_ app: XCUIApplication, at frame: CGRect, label: String = "Show Sidebar") {
        let button = app.buttons[label]
        XCTAssertTrue(button.waitForExistence(timeout: 5))
        XCTAssertTrue(button.isHittable)
        XCTAssertEqual(button.frame.minX, frame.minX, accuracy: 1, "Drawer button stays at the same left inset")
        XCTAssertEqual(button.frame.minY, frame.minY, accuracy: 1, "Drawer button stays at the same top inset")
    }

    private func reveal(_ element: XCUIElement, in list: XCUIElement) {
        XCTAssertTrue(list.waitForExistence(timeout: 5))
        for _ in 0..<8 {
            if element.exists && element.isHittable { break }
            list.swipeUp()
        }
        XCTAssertTrue(element.exists && element.isHittable)
    }

    private func edgeSwipe(_ app: XCUIApplication, through element: XCUIElement) {
        let origin = app.coordinate(withNormalizedOffset: .zero)
        let y = element.frame.midY - app.frame.minY
        origin.withOffset(CGVector(dx: 2, dy: y)).press(forDuration: 0.05,
            thenDragTo: origin.withOffset(CGVector(dx: app.frame.width * 0.75, dy: y)),
            withVelocity: .slow, thenHoldForDuration: 0.2)
    }
    private func capture(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name; attachment.lifetime = .keepAlways
        add(attachment)
    }
}
#endif

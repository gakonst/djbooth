#if os(iOS)
import XCTest
import UIKit

@MainActor
final class LibraryDrawerUITests: XCTestCase {
    override func setUpWithError() throws { continueAfterFailure = false }

    func testDrawerBrowsingAndPasteLinkDownload() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-test-library", UUID().uuidString]
        app.launch()
        let playlist = app.buttons["playlist.row.demo-c2"]
        XCTAssertTrue(playlist.waitForExistence(timeout: 15))
        edgeSwipe(app, through: playlist)
        let artists = app.buttons["library.drawer.artists"]
        XCTAssertTrue(artists.waitForExistence(timeout: 5))
        capture(app, "Library drawer")
        artists.tap()
        let tycho = app.buttons["library.group.Tycho"]
        reveal(tycho, in: app.collectionViews["library.groups"])
        tycho.tap()
        let walk = app.buttons["track.waveform.demo-5"]
        XCTAssertTrue(walk.waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["library.drawer.open"].exists)
        XCTAssertFalse(app.buttons["track.waveform.demo-4"].exists)
        walk.tap()
        XCTAssertTrue(app.buttons["nowPlaying.queue.track.demo-5"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["nowPlaying.queue.track.demo-4"].exists)
        app.terminate(); app.launch()
        XCTAssertTrue(walk.waitForExistence(timeout: 15))
        XCTAssertTrue(app.buttons["library.group.back"].exists)
        XCTAssertFalse(app.buttons["track.waveform.demo-4"].exists, "Artist selection survives relaunch")
        edgeSwipe(app, through: walk)
        reveal(tycho, in: app.collectionViews["library.groups"])
        XCTAssertFalse(artists.exists, "Inside a group, edge swipe goes back instead of opening the drawer")
        app.buttons["library.drawer.open"].tap()
        app.buttons["library.drawer.albums"].tap()
        let dive = app.buttons["library.group.Dive"]
        reveal(dive, in: app.collectionViews["library.groups"])
        dive.tap()
        XCTAssertTrue(walk.waitForExistence(timeout: 5))
        app.buttons["library.group.back"].tap()
        app.buttons["library.drawer.open"].tap()
        app.buttons["library.drawer.tracks"].tap()
        XCTAssertTrue(walk.waitForExistence(timeout: 5))
        reveal(app.buttons["track.waveform.demo-4"], in: app.collectionViews["library.tracks"])
        app.buttons["library.drawer.open"].tap()
        app.buttons["library.drawer.download"].tap()
        let source = app.textFields["import.source"]
        XCTAssertTrue(source.waitForExistence(timeout: 5))
        let link = "https://www.youtube.com/watch?v=0qX8Q8LSjdM"
        UIPasteboard.general.string = link
        let paste = app.buttons["import.paste"]
        XCTAssertTrue(paste.waitForExistence(timeout: 5))
        paste.tap()
        let allowPaste = app.buttons["Allow Paste"]
        if allowPaste.waitForExistence(timeout: 2) { allowPaste.tap() }
        expectation(for: NSPredicate(format: "value == %@", link), evaluatedWith: source)
        waitForExpectations(timeout: 5)
        XCTAssertTrue(app.buttons["import.settings"].exists, "An unconnected phone can connect from Download")
        capture(app, "Pasted Rafael link")
        app.buttons["import.done"].tap()
        app.buttons["library.drawer.open"].tap()
        app.buttons["library.drawer.playlists"].tap()
        XCTAssertTrue(playlist.waitForExistence(timeout: 5))
        playlist.tap()
        XCTAssertTrue(app.buttons["playlist.back"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["library.drawer.open"].exists)
        edgeSwipe(app, through: walk)
        XCTAssertTrue(playlist.waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["library.drawer.download"].exists)
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

#if os(iOS)
import XCTest

@MainActor
final class DJLinkUITests: XCTestCase {
    func testSixDeckMixerRowsAndChannelAssignment() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-test-library", UUID().uuidString, "--ui-test-decks", "--ui-test-six-decks", "--ui-test-player"]
        app.launch()
        XCTAssertTrue(app.buttons["djlink.connection.card"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.buttons["djlink.connection.card"].label.contains("6 decks connected"))
        let high = app.descendants(matching: .any)["djlink.mixer.1.high"].firstMatch
        XCTAssertEqual(high.value as? String, "100 percent")
        XCTAssertEqual(app.descendants(matching: .any)["djlink.mixer.1.low"].firstMatch.value as? String, "0 percent")
        let rows = app.scrollViews["djlink.mixer.rows"]
        rows.swipeUp()
        let six = app.buttons["djlink.deck.6"]
        XCTAssertTrue(six.isHittable)
        XCTAssertEqual(app.descendants(matching: .any)["djlink.mixer.6.high"].firstMatch.value as? String, "Unavailable")
        app.buttons["djlink.channel.6"].tap()
        app.buttons["Channel 1"].tap()
        XCTAssertEqual(app.descendants(matching: .any)["djlink.mixer.6.high"].firstMatch.value as? String, "100 percent")
        six.tap()
        XCTAssertTrue(app.buttons["nowPlaying.source"].label.contains("Player 6"))
        XCTAssertEqual(app.staticTexts["nowPlaying.title"].label, "A Walk")
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "Six decks and mapped A9 mixer channels"
        screenshot.lifetime = .keepAlways
        add(screenshot)
    }

    func testConnectionCardAndDeckFooterFollowTelemetrySelection() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-test-library", UUID().uuidString, "--ui-test-decks", "--ui-test-player"]
        app.launch()
        let card = app.buttons["djlink.connection.card"]
        XCTAssertTrue(card.waitForExistence(timeout: 15))
        let title = app.staticTexts["nowPlaying.title"]
        XCTAssertTrue(title.waitForExistence(timeout: 5))
        XCTAssertEqual(title.label, "Two Thousand and Seventeen")
        XCTAssertEqual(app.staticTexts["nowPlaying.key"].label, "Key")
        XCTAssertEqual(app.staticTexts["nowPlaying.key"].value as? String, "D")
        XCTAssertTrue(app.staticTexts["128.0 BPM"].exists, "Use deck tempo rather than the track's stored 90 BPM")
        XCTAssertEqual(app.staticTexts["nowPlaying.elapsed"].value as? String, "0:45")
        XCTAssertTrue(app.buttons["nowPlaying.play"].exists, "Deck telemetry uses the normal player")
        XCTAssertFalse(app.buttons["nowPlaying.play"].isEnabled, "Local audio controls must not masquerade as deck controls")
        XCTAssertTrue(app.descendants(matching: .any)["nowPlaying.waveform"].firstMatch.exists)
        XCTAssertTrue(app.textFields["nowPlaying.annotation"].exists)
        XCTAssertGreaterThan(title.frame.minY, card.frame.maxY)
        XCTAssertLessThan(title.frame.maxY, app.frame.maxY)
        let selector = app.buttons["nowPlaying.source"]
        selector.tap()
        app.buttons["Player 1"].tap()
        XCTAssertEqual(title.label, "A Walk")
        let waveform = app.descendants(matching: .any)["nowPlaying.waveform"].firstMatch
        let waveformReady = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value CONTAINS %@", "full duration"), object: waveform)
        XCTAssertEqual(XCTWaiter.wait(for: [waveformReady], timeout: 5), .completed)
        selector.tap()
        app.buttons["Follow playing deck"].tap()
        XCTAssertEqual(title.label, "Two Thousand and Seventeen")
        selector.tap()
        app.buttons["iPhone player"].tap()
        XCTAssertEqual(title.label, "A Walk")
        XCTAssertTrue(app.buttons["nowPlaying.play"].isEnabled)
        selector.tap()
        app.buttons["Follow playing deck"].tap()
        XCTAssertEqual(title.label, "Two Thousand and Seventeen")
        XCTAssertFalse(app.sliders["nowPlaying.progress"].isEnabled)
        XCUIDevice.shared.press(.home)
        XCTAssertTrue(app.wait(for: .runningBackground, timeout: 5))
        Thread.sleep(forTimeInterval: 1)
        app.activate()
        XCTAssertTrue(card.waitForExistence(timeout: 5), "A brief background switch should not tear down the session")
        XCTAssertEqual(title.label, "Two Thousand and Seventeen")
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "Connected decks and Now Playing"
        screenshot.lifetime = .keepAlways
        add(screenshot)
        card.tap()
        XCTAssertTrue(app.staticTexts["DJ equipment found"].waitForExistence(timeout: 5))
        app.buttons["Done"].tap()
        XCTAssertTrue(card.waitForExistence(timeout: 5))
    }

    func testConnectionScreenUsesEmbeddedBridgeWithoutAdvertisingPreviewMusic() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-test-library", UUID().uuidString]
        app.launch()
        let sidebar = app.buttons["Show Sidebar"]
        XCTAssertTrue(sidebar.waitForExistence(timeout: 15))
        sidebar.tap()
        let connectRow = app.buttons["library.drawer.djlink"]
        XCTAssertTrue(connectRow.waitForExistence(timeout: 5))
        connectRow.tap()
        XCTAssertTrue(app.staticTexts["Play from your iPhone"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Waiting for a CDJ"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["djlink.connect"].exists, "Cable detection owns connection")
        XCTAssertFalse(app.staticTexts["djlink.status"].exists, "Demo audio must never be advertised to hardware")
        XCTAssertFalse(app.staticTexts["djlink.error"].exists, "The installed Rust API must match the generated Swift bindings")
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "iPhone DJ Link connection"
        screenshot.lifetime = .keepAlways
        add(screenshot)
        app.buttons["Done"].tap()
        XCTAssertTrue(sidebar.waitForExistence(timeout: 5))
    }
}
#endif

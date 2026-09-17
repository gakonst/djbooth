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
        let rows = app.scrollViews["nowPlaying.players"]
        let six = app.buttons["djlink.deck.6"]
        for _ in 0..<10 where !six.isHittable { rows.swipeUp() }
        XCTAssertTrue(six.isHittable)
        XCTAssertEqual(app.descendants(matching: .any)["djlink.mixer.6.high"].firstMatch.value as? String, "Unavailable")
        app.buttons["djlink.channel.6"].tap()
        app.buttons["Channel 1"].tap()
        XCTAssertEqual(app.descendants(matching: .any)["djlink.mixer.6.high"].firstMatch.value as? String, "100 percent")
        six.tap()
        let player = app.descendants(matching: .any)["nowPlaying.deck.6"].firstMatch
        XCTAssertTrue(player.buttons["djlink.deck.select.6"].exists)
        XCTAssertEqual(player.staticTexts["nowPlaying.title"].label, "A Walk")
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "Six decks and mapped A9 mixer channels"
        screenshot.lifetime = .keepAlways
        add(screenshot)
    }

    func testConnectedDecksReuseTheNormalBottomPlayer() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-test-library", UUID().uuidString, "--ui-test-decks", "--ui-test-player"]
        app.launch()
        let card = app.buttons["djlink.connection.card"]
        XCTAssertTrue(card.waitForExistence(timeout: 15))
        let dock = app.descendants(matching: .any)["nowPlaying.dock"].firstMatch
        XCTAssertTrue(dock.waitForExistence(timeout: 5))
        XCTAssertGreaterThan(dock.frame.minY, card.frame.maxY)
        XCTAssertLessThan(card.frame.height, 110, "Top notice must not contain players or EQs")
        let rows = app.scrollViews["nowPlaying.players"]
        let one = app.descendants(matching: .any)["nowPlaying.deck.1"].firstMatch
        XCTAssertEqual(one.staticTexts["nowPlaying.title"].label, "A Walk")
        XCTAssertTrue(one.textFields["nowPlaying.annotation"].exists)
        XCTAssertFalse(one.buttons["nowPlaying.play"].isEnabled)
        let two = app.descendants(matching: .any)["nowPlaying.deck.2"].firstMatch
        for _ in 0..<3 where !two.buttons["djlink.deck.select.2"].isHittable { rows.swipeUp() }
        XCTAssertEqual(two.staticTexts["nowPlaying.title"].label, "Two Thousand and Seventeen")
        XCTAssertEqual(two.staticTexts["nowPlaying.key"].value as? String, "D")
        XCTAssertEqual(two.staticTexts["nowPlaying.elapsed"].value as? String, "0:45")
        XCTAssertTrue(two.staticTexts["128.0 BPM"].exists)
        XCTAssertTrue(two.descendants(matching: .any)["nowPlaying.waveform"].firstMatch.exists)
        XCTAssertFalse(two.sliders["nowPlaying.progress"].isEnabled)
        XCTAssertTrue(app.descendants(matching: .any)["djlink.mixer.2.high"].firstMatch.exists)
        app.buttons["nowPlaying.phone.toggle"].tap()
        let phone = app.descendants(matching: .any)["nowPlaying.bottom"].firstMatch
        for _ in 0..<4 where !phone.buttons["nowPlaying.play"].isHittable { rows.swipeDown() }
        XCTAssertTrue(phone.buttons["nowPlaying.play"].isEnabled)
        XCTAssertEqual(phone.staticTexts["nowPlaying.title"].label, "A Walk")
        app.buttons["nowPlaying.phone.toggle"].tap()
        XCUIDevice.shared.press(.home)
        XCTAssertTrue(app.wait(for: .runningBackground, timeout: 5))
        app.activate()
        XCTAssertTrue(dock.waitForExistence(timeout: 5))
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "Existing bottom players with connected decks and mixer"
        screenshot.lifetime = .keepAlways
        add(screenshot)
        card.tap()
        XCTAssertTrue(app.staticTexts["DJ equipment found"].waitForExistence(timeout: 5))
        app.buttons["Done"].tap()
        XCTAssertTrue(card.waitForExistence(timeout: 5))
    }

    func testTimelineRecordingDoesNotRequireUSBAudioByDefault() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-test-library", UUID().uuidString, "--ui-test-decks"]
        app.launch()
        XCTAssertTrue(app.buttons["recording.open"].waitForExistence(timeout: 15))
        app.buttons["recording.open"].tap()
        XCTAssertTrue(app.buttons["recording.toggle"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.buttons["recording.toggle"].label, "Record deck timeline")
        let audio = app.switches["recording.audio"]
        XCTAssertEqual(audio.value as? String, "0")
        audio.tap()
        XCTAssertEqual(app.buttons["recording.toggle"].label, "Record audio + timeline")
    }

    func testDeckNeverFallsBackToCloudOverview() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-test-library", UUID().uuidString, "--ui-test-decks", "--ui-test-player", "--ui-test-missing-deck-waveform"]
        app.launch()
        let one = app.descendants(matching: .any)["nowPlaying.deck.1"].firstMatch
        XCTAssertTrue(one.waitForExistence(timeout: 15))
        let waveform = one.descendants(matching: .any)["nowPlaying.waveform"].firstMatch
        XCTAssertEqual(waveform.value as? String, "Analysis unavailable")
        app.buttons["nowPlaying.phone.toggle"].tap()
        let phone = app.descendants(matching: .any)["nowPlaying.bottom"].firstMatch
        let phoneWaveform = phone.descendants(matching: .any)["nowPlaying.waveform"].firstMatch
        let ready = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value CONTAINS %@", "full duration"), object: phoneWaveform)
        XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: 5), .completed)
        app.buttons["nowPlaying.phone.toggle"].tap()
        XCTAssertEqual(waveform.value as? String, "Analysis unavailable")
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

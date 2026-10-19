#if os(iOS)
import XCTest

@MainActor
final class DJLinkUITests: XCTestCase {
    func testAgentTakesOverLibraryAndRestoresDraft() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-test-library", UUID().uuidString, "--ui-test-player"]
        app.launch()
        let agent = app.buttons["library.agent"]
        XCTAssertTrue(agent.waitForExistence(timeout: 20))
        agent.tap()
        let input = app.descendants(matching: .any)["agent.input"].firstMatch
        XCTAssertTrue(input.waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["library.drawer.open"].exists)
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "Booth companion"; screenshot.lifetime = .keepAlways; add(screenshot)
        input.tap(); input.typeText("Build a warm-up set")
        app.buttons["agent.done"].tap()
        XCTAssertTrue(agent.waitForExistence(timeout: 5))
        agent.tap()
        XCTAssertEqual(input.value as? String, "Build a warm-up set")
        app.buttons["agent.done"].tap()
        app.terminate(); app.launch()
        XCTAssertTrue(agent.waitForExistence(timeout: 20)); agent.tap()
        XCTAssertTrue(input.waitForExistence(timeout: 5))
        XCTAssertEqual(input.value as? String, "Build a warm-up set")
    }

    func testSonosSidebarKeepsVolumeLimitAcrossRelaunch() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-test-library", UUID().uuidString, "--ui-test-player"]
        app.launch()
        let drawer = app.buttons["library.drawer.open"]
        XCTAssertTrue(drawer.waitForExistence(timeout: 20))
        XCTAssertFalse(app.buttons["nowPlaying.sonos"].exists)
        drawer.tap()
        XCTAssertTrue(app.switches["library.sonos.toggle"].waitForExistence(timeout: 5))
        app.buttons["library.sonos.settings"].tap()
        let limit = app.sliders["sonos.limit.master"]
        XCTAssertTrue(limit.waitForExistence(timeout: 5))
        let initial = limit.value as? String
        limit.adjust(toNormalizedSliderPosition: 0.2)
        let changed = NSPredicate { _, _ in (limit.value as? String) != initial }
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: changed, object: limit)], timeout: 5), .completed)
        let saved = limit.value as? String
        app.buttons["Done"].tap()
        app.terminate(); app.launch()
        XCTAssertTrue(drawer.waitForExistence(timeout: 20)); drawer.tap()
        app.buttons["library.sonos.settings"].tap()
        XCTAssertTrue(limit.waitForExistence(timeout: 5))
        XCTAssertEqual(limit.value as? String, saved, "The maximum volume is a persistent device preference")
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "Sonos room volume limits"; screenshot.lifetime = .keepAlways; add(screenshot)
    }

    func testSonosHardwareVolumeButtons() throws {
        #if targetEnvironment(simulator)
        throw XCTSkip("Volume buttons require a paired physical iPhone")
        #else
        guard ProcessInfo.processInfo.environment["DJBOOTH_SONOS_HARDWARE"] == "1" else {
            throw XCTSkip("Explicit opt-in required for a real Sonos room")
        }
        let app = XCUIApplication()
        app.launchArguments = ["--dj-link-hardware-test"]
        app.launch()
        let drawer = app.buttons["library.drawer.open"]
        XCTAssertTrue(drawer.waitForExistence(timeout: 20)); drawer.tap()
        app.buttons["library.sonos.settings"].tap()
        let slider = app.sliders["All rooms volume"]
        XCTAssertTrue(slider.waitForExistence(timeout: 5))
        let ready = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value BEGINSWITH %@", "20"), object: slider)
        XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: 10), .completed)
        let initial = slider.value as? String
        XCUIDevice.shared.press(.volumeDown)
        let changed = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in slider.value as? String != initial }, object: nil)
        let lowered = XCTWaiter.wait(for: [changed], timeout: 4) == .completed
        if lowered {
            XCUIDevice.shared.press(.volumeUp)
        } else {
            XCUIDevice.shared.press(.volumeUp)
            let raised = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in slider.value as? String != initial }, object: nil)
            XCTAssertEqual(XCTWaiter.wait(for: [raised], timeout: 5), .completed)
            XCUIDevice.shared.press(.volumeDown)
        }
        slider.adjust(toNormalizedSliderPosition: 0.2)
        app.buttons["Done"].tap()
        #endif
    }

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
        guard scrollToVisible(six, in: rows, app: app) else { return }
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
        XCTAssertFalse(one.descendants(matching: .any)["nowPlaying.output.picker"].exists, "A CDJ status player has no phone audio to route")
        let two = app.descendants(matching: .any)["nowPlaying.deck.2"].firstMatch
        for _ in 0..<3 where !two.buttons["djlink.deck.select.2"].isHittable { rows.swipeUp() }
        XCTAssertEqual(two.staticTexts["nowPlaying.title"].label, "Two Thousand and Seventeen")
        XCTAssertEqual(two.staticTexts["nowPlaying.key"].value as? String, "D")
        // The fixture reports 45s once. Render frames advance independently,
        // then stop after one second without a new observation.
        XCTAssertEqual(two.staticTexts["nowPlaying.elapsed"].value as? String, "0:46")
        XCTAssertEqual(two.sliders["nowPlaying.progress"].value as? String, "0:46 of 4:00")
        XCTAssertTrue(two.staticTexts["128.0 BPM"].exists)
        XCTAssertTrue(two.descendants(matching: .any)["nowPlaying.waveform"].firstMatch.exists)
        XCTAssertFalse(two.sliders["nowPlaying.progress"].isEnabled)
        XCTAssertTrue(app.descendants(matching: .any)["djlink.mixer.2.high"].firstMatch.exists)
        app.buttons["nowPlaying.phone.toggle"].tap()
        let phone = app.descendants(matching: .any)["nowPlaying.bottom"].firstMatch
        for _ in 0..<4 where !phone.buttons["nowPlaying.play"].isHittable { rows.swipeDown() }
        XCTAssertTrue(phone.buttons["nowPlaying.play"].isEnabled)
        XCTAssertEqual(phone.staticTexts["nowPlaying.title"].label, "A Walk")
        XCTAssertFalse(phone.descendants(matching: .any)["nowPlaying.output.picker"].exists, "Output routing belongs in the sidebar")
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

    func testOmnisApplianceShowsBothDecksWithoutA9Mixer() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-test-library", UUID().uuidString, "--ui-test-decks", "--ui-test-omnis", "--ui-test-player"]
        app.launch()
        let card = app.buttons["djlink.connection.card"]
        XCTAssertTrue(card.waitForExistence(timeout: 15))
        XCTAssertTrue(card.label.contains("2 decks connected"))
        XCTAssertTrue(card.label.contains("OMNIS-DUO"))
        let one = app.descendants(matching: .any)["nowPlaying.deck.11"].firstMatch
        let two = app.descendants(matching: .any)["nowPlaying.deck.12"].firstMatch
        XCTAssertEqual(one.staticTexts["nowPlaying.title"].label, "A Walk")
        XCTAssertEqual(two.staticTexts["nowPlaying.title"].label, "Two Thousand and Seventeen")
        XCTAssertEqual(one.buttons["djlink.deck.select.11"].label, "OMNIS · Deck 1")
        XCTAssertEqual(two.buttons["djlink.deck.select.12"].label, "OMNIS · Deck 2")
        XCTAssertFalse(app.buttons["djlink.mixer.toggle"].exists)
        XCTAssertFalse(app.descendants(matching: .any)["djlink.mixer.11.high"].firstMatch.exists)
        XCTAssertFalse(app.staticTexts["Waiting for mixer data"].exists)
        XCTAssertTrue(one.buttons["djlink.deck.select.11"].isHittable)
        one.buttons["djlink.deck.select.11"].tap()
        XCTAssertTrue(app.buttons["nowPlaying.source.12"].waitForExistence(timeout: 5))
        capture(app, "OMNIS player dropdown with switching and separate load action")
        app.buttons["nowPlaying.source.12"].tap()
        guard awaitState(NSPredicate(format: "hittable == true"), of: two.buttons["djlink.deck.select.12"],
                         app: app, name: "Dropdown switches to Deck 2") else { return }
        two.buttons["djlink.deck.select.12"].tap()
        app.buttons["nowPlaying.source.phone"].tap()
        let phoneSelector = app.buttons["nowPlaying.source"]
        guard awaitState(NSPredicate(format: "hittable == true"), of: phoneSelector,
                         app: app, name: "Dropdown switches to iPhone") else { return }
        capture(app, "iPhone player selected from OMNIS dropdown")
        phoneSelector.tap()
        app.buttons["nowPlaying.source.11"].tap()
        guard awaitState(NSPredicate(format: "hittable == true"), of: one.buttons["djlink.deck.select.11"],
                         app: app, name: "Dropdown returns to Deck 1") else { return }
        for _ in 0..<3 {
            for (selector, choice, destination) in [
                (one.buttons["djlink.deck.select.11"], "nowPlaying.source.12", two.buttons["djlink.deck.select.12"]),
                (two.buttons["djlink.deck.select.12"], "nowPlaying.source.phone", phoneSelector),
                (phoneSelector, "nowPlaying.source.11", one.buttons["djlink.deck.select.11"])
            ] {
                XCTAssertGreaterThanOrEqual(selector.frame.height, 44, "Player selectors need a full finger-sized target")
                selector.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.85)).tap()
                guard awaitState(NSPredicate(format: "hittable == true"), of: app.buttons[choice],
                                 app: app, name: "Player menu opens on first tap") else { return }
                app.buttons[choice].tap()
                guard awaitState(NSPredicate(format: "hittable == true"), of: destination,
                                 app: app, name: "Repeated player selection") else { return }
            }
        }
        one.buttons["djlink.deck.select.11"].tap()
        app.buttons["djlink.deck.load.11"].tap()
        XCTAssertTrue(app.buttons["djlink.load.done"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.navigationBars["Load · OMNIS · Deck 1"].exists)
        XCTAssertTrue(app.staticTexts["No downloaded tracks. Use Keep on this device in your library first."].exists)
        XCTAssertFalse(app.staticTexts["djlink.load.playing"].exists)
        capture(app, "OMNIS Deck 1 load picker without downloads")
        app.buttons["djlink.load.done"].tap()
        capture(app, "OMNIS Deck 1 fixture")
        let rows = app.scrollViews["nowPlaying.players"]
        guard scrollToVisible(two.staticTexts["nowPlaying.duration"], in: rows, app: app) else { return }
        XCTAssertTrue(two.buttons["djlink.deck.select.12"].isHittable)
        XCTAssertTrue(two.staticTexts["nowPlaying.title"].isHittable)
        two.buttons["djlink.deck.select.12"].tap()
        app.buttons["djlink.deck.load.12"].tap()
        XCTAssertTrue(app.buttons["djlink.load.done"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.navigationBars["Load · OMNIS · Deck 2"].exists)
        XCTAssertTrue(app.staticTexts["djlink.load.playing"].exists)
        capture(app, "OMNIS Deck 2 load picker protects playing deck")
        app.buttons["djlink.load.done"].tap()
        XCTAssertFalse(app.descendants(matching: .any)["djlink.mixer.12.high"].firstMatch.exists)
        capture(app, "OMNIS Deck 2 fixture")

        // A library selection is phone playback, even when the dock is scrolled
        // to an external deck. Its transport must become visible without a toggle.
        app.buttons["library.drawer.open"].tap()
        let allTracks = app.buttons["library.drawer.tracks"]
        XCTAssertTrue(allTracks.waitForExistence(timeout: 5))
        allTracks.tap()
        let libraryTrack = app.buttons["track.waveform.demo-2"]
        XCTAssertTrue(libraryTrack.waitForExistence(timeout: 5))
        libraryTrack.tap()
        let phone = app.descendants(matching: .any)["nowPlaying.bottom"].firstMatch
        XCTAssertTrue(phone.waitForExistence(timeout: 5))
        XCTAssertEqual(phone.staticTexts["nowPlaying.title"].label, "Glue")
        XCTAssertTrue(phone.buttons["nowPlaying.play"].isEnabled)
        guard awaitState(NSPredicate(format: "hittable == true"), of: phone.buttons["nowPlaying.play"],
                         app: app, name: "Library selection exposes phone transport") else { return }
        capture(app, "Phone playback controls after library selection with OMNIS connected")
        let options = app.buttons["track.options.demo-2"]
        XCTAssertTrue(options.waitForExistence(timeout: 5))
        options.tap()
        XCTAssertTrue(app.buttons["track.load.11"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["track.load.11"].label.contains("Deck 1"))
        XCTAssertTrue(app.buttons["track.load.12"].label.contains("Deck 2"))
        XCTAssertFalse(app.buttons["track.load.11"].isEnabled, "Undownloaded songs cannot be sent to decks")
        XCTAssertFalse(app.buttons["track.load.12"].isEnabled, "A playing deck cannot be replaced")
        capture(app, "Track menu with explicit deck load actions")
    }

    func testDeckLoadPickerDoesNotStartPhonePlayback() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-test-library", UUID().uuidString, "--ui-test-decks", "--ui-test-omnis", "--ui-test-player", "--ui-test-deck-downloads"]
        app.launch()
        let one = app.buttons["djlink.deck.select.11"]
        XCTAssertTrue(one.waitForExistence(timeout: 15))
        one.tap()
        app.buttons["djlink.deck.load.11"].tap()
        let track = app.buttons["djlink.load.track.demo-2"]
        XCTAssertTrue(track.waitForExistence(timeout: 5))
        XCTAssertTrue(track.isEnabled)
        XCTAssertTrue(track.label.contains("Deck 1"))
        capture(app, "OMNIS Deck 1 downloaded track picker")
        track.tap()
        XCTAssertTrue(app.staticTexts["Demo decks cannot receive music. Connect your OMNIS to load a track."].waitForExistence(timeout: 5))
        app.buttons["djlink.load.done"].tap()
        let rows = app.scrollViews["nowPlaying.players"]
        let two = app.buttons["djlink.deck.select.12"]
        guard scrollToVisible(two, in: rows, app: app) else { return }
        two.tap()
        app.buttons["djlink.deck.load.12"].tap()
        XCTAssertTrue(track.waitForExistence(timeout: 5))
        XCTAssertFalse(track.isEnabled, "The same downloaded song must not replace a playing deck")
        XCTAssertTrue(track.label.contains("Deck 2"))
        capture(app, "OMNIS Deck 2 downloaded track picker while playing")
        app.buttons["djlink.load.done"].tap()
        app.buttons["nowPlaying.phone.toggle"].tap()
        let phone = app.descendants(matching: .any)["nowPlaying.bottom"].firstMatch
        guard scrollToVisible(phone.buttons["nowPlaying.play"], in: rows, app: app) else { return }
        XCTAssertEqual(phone.staticTexts["nowPlaying.title"].label, "A Walk", "Loading Glue must not select it in the phone player")
        XCTAssertEqual(phone.buttons["nowPlaying.play"].label, "Play", "A deck load must not start phone audio")
        app.buttons["library.drawer.open"].tap()
        app.buttons["library.drawer.tracks"].tap()
        let options = app.buttons["track.options.demo-2"]
        XCTAssertTrue(options.waitForExistence(timeout: 5))
        options.tap()
        let saved = app.buttons["track.download.demo-2"]
        XCTAssertTrue(saved.waitForExistence(timeout: 5))
        XCTAssertEqual(saved.label, "On this device")
        XCTAssertFalse(saved.isEnabled, "Downloaded tracks must not flash a redundant download action")
        XCTAssertTrue(app.buttons["track.load.11"].isEnabled, "Downloaded track can load onto the paused deck")
        XCTAssertFalse(app.buttons["track.load.12"].isEnabled)
        XCTAssertTrue(app.buttons["track.load.12"].label.contains("pause first"), "Explain the playing-deck protection")
        capture(app, "Downloaded track menu explains playing deck protection")
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
        XCTAssertTrue(audio.isEnabled)
        XCTAssertTrue(audio.isHittable)
        capture(app, "Timeline recording without USB audio")
        // The iOS 27 switch accessibility frame includes its label. Hit the
        // visible trailing control rather than the noninteractive row center.
        audio.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5)).tap()
        guard awaitState(NSPredicate(format: "value == %@", "1"), of: audio, app: app,
                         name: "Recording audio switch on") else { return }
        guard awaitState(NSPredicate(format: "label == %@", "Record audio + timeline"),
                         of: app.buttons["recording.toggle"], app: app, name: "Recording audio label") else { return }
        capture(app, "Audio and timeline recording selected")
        audio.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5)).tap()
        guard awaitState(NSPredicate(format: "value == %@", "0"), of: audio, app: app,
                         name: "Recording audio switch off") else { return }
        guard awaitState(NSPredicate(format: "label == %@", "Record deck timeline"),
                         of: app.buttons["recording.toggle"], app: app, name: "Recording timeline label restored") else { return }
        capture(app, "Timeline recording restored")
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
        XCTAssertTrue(app.staticTexts["Waiting for a deck"].waitForExistence(timeout: 5))
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

    func testPlayerSelectionDoesNotDependOnDeckTelemetry() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-test-library", UUID().uuidString, "--ui-test-decks", "--ui-test-omnis",
                               "--ui-test-player", "--ui-test-missing-deck-status"]
        app.launch()
        let one = app.buttons["djlink.deck.select.11"]
        let two = app.buttons["djlink.deck.select.12"]
        XCTAssertTrue(one.waitForExistence(timeout: 15))
        one.tap()
        app.buttons["nowPlaying.source.12"].tap()
        guard awaitState(NSPredicate(format: "hittable == true"), of: two,
                         app: app, name: "Select discovered deck before telemetry arrives") else { return }
        let player = app.descendants(matching: .any)["nowPlaying.deck.12"].firstMatch
        XCTAssertTrue(player.staticTexts["Waiting for deck status"].isHittable)
        XCTAssertFalse(player.buttons["nowPlaying.play"].isEnabled)
        capture(app, "Deck 2 selected while waiting for telemetry")
        two.tap()
        app.buttons["nowPlaying.source.phone"].tap()
        let phone = app.buttons["nowPlaying.source"]
        guard awaitState(NSPredicate(format: "hittable == true"), of: phone,
                         app: app, name: "Select iPhone from waiting deck") else { return }
        phone.tap()
        app.buttons["nowPlaying.source.12"].tap()
        guard awaitState(NSPredicate(format: "hittable == true"), of: two,
                         app: app, name: "Return to waiting deck from iPhone") else { return }
    }

    private func scrollToVisible(_ target: XCUIElement, in scroll: XCUIElement, app: XCUIApplication,
                                 file: StaticString = #filePath, line: UInt = #line) -> Bool {
        var frames: [String] = []
        for attempt in 0..<10 {
            frames.append("Drag \(attempt): viewport=\(scroll.frame), target=\(target.frame), hittable=\(target.isHittable)")
            if target.isHittable { return true }
            // Stay inside the visible viewport instead of XCTest's default swipe path.
            let start = scroll.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.85))
            let end = scroll.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.15))
            start.press(forDuration: 0.05, thenDragTo: end)
            let visible = XCTNSPredicateExpectation(predicate: NSPredicate(format: "hittable == true"), object: target)
            if XCTWaiter.wait(for: [visible], timeout: 1) == .completed { return true }
        }
        capture(app, "Scroll reachability failure")
        let evidence = XCTAttachment(string: frames.joined(separator: "\n") + "\nFinal target=\(target.frame)\n" + app.debugDescription)
        evidence.name = "Scroll frames and accessibility"; evidence.lifetime = .keepAlways; add(evidence)
        XCTAssertTrue(target.isHittable, "Target must be reachable by vertical dragging", file: file, line: line)
        return false
    }

    private func awaitState(_ predicate: NSPredicate, of element: XCUIElement, app: XCUIApplication,
                            name: String, file: StaticString = #filePath, line: UInt = #line) -> Bool {
        let result = XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: predicate, object: element)], timeout: 5)
        if result != .completed {
            capture(app, name + " failure")
            print("\(name): target=\(element.frame)\n\(app.debugDescription)")
            let evidence = XCTAttachment(string: app.debugDescription)
            evidence.name = name + " accessibility"; evidence.lifetime = .keepAlways; add(evidence)
        }
        XCTAssertEqual(result, .completed, name, file: file, line: line)
        return result == .completed
    }

    private func capture(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
    }
}
#endif

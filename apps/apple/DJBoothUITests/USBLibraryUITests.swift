import XCTest

#if os(iOS)
/// Run with pnpm native:test:usb. The CLI generates real Device Libraries from
/// the existing fake master.db fixture; only the system picker is substituted.
@MainActor
final class USBLibraryUITests: XCTestCase {
    private var temporaryRoots: [URL] = []

    override func setUpWithError() throws { continueAfterFailure = false }
    override func tearDownWithError() throws {
        XCUIApplication().terminate()
        for root in temporaryRoots { try? FileManager.default.removeItem(at: root) }
        temporaryRoots = []
    }

    private func fixture(_ name: String) throws -> URL {
        guard let root = ProcessInfo.processInfo.environment["DJBOOTH_TEST_USB_ROOT"] else {
            throw XCTSkip("Generate simulated USB sticks with pnpm native:test:usb")
        }
        return URL(fileURLWithPath: root).appendingPathComponent(name, isDirectory: true)
    }

    private func copyUSB(_ name: String) throws -> URL {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("USB-test-\(UUID().uuidString)")
        try FileManager.default.copyItem(at: fixture(name), to: root)
        temporaryRoots.append(root)
        return root
    }

    private func open(_ root: URL) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-test-library", UUID().uuidString, "--ui-test-muted"]
        app.launchEnvironment["DJBOOTH_TEST_USB_ROOT"] = root.path
        app.launch()
        XCTAssertTrue(app.buttons["usb.open"].waitForExistence(timeout: 20))
        app.buttons["usb.open"].tap()
        XCTAssertTrue(app.buttons["usb.chooseFolder"].waitForExistence(timeout: 5))
        app.buttons["usb.chooseFolder"].tap()
        return app
    }

    private func playlist(_ name: String, in app: XCUIApplication) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'playlist.row.usb:'"))
            .containing(.staticText, identifier: name).firstMatch
    }

    private func openPlaylist(_ name: String, in app: XCUIApplication) {
        let row = playlist(name, in: app)
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        row.tap()
    }

    private func expectError(_ text: String, in app: XCUIApplication) {
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", text))
            .firstMatch.waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["usb.chooseFolder"].exists)
        XCTAssertFalse(app.buttons["usb.allTracks"].exists)
    }

    private func capture(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func enterFolder(_ name: String, in app: XCUIApplication) {
        let button = app.buttons["playlist.folder.\(name)"]
        XCTAssertTrue(button.waitForExistence(timeout: 15)); button.tap()
    }
    private func tracks(_ app: XCUIApplication) -> XCUIElementQuery {
        app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'track.waveform.usb:'"))
    }
    private func expectOrder(_ titles: [String], in app: XCUIApplication) {
        for (position, title) in titles.enumerated() {
            XCTAssertTrue(tracks(app).element(boundBy: position).waitForExistence(timeout: 10))
            XCTAssertEqual(tracks(app).element(boundBy: position).label, "Play \(title)")
        }
    }
    private func returnToRoot(_ app: XCUIApplication) {
        if app.buttons["playlist.back"].exists { app.buttons["playlist.back"].tap() }
        for _ in 0..<5 {
            if app.buttons["usb.open"].exists { return }
            if app.buttons["playlist.folder.back"].waitForExistence(timeout: 3) { app.buttons["playlist.folder.back"].tap() }
        }
        XCTFail("Could not return to playlist root")
    }
    private func waitForValue(_ value: String, _ element: XCUIElement, timeout: Double = 15) {
        let expectation = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", value), object: element)
        XCTAssertEqual(XCTWaiter.wait(for: [expectation], timeout: timeout), .completed)
    }

    func testReadsExportedMetadataAndOriginalPlaylistOrder() throws {
        let app = open(try fixture("InitialUSB"))
        enterFolder("Gigs", in: app)
        openPlaylist("Tonight", in: app)
        expectOrder(["Second", "First"], in: app)
        for suffix in ["track.key.", "track.bpm.", "track.note."] {
            XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "identifier BEGINSWITH %@", suffix + "usb:")).firstMatch.exists)
        }
        XCTAssertTrue(app.staticTexts["comment"].exists)
        capture(app, "USB tracks in the ordinary library")
    }

    func testAutomaticallyReadsRenamedAndReorderedPlaylistFromSameUSBFolder() throws {
        let root = try copyUSB("InitialUSB")
        let app = open(root)
        enterFolder("Gigs", in: app)
        XCTAssertTrue(playlist("Tonight", in: app).waitForExistence(timeout: 5))
        let database = root.appendingPathComponent("PIONEER/rekordbox/export.pdb")
        try Data(contentsOf: fixture("UpdatedUSB").appendingPathComponent("PIONEER/rekordbox/export.pdb")).write(to: database)
        openPlaylist("Afterhours", in: app)
        expectOrder(["First", "Second"], in: app)
        XCTAssertFalse(app.buttons["usb.chooseFolder"].exists)
        capture(app, "USB refresh preserves browsing context")
    }

    func testCLIImportsCDJHistoryAndExportsItAsADatedPlaylist() throws {
        let played = open(try fixture("PlayedUSB"))
        enterFolder("CDJ histories", in: played)
        let history = played.buttons.matching(NSPredicate(format: "identifier CONTAINS ':history:'")).firstMatch
        XCTAssertTrue(history.waitForExistence(timeout: 10)); history.tap()
        expectOrder(["Second", "First", "Second"], in: played)
        capture(played, "Repeated CDJ history tracks in normal playlist")
        played.terminate()
        let synced = open(try fixture("HistoryUSB"))
        let imported = synced.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'playlist.row.usb:' AND label CONTAINS 'DJ Set '")).firstMatch
        XCTAssertTrue(imported.waitForExistence(timeout: 15)); imported.tap()
        expectOrder(["Second", "First", "Second"], in: synced)
        capture(synced, "CLI imported history exported back to USB")
    }

    func testLiveUSBPlaybackAnnotationsAndAutomaticReconnectSurviveRelaunch() throws {
        let root = try copyUSB("PlaybackUSB")
        let app = open(root)
        enterFolder("Gigs", in: app); openPlaylist("Tonight", in: app)
        let play = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'track.waveform.usb:'")).firstMatch
        XCTAssertTrue(play.waitForExistence(timeout: 10)); play.tap()
        let pause = app.buttons["nowPlaying.play"]
        let playing = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label == 'Pause'"), object: pause)
        XCTAssertEqual(XCTWaiter.wait(for: [playing], timeout: 20), .completed)
        XCTAssertTrue(app.descendants(matching: .any)["nowPlaying.title"].firstMatch.label.contains("Second"))
        let elapsed = app.staticTexts["nowPlaying.elapsed"].firstMatch
        let time = elapsed.exists ? elapsed : app.descendants(matching: .any)["nowPlaying.progress"].firstMatch
        XCTAssertTrue(time.waitForExistence(timeout: 5))
        let initial = time.value as? String
        let progressing = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in (time.value as? String) != initial }, object: time)
        XCTAssertEqual(XCTWaiter.wait(for: [progressing], timeout: 8), .completed)
        pause.tap()
        let progress = app.descendants(matching: .any)["nowPlaying.progress"].firstMatch
        XCTAssertTrue(progress.exists)
        if progress.elementType == .slider { progress.adjust(toNormalizedSliderPosition: 0.5) }
        else { progress.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap() }
        let sought = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            (time.value as? String)?.hasPrefix("0:17") == true || (time.value as? String)?.hasPrefix("0:18") == true
        }, object: time)
        XCTAssertEqual(XCTWaiter.wait(for: [sought], timeout: 8), .completed)
        // Queue navigation also exercises the MP3 fixture through the real player.
        let queued = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'nowPlaying.queue.track.usb:'"))
        let first = queued.matching(NSPredicate(format: "label == 'Play First'")).firstMatch
        XCTAssertTrue(first.exists); first.tap()
        let mp3Playing = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label == 'Pause'"), object: pause)
        XCTAssertEqual(XCTWaiter.wait(for: [mp3Playing], timeout: 15), .completed)
        XCTAssertTrue(app.descendants(matching: .any)["nowPlaying.title"].firstMatch.label.contains("First"))
        queued.matching(NSPredicate(format: "label == 'Play Second'")).firstMatch.tap()
        let flacPlaying = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label == 'Pause'"), object: pause)
        XCTAssertEqual(XCTWaiter.wait(for: [flacPlaying], timeout: 15), .completed)
        pause.tap()
        app.buttons["nowPlaying.color"].tap()
        XCTAssertTrue(app.buttons["track.color.red"].waitForExistence(timeout: 5)); app.buttons["track.color.red"].tap()
        let note = app.textFields["nowPlaying.annotation"]
        XCTAssertTrue(note.waitForExistence(timeout: 5)); note.tap(); note.typeText("USB sunrise\n")
        capture(app, "Real USB playback with ordinary annotations")
        returnToRoot(app)
        waitForValue("Connected", app.buttons["usb.open"])
        XCTAssertTrue(app.buttons["usb.open"].label.contains(root.lastPathComponent))
        XCTAssertFalse(app.buttons["playlist.folder.USB · \(root.lastPathComponent)"].exists)
        let pioneer = root.appendingPathComponent("PIONEER"), audio = root.appendingPathComponent("Contents")
        try FileManager.default.moveItem(at: pioneer, to: root.appendingPathComponent("ejected-PIONEER"))
        try FileManager.default.moveItem(at: audio, to: root.appendingPathComponent("ejected-Contents"))
        XCTAssertTrue(app.buttons["usb.open"].waitForNonExistence(timeout: 15))
        app.terminate(); app.launch()
        XCTAssertTrue(app.buttons["nowPlaying.play"].waitForExistence(timeout: 20))
        XCTAssertFalse(app.buttons["usb.open"].exists)
        XCTAssertTrue(app.descendants(matching: .any)["nowPlaying.title"].firstMatch.label.contains("No track selected"))
        XCTAssertEqual(app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'nowPlaying.queue.track.usb:'")).count, 0)
        try FileManager.default.moveItem(at: root.appendingPathComponent("ejected-PIONEER"), to: pioneer)
        try FileManager.default.moveItem(at: root.appendingPathComponent("ejected-Contents"), to: audio)
        waitForValue("Connected", app.buttons["usb.open"])
        XCTAssertFalse(app.buttons["usb.chooseFolder"].exists)
        app.buttons["usb.open"].tap()
        enterFolder("Gigs", in: app); openPlaylist("Tonight", in: app)
        expectOrder(["Second", "First"], in: app)
        tracks(app).element(boundBy: 0).tap()
        let reconnectedPlaying = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label == 'Pause'"), object: app.buttons["nowPlaying.play"])
        XCTAssertEqual(XCTWaiter.wait(for: [reconnectedPlaying], timeout: 15), .completed)
        app.buttons["nowPlaying.play"].tap()
        XCTAssertEqual(app.textFields["nowPlaying.annotation"].value as? String, "USB sunrise")
        XCTAssertEqual(app.buttons["nowPlaying.color"].value as? String, "Red")
        capture(app, "Live USB reconnects with saved annotations")
    }

    func testUnplugRemovesUSBFromAllTracksArtistsAndAlbums() throws {
        let root = try copyUSB("PlaybackUSB")
        let live = open(root)
        returnToRoot(live)
        func browse(_ id: String) {
            live.coordinate(withNormalizedOffset: CGVector(dx: 0.005, dy: 0.25))
                .press(forDuration: 0.05, thenDragTo: live.coordinate(withNormalizedOffset: CGVector(dx: 0.75, dy: 0.25)),
                       withVelocity: .slow, thenHoldForDuration: 0.2)
            let button = live.buttons["library.drawer.\(id)"]
            XCTAssertTrue(button.waitForExistence(timeout: 5)); button.tap()
        }
        // The drawer is a newer surface; the USB reader also runs on older shells.
        live.coordinate(withNormalizedOffset: CGVector(dx: 0.005, dy: 0.25))
            .press(forDuration: 0.05, thenDragTo: live.coordinate(withNormalizedOffset: CGVector(dx: 0.75, dy: 0.25)),
                   withVelocity: .slow, thenHoldForDuration: 0.2)
        guard live.buttons["library.drawer.tracks"].waitForExistence(timeout: 3) else { throw XCTSkip("This shell has no library drawer") }
        live.buttons["library.drawer.tracks"].tap()
        let source = tracks(live).firstMatch
        XCTAssertTrue(source.waitForExistence(timeout: 5))
        browse("artists")
        XCTAssertTrue(live.buttons["library.group.Stavöstranos"].waitForExistence(timeout: 5))
        browse("albums")
        XCTAssertTrue(live.buttons["library.group.Album"].waitForExistence(timeout: 5))
        browse("tracks")
        let pioneer = root.appendingPathComponent("PIONEER")
        try FileManager.default.moveItem(at: pioneer, to: root.appendingPathComponent("ejected-PIONEER"))
        XCTAssertTrue(source.waitForNonExistence(timeout: 15))
        XCTAssertTrue(live.buttons["track.waveform.demo-1"].exists, "Normal library tracks remain available")
        browse("artists")
        XCTAssertFalse(live.buttons["library.group.Stavöstranos"].exists)
        browse("albums")
        XCTAssertFalse(live.buttons["library.group.Album"].exists)
        browse("playlists")
        XCTAssertFalse(live.buttons["usb.open"].exists)
        try FileManager.default.moveItem(at: root.appendingPathComponent("ejected-PIONEER"), to: pioneer)
        XCTAssertTrue(live.buttons["usb.open"].waitForExistence(timeout: 15))
        browse("tracks")
        XCTAssertTrue(source.waitForExistence(timeout: 10))
        capture(live, "USB tracks return only while connected")
    }

    func testInvalidMissingAndOneLibraryOnlyUSBsShowRecoverableErrors() throws {
        for (name, error) in [("MissingUSB", "No Rekordbox Device Library found"),
                              ("CorruptUSB", "damaged or uses an unsupported format"),
                              ("OneLibraryUSB", "contains only OneLibrary")] {
            let app = open(try fixture(name))
            expectError(error, in: app)
            capture(app, "USB error \(name)")
            app.buttons["usb.done"].tap()
            XCTAssertTrue(app.buttons["playlist.row.demo-c2"].waitForExistence(timeout: 5))
            app.terminate()
        }
    }
}
#endif

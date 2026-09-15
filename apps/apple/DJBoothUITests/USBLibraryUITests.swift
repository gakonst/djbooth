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
        app.launchArguments = ["--ui-test-library", UUID().uuidString]
        app.launchEnvironment["DJBOOTH_TEST_USB_ROOT"] = root.path
        app.launch()
        XCTAssertTrue(app.buttons["usb.open"].waitForExistence(timeout: 20))
        app.buttons["usb.open"].tap()
        XCTAssertTrue(app.buttons["usb.chooseFolder"].waitForExistence(timeout: 5))
        app.buttons["usb.chooseFolder"].tap()
        return app
    }

    private func playlist(_ name: String, in app: XCUIApplication) -> XCUIElement {
        app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'usb.playlist.'"))
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

    func testReadsExportedMetadataAndOriginalPlaylistOrder() throws {
        let app = open(try fixture("InitialUSB"))
        XCTAssertTrue(app.buttons["usb.allTracks"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.staticTexts["All tracks (2)"].exists)
        openPlaylist("Gigs", in: app)
        openPlaylist("Tonight", in: app)
        XCTAssertTrue(app.buttons["usb.track.0"].staticTexts["Second"].exists)
        XCTAssertTrue(app.buttons["usb.track.1"].staticTexts["First"].exists)
        capture(app, "USB playlist preserves Rekordbox order")
        app.buttons["usb.track.1"].tap()
        // LabeledContent exposes its label and value as one accessibility element.
        for value in ["Stavöstranos", "128.01", "Am", "3:00"] {
            XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", value))
                .firstMatch.waitForExistence(timeout: 5), "Missing track detail: \(value)")
        }
        XCTAssertTrue(app.staticTexts["comment"].exists)
        capture(app, "USB metadata from fake master.db")
    }

    func testRefreshReadsRenamedAndReorderedPlaylistFromSameUSBFolder() throws {
        let root = try copyUSB("InitialUSB")
        let app = open(root)
        XCTAssertTrue(app.buttons["usb.allTracks"].waitForExistence(timeout: 15))
        openPlaylist("Gigs", in: app)
        XCTAssertTrue(playlist("Tonight", in: app).waitForExistence(timeout: 5))
        let database = root.appendingPathComponent("PIONEER/rekordbox/export.pdb")
        try Data(contentsOf: fixture("UpdatedUSB").appendingPathComponent("PIONEER/rekordbox/export.pdb")).write(to: database)
        XCTAssertTrue(playlist("Tonight", in: app).exists, "The current view is a snapshot until explicitly refreshed")
        app.navigationBars.buttons.element(boundBy: 0).tap()
        app.buttons["usb.openAnother"].tap()
        XCTAssertTrue(app.buttons["usb.allTracks"].waitForExistence(timeout: 15))
        openPlaylist("Gigs", in: app)
        XCTAssertFalse(playlist("Tonight", in: app).exists)
        openPlaylist("Afterhours", in: app)
        XCTAssertTrue(app.buttons["usb.track.0"].staticTexts["First"].exists)
        XCTAssertTrue(app.buttons["usb.track.1"].staticTexts["Second"].exists)
        capture(app, "Refreshed USB playlist after CLI mutation and sync")
    }

    func testCLIImportsCDJHistoryAndExportsItAsADatedPlaylist() throws {
        let played = open(try fixture("PlayedUSB"))
        let history = played.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'usb.history.'")).firstMatch
        XCTAssertTrue(history.waitForExistence(timeout: 15))
        history.tap()
        for (position, title) in ["Second", "First", "Second"].enumerated() {
            XCTAssertTrue(played.buttons["usb.track.\(position)"].staticTexts[title].exists)
        }
        capture(played, "CDJ history before CLI sync")
        played.terminate()

        let synced = open(try fixture("HistoryUSB"))
        XCTAssertTrue(synced.buttons["usb.allTracks"].waitForExistence(timeout: 15))
        XCTAssertFalse(synced.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'usb.history.'")).firstMatch.exists)
        let imported = synced.buttons.matching(NSPredicate(format: "identifier BEGINSWITH 'usb.playlist.' AND label CONTAINS 'DJ Set '")).firstMatch
        XCTAssertTrue(imported.waitForExistence(timeout: 5))
        imported.tap()
        for (position, title) in ["Second", "First", "Second"].enumerated() {
            XCTAssertTrue(synced.buttons["usb.track.\(position)"].staticTexts[title].exists)
        }
        capture(synced, "CLI imported history exported back to USB")
    }

    func testDisconnectedUSBRecoversAndNeverChangesLocalLibrary() throws {
        let root = try copyUSB("InitialUSB")
        let app = open(root)
        XCTAssertTrue(app.buttons["usb.allTracks"].waitForExistence(timeout: 15))
        try FileManager.default.removeItem(at: root.appendingPathComponent("PIONEER"))
        app.buttons["usb.openAnother"].tap()
        expectError("No Rekordbox Device Library found", in: app)
        try FileManager.default.copyItem(at: fixture("InitialUSB").appendingPathComponent("PIONEER"),
                                         to: root.appendingPathComponent("PIONEER"))
        app.buttons["usb.chooseFolder"].tap()
        XCTAssertTrue(app.buttons["usb.allTracks"].waitForExistence(timeout: 15))
        app.buttons["usb.done"].tap()
        XCTAssertTrue(app.buttons["playlist.row.demo-c2"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.staticTexts["Gigs"].exists)
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

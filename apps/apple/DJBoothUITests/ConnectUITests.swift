import XCTest

/// Run with the local Worker fixture: pnpm --filter @gakonst/djbooth-cloud test:mobile-server.
/// Uses real ASWebAuthenticationSession, browser SDK, PKCE exchange, Keychain and sync.
#if os(iOS)
@MainActor final class ConnectUITests: XCTestCase {
    override func setUpWithError() throws { continueAfterFailure = false }
    func testLoginAgentAccountSwitchAndSignOut() throws {
        guard let data = try? Data(contentsOf: URL(string: "http://127.0.0.1:8791/__mobile_fixture")!), String(data: data, encoding: .utf8) == "djbooth-mobile-fixture" else {
            throw XCTSkip("Start the local mobile fixture with pnpm --filter @gakonst/djbooth-cloud test:mobile-server")
        }
        let app = XCUIApplication()
        app.launchEnvironment["DJBOOTH_CLOUD_URL"] = "http://127.0.0.1:8791"
        app.launch()
        XCTAssertTrue(app.buttons["connect.login"].waitForExistence(timeout: 20))
        login("Alice", app)
        XCTAssertTrue(app.buttons["playlist.row.shared-playlist-id"].waitForExistence(timeout: 20))
        XCTAssertTrue(app.staticTexts["Alice private playlist"].exists)
        openSettings(app)
        XCTAssertTrue(app.staticTexts["Spotify"].exists)
        app.buttons["connect.agent"].tap()
        let input = app.descendants(matching: .any)["agent.input"].firstMatch
        XCTAssertTrue(input.waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Connected to this phone · Can read your library and app state"].waitForExistence(timeout: 20))
        input.tap(); input.typeText("What's in my library?")
        app.buttons["agent.send"].tap()
        XCTAssertTrue(app.staticTexts["On this phone: Alice private playlist."].waitForExistence(timeout: 20))
        input.tap(); input.typeText("Suggest an opening set")
        app.buttons["agent.send"].tap()
        XCTAssertTrue(app.staticTexts["Alice's Spotify and SoundCloud: try a warm opening set. Local test reply."].waitForExistence(timeout: 20))
        capture(app, "Native music agent with account Alice")
        app.buttons["agent.done"].tap()
        app.buttons["connect.done"].tap()
        app.buttons["library.drawer.open"].tap()
        app.buttons["library.drawer.download"].tap()
        let source = app.textFields["import.source"]
        XCTAssertTrue(source.waitForExistence(timeout: 5))
        source.tap(); source.typeText("https://soundcloud.com/local-test/sets/alice")
        app.buttons["import.submit"].tap()
        XCTAssertTrue(app.staticTexts["Local test import running"].waitForExistence(timeout: 10))
        app.buttons["import.done"].tap()
        app.terminate(); app.launch()
        XCTAssertTrue(app.staticTexts["Alice private playlist"].waitForExistence(timeout: 20), "Keychain login and account library survive relaunch")
        openSettings(app)
        app.buttons["connect.agent"].tap()
        XCTAssertTrue(input.waitForExistence(timeout: 5))
        input.tap(); input.typeText("slow request from Alice")
        app.buttons["agent.send"].tap()
        XCTAssertTrue(app.buttons["agent.stop"].waitForExistence(timeout: 5))
        app.buttons["agent.done"].tap()
        login("Bob", app)
        XCTAssertTrue(app.staticTexts["Bob private playlist"].waitForExistence(timeout: 20))
        XCTAssertFalse(app.staticTexts["Alice private playlist"].exists)
        openSettings(app)
        app.buttons["connect.agent"].tap()
        XCTAssertTrue(input.waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Connected to this phone · Can read your library and app state"].waitForExistence(timeout: 20))
        XCTAssertFalse(app.staticTexts["Alice's Spotify and SoundCloud: try a warm opening set. Local test reply."].exists)
        input.tap(); input.typeText("Suggest music")
        app.buttons["agent.send"].tap()
        XCTAssertTrue(app.staticTexts["Bob's Spotify and SoundCloud: try a warm opening set. Local test reply."].waitForExistence(timeout: 20))
        XCTAssertFalse(app.staticTexts["slow request from Alice"].exists)
        capture(app, "Native music agent with account Bob")
        input.tap(); input.typeText("slow request to cancel")
        app.buttons["agent.send"].tap()
        XCTAssertTrue(app.buttons["agent.stop"].waitForExistence(timeout: 5))
        app.buttons["agent.stop"].tap()
        XCTAssertTrue(app.buttons["agent.stop"].waitForNonExistence(timeout: 10))
        app.buttons["agent.done"].tap()
        app.buttons["connect.logout"].tap()
        XCTAssertTrue(app.buttons["connect.login"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.staticTexts["Bob private playlist"].exists)
        app.terminate(); app.launch()
        XCTAssertTrue(app.buttons["connect.login"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["connect.agent"].exists)
        capture(app, "Signed out after relaunch")
    }
    func testConnectedMusicFoldersBrowseAndDownload() throws {
        guard let _ = try? Data(contentsOf: URL(string: "http://127.0.0.1:8791/__mobile_fixture")!) else { throw XCTSkip("Start mobile fixture") }
        _ = try Data(contentsOf: URL(string: "http://127.0.0.1:8791/__mobile_music?enabled=1&delay=1&fail=1")!)
        defer { _ = try? Data(contentsOf: URL(string: "http://127.0.0.1:8791/__mobile_music?enabled=0")!) }
        let app = XCUIApplication()
        app.launchEnvironment["DJBOOTH_CLOUD_URL"] = "http://127.0.0.1:8791"
        app.launch()
        if !app.buttons["connect.login"].exists { openSettings(app) }
        login("Alice", app)
        XCTAssertTrue(app.buttons["music.source.Spotify"].waitForExistence(timeout: 20))
        XCTAssertTrue(app.buttons["music.source.SoundCloud"].exists)
        XCTAssertFalse(app.buttons["usb.open"].exists)
        XCTAssertFalse(app.buttons["Retry music accounts"].exists)
        capture(app, "Connected music folders")
        app.buttons["music.source.Spotify"].tap()
        XCTAssertTrue(app.buttons["music.playlist.fixture-playlist"].waitForExistence(timeout: 10))
        app.buttons["music.playlist.fixture-playlist"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["music.playlist.loading"].firstMatch.waitForExistence(timeout: 5))
        XCTAssertFalse(app.staticTexts["No tracks"].exists)
        XCTAssertTrue(app.buttons["music.playlist.retry"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.staticTexts["No tracks"].exists)
        capture(app, "Playlist load failure with retry")
        app.buttons["music.playlist.retry"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["music.playlist.loading"].firstMatch.waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Alice streaming track"].waitForExistence(timeout: 10))
        capture(app, "Spotify metadata without acquisition or analysis")
        app.buttons["playlist.back"].tap()
        app.buttons["music.download.fixture-playlist"].tap()
        XCTAssertTrue(app.staticTexts["Local test import running"].waitForExistence(timeout: 10))
        capture(app, "Connected playlist in standard download pipeline")
        app.buttons["import.done"].tap()
        openSettings(app)
        app.buttons["connect.logout"].tap()
        XCTAssertTrue(app.buttons["connect.login"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["music.source.Spotify"].exists)
    }

    func testMusicConnectionErrorsStayInsideTheirFolder() throws {
        guard let _ = try? Data(contentsOf: URL(string: "http://127.0.0.1:8791/__mobile_fixture")!) else { throw XCTSkip("Start mobile fixture") }
        _ = try Data(contentsOf: URL(string: "http://127.0.0.1:8791/__mobile_music?enabled=1&folderFail=1")!)
        defer { _ = try? Data(contentsOf: URL(string: "http://127.0.0.1:8791/__mobile_music?enabled=0")!) }
        let app = XCUIApplication()
        app.launchEnvironment["DJBOOTH_CLOUD_URL"] = "http://127.0.0.1:8791"
        app.launch()
        if !app.buttons["connect.login"].exists { openSettings(app) }
        login("Alice", app)
        XCTAssertTrue(app.buttons["music.source.SoundCloud"].waitForExistence(timeout: 20))
        XCTAssertFalse(app.buttons["usb.open"].exists)
        XCTAssertFalse(app.buttons["Retry music accounts"].exists)
        app.buttons["music.source.SoundCloud"].tap()
        XCTAssertTrue(app.buttons["music.folder.retry"].waitForExistence(timeout: 20))
        XCTAssertFalse(app.staticTexts["No playlists here"].exists)
        capture(app, "SoundCloud error inside its folder")
        app.buttons["playlist.folder.back"].tap()
        XCTAssertTrue(app.buttons["music.source.SoundCloud"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["music.folder.retry"].exists)
        XCTAssertFalse(app.staticTexts["Couldn’t refresh SoundCloud"].exists)
        capture(app, "Home contains folders without connection errors or absent USB")
        app.buttons["music.source.Spotify"].tap()
        XCTAssertTrue(app.buttons["music.playlist.fixture-playlist"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["music.folder.retry"].exists)
        app.buttons["playlist.folder.back"].tap()
        _ = try Data(contentsOf: URL(string: "http://127.0.0.1:8791/__mobile_music_folder_failure?enabled=0")!)
        app.buttons["music.source.SoundCloud"].tap()
        if app.buttons["music.folder.retry"].waitForExistence(timeout: 3) { app.buttons["music.folder.retry"].tap() }
        XCTAssertTrue(app.buttons["music.playlist.soundcloud:playlists:123"].waitForExistence(timeout: 20))
        XCTAssertFalse(app.buttons["music.folder.retry"].exists)
        openSettings(app)
        app.buttons["connect.logout"].tap()
    }

    private func openSettings(_ app: XCUIApplication) {
        for _ in 0..<5 {
            if app.buttons["playlist.back"].exists { app.buttons["playlist.back"].tap() }
            else if app.buttons["playlist.folder.back"].exists { app.buttons["playlist.folder.back"].tap() }
            else { break }
        }
        let menu = app.buttons["library.drawer.open"]
        XCTAssertTrue(menu.waitForExistence(timeout: 20)); menu.tap()
        let settings = app.buttons["library.drawer.settings"]
        XCTAssertTrue(settings.waitForExistence(timeout: 5)); settings.tap()
        XCTAssertTrue(app.buttons["connect.login"].waitForExistence(timeout: 5))
    }
    private func login(_ who: String, _ app: XCUIApplication) {
        app.buttons["connect.login"].tap()
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        if app.alerts.buttons["Continue"].waitForExistence(timeout: 5) { app.alerts.buttons["Continue"].tap() }
        else if springboard.buttons["Continue"].waitForExistence(timeout: 3) { springboard.buttons["Continue"].tap() }
        let web = XCUIApplication(bundleIdentifier: "com.apple.SafariViewService")
        let connect = web.buttons["Continue with Nanocodex"]
        if connect.waitForExistence(timeout: 10) { connect.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap() }
        else if app.webViews.buttons["Continue with Nanocodex"].exists { app.webViews.buttons["Continue with Nanocodex"].coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap() }
        let approve = web.buttons["Approve \(who)"]
        if approve.waitForExistence(timeout: 15) {
            XCTAssertTrue(web.staticTexts["Choose a test account"].waitForExistence(timeout: 10))
            // Safari's popup AX tree reports visible buttons as not hittable on
            // iOS 26.5. Tap the observed element's center, still through UIKit.
            approve.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        }
        else {
            let inApp = app.webViews.buttons["Approve \(who)"]
            XCTAssertTrue(inApp.waitForExistence(timeout: 5), "Approval popup must work inside ASWebAuthenticationSession: \(app.debugDescription) \(web.debugDescription)")
            XCTAssertTrue(app.webViews.staticTexts["Choose a test account"].waitForExistence(timeout: 10))
            inApp.tap()
        }
        XCTAssertTrue(app.buttons["library.drawer.open"].waitForExistence(timeout: 20), "Login returns to the native library")
    }
    private func capture(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot()); attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
    }
}

#endif

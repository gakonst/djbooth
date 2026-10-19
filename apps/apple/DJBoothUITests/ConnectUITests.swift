import XCTest

/// Run with the local Worker fixture: pnpm --filter @gakonst/djbooth-cloud test:mobile-server.
/// Uses real ASWebAuthenticationSession, browser SDK, PKCE exchange, Keychain and sync.
#if os(iOS)
@MainActor final class ConnectUITests: XCTestCase {
    override func setUpWithError() throws { continueAfterFailure = false }

    /// Fresh loopback TLS fixture; real paired storage/audio, never Link sockets.
    func testPairedGlobalSearchRecentlyAddedAndQueueIdentity() throws {
        let control = URL(string: "http://127.0.0.1:8792")!
        let descriptor = try Data(contentsOf: control.appendingPathComponent("fixture"))
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: descriptor) as? [String: Any])
        let prefix = "paired:\(try XCTUnwrap(json["libraryID"] as? String)):"
        let app = XCUIApplication()
        app.launchArguments = ["--ui-test-server-unavailable"]
        app.launchEnvironment["DJBOOTH_CLOUD_URL"] = "http://127.0.0.1:1/\(UUID().uuidString)"
        app.launchEnvironment["DJBOOTH_PAIRING_JSON"] = String(decoding: descriptor, as: UTF8.self)
        app.launch()
        let folder = app.buttons["playlist.folder.\(prefix)playlist:sets-a"]
        XCTAssertTrue(folder.waitForExistence(timeout: 30)); folder.tap()
        let playlist = app.buttons["playlist.row.\(prefix)playlist:aba"]
        XCTAssertTrue(playlist.waitForExistence(timeout: 5))
        app.buttons["pair.download.\(prefix)playlist:aba"].tap()
        playlist.tap()
        let rows = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "track.waveform.\(prefix)"))
        let queue = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "nowPlaying.queue.track.\(prefix)"))
        func expectRows(_ names: [String]) {
            let expected = names.map { "Play \($0)" }
            let ready = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                rows.allElementsBoundByIndex.map(\.label) == expected
            }, object: nil)
            let result = XCTWaiter.wait(for: [ready], timeout: 10)
            if result != .completed { captureSidebarFailure(app, "Search rows mismatch: \(names)") }
            XCTAssertEqual(result, .completed, "Expected \(expected), got \(rows.allElementsBoundByIndex.map(\.label))")
        }
        expectRows(["First light", "Night drive", "First light"])
        let available = app.buttons.matching(NSPredicate(format: "label IN %@ AND value CONTAINS %@",
            ["Play First light", "Play Night drive"], "Available offline"))
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "count == 3"), object: available)], timeout: 40), .completed)
        XCTAssertTrue(app.buttons["library.search.open"].isHittable)
        capture(app, "Search entry on paired playlist")
        rows.element(boundBy: 2).tap()
        let playingThird = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            queue.count == 3 && queue.element(boundBy: 2).value as? String == "Playing"
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [playingThird], timeout: 15), .completed,
                       "Selecting the repeated third membership must not select the first occurrence")
        app.buttons["library.search.open"].tap()
        let search = app.textFields["library.search"]
        XCTAssertTrue(search.waitForExistence(timeout: 5))
        XCTAssertEqual(queue.element(boundBy: 2).value as? String, "Playing", "Opening search must not interrupt playback")
        app.buttons["nowPlaying.play"].tap()
        expectRows(["Amber echoes", "Before time", "First light", "Night drive"])
        func query(_ text: String) {
            if app.buttons["Clear search"].exists { app.buttons["Clear search"].tap() }
            search.tap(); search.typeText(text + "\n")
        }
        query("NIGHT")
        expectRows(["Night drive"])
        func catalogRequests() throws -> Int {
            let status = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: control.appendingPathComponent("status"))) as? [String: Any])
            return try XCTUnwrap(status["catalogRequests"] as? Int)
        }
        let beforeRefresh = try catalogRequests()
        app.collectionViews["library.tracks"].swipeDown(velocity: .slow)
        let refreshed = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            (try? catalogRequests()).map { $0 > beforeRefresh } ?? false
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [refreshed], timeout: 10), .completed)
        let lostQuery = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value != %@", "NIGHT"), object: search)
        lostQuery.isInverted = true
        XCTAssertEqual(XCTWaiter.wait(for: [lostQuery], timeout: 3), .completed, "Catalog reconciliation must retain visible search")
        expectRows(["Night drive"])
        XCTAssertEqual(queue.count, 3)
        XCTAssertEqual(queue.element(boundBy: 2).value as? String, "Paused", "Browsing search must preserve the existing queue occurrence")
        query("hidden artist")
        expectRows(["Amber echoes"])
        capture(app, "Global artist search finds track outside playlist")
        query("DAWN STUDY")
        expectRows(["First light"])
        rows.firstMatch.tap()
        let filteredPlayback = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            queue.count == 1 && queue.firstMatch.identifier == "nowPlaying.queue.track.\(prefix)track:a" && queue.firstMatch.value as? String == "Playing"
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [filteredPlayback], timeout: 15), .completed)
        app.buttons["nowPlaying.play"].tap()
        query("no-such-recording")
        expectRows([])
        XCTAssertTrue(app.staticTexts["No matching tracks"].exists)
        capture(app, "Search empty state keeps phone player")
        app.buttons["Clear search"].tap()
        app.buttons["library.actions"].tap()
        XCTAssertTrue(app.buttons["Recently Added"].waitForExistence(timeout: 5))
        capture(app, "Recently Added in Tracks actions")
        app.buttons["Recently Added"].tap()
        expectRows(["Night drive", "Amber echoes", "First light", "Before time"])
        capture(app, "Recently Added newest first with unknown date last")
        rows.element(boundBy: 2).tap()
        let sortedPlayback = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            queue.count == 4 && queue.element(boundBy: 2).identifier == "nowPlaying.queue.track.\(prefix)track:a" && queue.element(boundBy: 2).value as? String == "Playing"
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [sortedPlayback], timeout: 15), .completed)
        app.buttons["nowPlaying.play"].tap()
        // Stop the actual TLS listener and remove bootstrap credentials. Search,
        // ordering and playback must now use persisted metadata and local WAVs.
        var request = URLRequest(url: control.appendingPathComponent("offline")); request.httpMethod = "POST"
        let stopped = XCTestExpectation(description: "TLS listener stopped")
        URLSession.shared.dataTask(with: request) { _, _, _ in stopped.fulfill() }.resume()
        XCTAssertEqual(XCTWaiter.wait(for: [stopped], timeout: 10), .completed)
        let status = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: control.appendingPathComponent("status"))) as? [String: Any])
        XCTAssertEqual(status["offline"] as? Bool, true)
        XCTAssertEqual(status["audioRequests"] as? [String], ["a", "b"])
        app.terminate(); app.launchEnvironment.removeValue(forKey: "DJBOOTH_PAIRING_JSON"); app.launch()
        XCTAssertTrue(search.waitForExistence(timeout: 20))
        expectRows(["Night drive", "Amber echoes", "First light", "Before time"])
        XCTAssertTrue(app.staticTexts["library.tracks.summary"].label.contains("Recently Added"))
        capture(app, "Recently Added restored offline")
        query("night")
        expectRows(["Night drive"])
        rows.firstMatch.tap()
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "label == 'Pause'"), object: app.buttons["nowPlaying.play"])], timeout: 15), .completed)
        XCTAssertTrue(app.descendants(matching: .any)["nowPlaying.title"].firstMatch.label.contains("Night drive"))
        capture(app, "Offline search result plays original paired identity")
        app.terminate()
    }

    /// Start Fixtures/paired-library-ui.py once per run. Use an isolated simulator
    /// with no existing local media: the audio-only fixture must never start Link.
    func testPairedMacFoldersDownloadAndOfflinePlayback() throws {
        let control = URL(string: "http://127.0.0.1:8792")!
        let descriptor = try Data(contentsOf: control.appendingPathComponent("fixture"))
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: descriptor) as? [String: Any])
        let libraryID = try XCTUnwrap(json["libraryID"] as? String)
        let prefix = "paired:\(libraryID):"
        func status() throws -> [String: Any] {
            try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: control.appendingPathComponent("status"))) as? [String: Any])
        }
        func setOffline(_ offline: Bool) throws {
            var request = URLRequest(url: control.appendingPathComponent(offline ? "offline" : "online"))
            request.httpMethod = "POST"
            let finished = XCTestExpectation(description: "Loopback TLS listener transition")
            URLSession.shared.dataTask(with: request) { _, _, _ in finished.fulfill() }.resume()
            XCTAssertEqual(XCTWaiter.wait(for: [finished], timeout: 10), .completed)
            XCTAssertEqual(try status()["offline"] as? Bool, offline)
        }
        XCTAssertEqual(try status()["offline"] as? Bool, false, "Restart the loopback fixture before each run")
        XCTAssertEqual(try status()["audioRequests"] as? [String], [])
        let app = XCUIApplication()
        app.launchArguments = ["--ui-test-server-unavailable"]
        app.launchEnvironment["DJBOOTH_CLOUD_URL"] = "http://127.0.0.1:1/\(UUID().uuidString)"
        app.launchEnvironment["DJBOOTH_PAIRING_JSON"] = String(decoding: descriptor, as: UTF8.self)
        app.launch()

        func folder(_ id: String) -> XCUIElement { app.buttons["playlist.folder.\(prefix)playlist:\(id)"] }
        func back() {
            let button = app.navigationBars.buttons["BackButton"]
            XCTAssertTrue(button.waitForExistence(timeout: 5)); button.tap()
        }
        func expectWiFiOff() {
            // The paired root is still a pushed folder; only the global root
            // exposes the drawer. Return here after checking Link settings.
            back()
            openSidebar(app, destination: "library.drawer.djlink")
            app.buttons["library.drawer.djlink"].tap()
            let wifi = app.switches["djlink.wifi"]
            XCTAssertTrue(wifi.waitForExistence(timeout: 5))
            XCTAssertEqual(wifi.value as? String, "0", "Pairing and downloads must not opt into Wi-Fi sharing")
            XCTAssertFalse(app.staticTexts["djlink.status"].exists, "Audio without analysis cannot become a Link source")
            capture(app, "Paired library Wi-Fi remains off")
            app.buttons["Done"].tap()
            let pairedRoot = app.buttons["playlist.folder.\(prefix)root"]
            XCTAssertTrue(pairedRoot.waitForExistence(timeout: 5)); pairedRoot.tap()
        }
        XCTAssertTrue(folder("sets-a").waitForExistence(timeout: 30), "Normal verified pairing must open the Mac root")
        XCTAssertTrue(app.navigationBars["Studio Mac"].exists)
        for id in ["sets-a", "sets-b"] {
            XCTAssertTrue(folder(id).exists)
            XCTAssertTrue(folder(id).label.contains("Sets"))
            XCTAssertFalse(folder(id).label.contains("paired:"))
        }
        capture(app, "Paired same-name folders use display labels")
        expectWiFiOff()
        folder("empty").tap()
        XCTAssertTrue(app.staticTexts["No playlists here"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["This folder on your Mac is empty."].exists)
        XCTAssertTrue(app.navigationBars["Empty folder"].exists)
        capture(app, "Paired empty folder survives catalog projection")
        back()
        folder("sets-b").tap()
        XCTAssertTrue(app.navigationBars["Sets"].exists)
        XCTAssertTrue(app.buttons["playlist.row.\(prefix)playlist:other"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["playlist.row.\(prefix)playlist:aba"].exists)
        back()
        folder("sets-a").tap()
        let playlist = app.buttons["playlist.row.\(prefix)playlist:aba"]
        XCTAssertTrue(playlist.waitForExistence(timeout: 5))
        playlist.tap()
        let rows = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "track.waveform.\(prefix)"))
        func expectTracks(offline: Bool) {
            XCTAssertTrue(rows.element(boundBy: 2).waitForExistence(timeout: 10))
            XCTAssertEqual(rows.count, 3)
            XCTAssertEqual(rows.allElementsBoundByIndex.map(\.label), ["Play First light", "Play Night drive", "Play First light"])
            XCTAssertEqual(app.staticTexts["track.bpm.\(prefix)track:a"].firstMatch.label, "123.0")
            XCTAssertEqual(app.staticTexts["track.key.\(prefix)track:a"].firstMatch.label, "8A")
            // iOS deliberately omits the playlist count subtitle. The title
            // buttons expose actual phone-local availability for every row.
            let titles = app.buttons.matching(NSPredicate(format: "label IN %@ AND value CONTAINS %@",
                ["Play First light", "Play Night drive"], offline ? "Available offline" : "Not on this device"))
            let availability = XCTNSPredicateExpectation(predicate: NSPredicate(format: "count == 3"), object: titles)
            let result = XCTWaiter.wait(for: [availability], timeout: 40)
            if result != .completed { captureSidebarFailure(app, "Paired track availability mismatch") }
            XCTAssertEqual(result, .completed, "All three playlist positions must reflect verified phone-local availability")
        }
        expectTracks(offline: false)
        let cover = app.images["artwork.\(prefix)track:a"].firstMatch
        XCTAssertTrue(cover.waitForExistence(timeout: 15), "Embedded artwork must load despite a false catalog hint")
        XCTAssertFalse(app.images["artwork.\(prefix)track:b"].exists, "A missing optional cover stays a placeholder")
        XCTAssertEqual(try status()["audioRequests"] as? [String], [], "Browsing covers must not download audio")
        XCTAssertEqual(try status()["artworkRequests"] as? [String], ["a"], "Repeated playlist rows share one cover download")
        capture(app, "Paired artwork online with missing-cover placeholder")
        back()
        app.buttons["pair.download.\(prefix)playlist:aba"].tap()
        playlist.tap()
        expectTracks(offline: true)
        capture(app, "Paired playlist verified on this device")
        XCTAssertEqual(try status()["audioRequests"] as? [String], ["a", "b"], "Repeated membership downloads each recording once")

        // Close the actual TLS listening socket before relaunch, not just a UI
        // offline flag. The pairing remains in Keychain and the snapshot on disk.
        try setOffline(true)
        app.terminate()
        app.launchEnvironment.removeValue(forKey: "DJBOOTH_PAIRING_JSON")
        app.launch()
        // Use ordinary settings navigation instead of relying on restoration of
        // the currently open folder. Browse reads the persisted local snapshot.
        for _ in 0..<5 where app.navigationBars.buttons["BackButton"].exists { back() }
        openSidebar(app, destination: "library.drawer.settings")
        app.buttons["library.drawer.settings"].tap()
        let browse = app.buttons["pair.browse"]
        XCTAssertTrue(browse.waitForExistence(timeout: 10))
        capture(app, "Paired Mac cached while TLS server is stopped")
        browse.tap()
        XCTAssertTrue(folder("sets-a").waitForExistence(timeout: 5))
        XCTAssertTrue(folder("sets-b").exists)
        XCTAssertTrue(folder("empty").exists)
        expectWiFiOff()
        folder("sets-a").tap()
        XCTAssertTrue(playlist.waitForExistence(timeout: 5))
        playlist.tap()
        expectTracks(offline: true)
        XCTAssertTrue(cover.waitForExistence(timeout: 10), "Verified artwork must survive offline relaunch")
        XCTAssertFalse(app.images["artwork.\(prefix)track:b"].exists)
        capture(app, "Paired artwork offline after relaunch")
        rows.element(boundBy: 0).tap()
        let play = app.buttons["nowPlaying.play"]
        let playing = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label == 'Pause'"), object: play)
        XCTAssertEqual(XCTWaiter.wait(for: [playing], timeout: 15), .completed)
        XCTAssertTrue(app.descendants(matching: .any)["nowPlaying.title"].firstMatch.label.contains("First light"))
        let elapsed = app.staticTexts["nowPlaying.elapsed"].firstMatch
        XCTAssertTrue(elapsed.waitForExistence(timeout: 5))
        let initial = elapsed.value as? String
        let advancing = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            guard let value = elapsed.value as? String else { return false }
            return value != initial && value != "0:00"
        }, object: elapsed)
        XCTAssertEqual(XCTWaiter.wait(for: [advancing], timeout: 8), .completed, "Real WAV playback must advance with the Mac offline")
        XCTAssertEqual(app.staticTexts["nowPlaying.duration"].firstMatch.value as? String, "0:35")
        capture(app, "Paired offline WAV playback after relaunch")
        play.tap()
        XCTAssertEqual(try status()["audioRequests"] as? [String], ["a", "b"])
        XCTAssertEqual(try status()["artworkRequests"] as? [String], ["a"])
        back(); back(); back()
        openSidebar(app, destination: "library.drawer.settings")
        app.buttons["library.drawer.settings"].tap()
        XCTAssertTrue(app.buttons["pair.forget"].waitForExistence(timeout: 5))
        app.buttons["pair.forget"].tap()
        let confirmation = app.alerts["Forget this Mac?"].buttons["Forget Mac"]
        XCTAssertTrue(confirmation.waitForExistence(timeout: 5)); confirmation.tap()
        XCTAssertTrue(browse.waitForNonExistence(timeout: 5))
        app.terminate()
        try setOffline(false)
        let requestsBeforeRelaunch = try XCTUnwrap(status()["credentialRequests"] as? Int)
        app.launch()
        openSidebar(app, destination: "library.drawer.settings")
        app.buttons["library.drawer.settings"].tap()
        XCTAssertTrue(app.buttons["pair.open"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.buttons["pair.open"].label, "Pair with Mac")
        XCTAssertFalse(browse.exists)
        XCTAssertFalse(app.descendants(matching: .any)["pair.status"].firstMatch.exists)
        let leakedCredentials = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            (try? status()["credentialRequests"] as? Int) != requestsBeforeRelaunch
        }, object: nil)
        leakedCredentials.isInverted = true
        XCTAssertEqual(XCTWaiter.wait(for: [leakedCredentials], timeout: 6), .completed,
                       "Forget must remove the persisted credential before the old origin becomes reachable again")
        capture(app, "Forgotten Mac stays unpaired after relaunch")
        app.terminate()
    }

    func testLocalLibraryAndUSBDoNotRequireCloudLogin() throws {
        let app = XCUIApplication()
        // No demo flag: this must exercise the real signed-out launch path.
        app.launchEnvironment["DJBOOTH_CLOUD_URL"] = "http://127.0.0.1:1/\(UUID().uuidString)"
        app.launch()
        XCTAssertTrue(app.buttons["library.drawer.open"].waitForExistence(timeout: 20))
        XCTAssertFalse(app.buttons["connect.login"].exists)
        capture(app, "Local library without Nanocodex")
        openSidebar(app, destination: "library.drawer.djlink")
        app.buttons["library.drawer.djlink"].tap()
        let wifi = app.switches["djlink.wifi"]
        XCTAssertTrue(wifi.waitForExistence(timeout: 5))
        XCTAssertEqual(wifi.value as? String, "0", "Wi-Fi sharing requires explicit opt-in")
        capture(app, "Wi-Fi sharing without Nanocodex")
        app.buttons["Done"].tap()
        openSettings(app)
        XCTAssertTrue(app.buttons["settings.usb.chooseFolder"].exists)
        app.buttons["settings.usb.chooseFolder"].tap()
        XCTAssertTrue(app.buttons["usb.chooseFolder"].waitForExistence(timeout: 5))
        capture(app, "USB access without Nanocodex")
        app.terminate(); app.launch()
        XCTAssertTrue(app.buttons["library.drawer.open"].waitForExistence(timeout: 20))
        XCTAssertFalse(app.buttons["connect.login"].exists)
    }

    func testEmptyLocalLibraryWiFiSharingStaysReadyToDisable() throws {
        let app = XCUIApplication()
        // Run on a fresh simulator. Keep real local storage and startup, but
        // prevent a reachable workstation from populating the empty library.
        app.launchArguments = ["--ui-test-server-unavailable"]
        app.launchEnvironment["DJBOOTH_CLOUD_URL"] = "http://127.0.0.1:1/\(UUID().uuidString)"
        app.launch()
        openSidebar(app, destination: "library.drawer.tracks")
        app.buttons["library.drawer.tracks"].tap()
        XCTAssertTrue(app.staticTexts["No tracks"].waitForExistence(timeout: 5),
                      "This regression requires an empty real local library; do not enable sharing with existing media")
        openSidebar(app, destination: "library.drawer.djlink")
        app.buttons["library.drawer.djlink"].tap()
        let wifi = app.switches["djlink.wifi"]
        XCTAssertTrue(wifi.waitForExistence(timeout: 5))
        XCTAssertEqual(wifi.value as? String, "0")
        XCTAssertTrue(wifi.isEnabled)
        let waiting = app.descendants(matching: .any)["djlink.waitingForLibrary"].firstMatch
        let initiallyWaitingForLibrary = waiting.exists
        let initialTree = XCTAttachment(string: app.debugDescription)
        initialTree.name = "Empty-library switch accessibility"; initialTree.lifetime = .keepAlways; add(initialTree)
        // iOS 27 exposes the whole Form row as the switch. Its center is the
        // label, so tap the visible control at the trailing end of that row.
        wifi.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5)).tap()
        let enabled = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", "1"), object: wifi)
        let enabledResult = XCTWaiter.wait(for: [enabled], timeout: 5)
        if enabledResult != .completed { captureSidebarFailure(app, "Wi-Fi switch did not turn on") }
        XCTAssertEqual(enabledResult, .completed)
        XCTAssertTrue(waiting.waitForExistence(timeout: 10))
        XCTAssertEqual(wifi.value as? String, "1")
        capture(app, "Empty local library Wi-Fi waiting")
        // Observe beyond several two-second retries, not just one idle frame.
        let unstable = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            !wifi.isEnabled || (wifi.value as? String) != "1" || !waiting.exists ||
                app.staticTexts["djlink.error"].exists || app.staticTexts["djlink.status"].exists
        }, object: nil)
        unstable.isInverted = true
        let stableResult = XCTWaiter.wait(for: [unstable], timeout: 6)
        if stableResult != .completed { captureSidebarFailure(app, "Empty-library sharing state changed") }
        XCTAssertEqual(stableResult, .completed, "Empty-library sharing must keep its enabled switch and stable waiting state")
        wifi.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5)).tap()
        let disabled = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", "0"), object: wifi)
        XCTAssertEqual(XCTWaiter.wait(for: [disabled], timeout: 5), .completed)
        // Simulator networking can include a host Ethernet adapter. Turning off
        // Wi-Fi returns to that wired readiness state, not an active source.
        let restored = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            initiallyWaitingForLibrary ? waiting.exists : (!waiting.exists && app.staticTexts["Waiting for a deck"].exists)
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [restored], timeout: 5), .completed)
        XCTAssertFalse(app.staticTexts["djlink.status"].exists)
        XCTAssertFalse(app.staticTexts["djlink.error"].exists)
        XCTAssertTrue(wifi.isEnabled)
        capture(app, "Empty local library Wi-Fi off")
    }

    func testLoginAgentAccountSwitchAndSignOut() throws {
        guard let data = try? Data(contentsOf: URL(string: "http://127.0.0.1:8791/__mobile_fixture")!), String(data: data, encoding: .utf8) == "djbooth-mobile-fixture" else {
            throw XCTSkip("Start the local mobile fixture with pnpm --filter @gakonst/djbooth-cloud test:mobile-server")
        }
        let app = XCUIApplication()
        app.launchEnvironment["DJBOOTH_CLOUD_URL"] = "http://127.0.0.1:8791"
        app.launch()
        openSettings(app)
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
        openSettings(app)
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
        openSettings(app)
        app.buttons["connect.logout"].tap()
        XCTAssertTrue(app.buttons["library.drawer.open"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.staticTexts["Bob private playlist"].exists)
        app.terminate(); app.launch()
        XCTAssertTrue(app.buttons["library.drawer.open"].waitForExistence(timeout: 10))
        openSettings(app)
        XCTAssertTrue(app.buttons["connect.login"].exists)
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
        app.navigationBars.buttons["BackButton"].tap()
        app.buttons["music.download.fixture-playlist"].tap()
        XCTAssertTrue(app.staticTexts["Local test import running"].waitForExistence(timeout: 10))
        capture(app, "Connected playlist in standard download pipeline")
        app.buttons["import.done"].tap()
        openSettings(app)
        app.buttons["connect.logout"].tap()
        XCTAssertTrue(app.buttons["library.drawer.open"].waitForExistence(timeout: 10))
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
        app.navigationBars.buttons["BackButton"].tap()
        XCTAssertTrue(app.buttons["music.source.SoundCloud"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["music.folder.retry"].exists)
        XCTAssertFalse(app.staticTexts["Couldn’t refresh SoundCloud"].exists)
        capture(app, "Home contains folders without connection errors or absent USB")
        app.buttons["music.source.Spotify"].tap()
        XCTAssertTrue(app.buttons["music.playlist.fixture-playlist"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["music.folder.retry"].exists)
        app.navigationBars.buttons["BackButton"].tap()
        _ = try Data(contentsOf: URL(string: "http://127.0.0.1:8791/__mobile_music_folder_failure?enabled=0")!)
        app.buttons["music.source.SoundCloud"].tap()
        if app.buttons["music.folder.retry"].waitForExistence(timeout: 3) { app.buttons["music.folder.retry"].tap() }
        XCTAssertTrue(app.buttons["music.playlist.soundcloud:playlists:123"].waitForExistence(timeout: 20))
        XCTAssertFalse(app.buttons["music.folder.retry"].exists)
        openSettings(app)
        app.buttons["connect.logout"].tap()
    }

    func testMusicFolderLoadingDoesNotShiftCachedPlaylists() throws {
        guard let _ = try? Data(contentsOf: URL(string: "http://127.0.0.1:8791/__mobile_fixture")!) else { throw XCTSkip("Start mobile fixture") }
        _ = try Data(contentsOf: URL(string: "http://127.0.0.1:8791/__mobile_music?enabled=1&folderDelay=1")!)
        defer { _ = try? Data(contentsOf: URL(string: "http://127.0.0.1:8791/__mobile_music?enabled=0")!) }
        let app = XCUIApplication()
        app.launchEnvironment["DJBOOTH_CLOUD_URL"] = "http://127.0.0.1:8791"
        app.launch()
        if !app.buttons["connect.login"].exists { openSettings(app) }
        login("Alice", app)
        XCTAssertTrue(app.buttons["music.source.SoundCloud"].waitForExistence(timeout: 20))
        app.buttons["music.source.SoundCloud"].tap()
        let loading = app.descendants(matching: .any)["music.folder.loading"].firstMatch
        let playlist = app.buttons["music.playlist.soundcloud:playlists:123"]
        capture(app, "Opening service folder")
        // A repeated run may already have an account-scoped catalog on disk.
        XCTAssertTrue(loading.waitForExistence(timeout: 2) || playlist.exists)
        XCTAssertTrue(app.navigationBars["SoundCloud"].exists)
        XCTAssertFalse(app.staticTexts["Loading playlists…"].exists)
        XCTAssertFalse(app.staticTexts["No playlists here"].exists)
        capture(app, "Native folder navigation and centered initial spinner")
        XCTAssertTrue(playlist.waitForExistence(timeout: 20))
        XCTAssertFalse(loading.exists)
        let position = playlist.frame.minY
        app.navigationBars.buttons["BackButton"].tap()
        app.buttons["music.source.SoundCloud"].tap()
        XCTAssertTrue(playlist.waitForExistence(timeout: 5))
        XCTAssertFalse(loading.exists)
        XCTAssertEqual(playlist.frame.minY, position, accuracy: 1)
        capture(app, "Cached playlists reopen without loading rows")
        openSettings(app)
        app.buttons["connect.logout"].tap()
    }

    func testDownloadedPlaylistsStayInsideServicesWithAnalysisAfterRelaunch() throws {
        guard let _ = try? Data(contentsOf: URL(string: "http://127.0.0.1:8791/__mobile_fixture")!) else { throw XCTSkip("Start mobile fixture") }
        _ = try Data(contentsOf: URL(string: "http://127.0.0.1:8791/__mobile_music?enabled=1")!)
        defer { _ = try? Data(contentsOf: URL(string: "http://127.0.0.1:8791/__mobile_music?enabled=0")!) }
        let app = XCUIApplication()
        app.launchEnvironment["DJBOOTH_CLOUD_URL"] = "http://127.0.0.1:8791"
        app.launch()
        if !app.buttons["connect.login"].exists { openSettings(app) }
        login("Alice", app)
        XCTAssertTrue(app.buttons["music.source.Spotify"].waitForExistence(timeout: 20))
        app.buttons["music.source.Spotify"].tap()
        XCTAssertTrue(app.buttons["music.playlist.fixture-playlist"].waitForExistence(timeout: 20))
        app.buttons["music.playlist.fixture-playlist"].tap()
        XCTAssertTrue(app.staticTexts["Alice streaming track"].waitForExistence(timeout: 10))
        let data = try Data(contentsOf: URL(string: "http://127.0.0.1:8791/__mobile_music_downloaded")!)
        let runID = try XCTUnwrap((JSONSerialization.jsonObject(with: data) as? [String: String])?["runID"])
        // A completed import must replace the currently open service playlist,
        // without navigating to the separate publication receipt.
        XCTAssertTrue(app.staticTexts["Acquired spotify recording"].waitForExistence(timeout: 40))
        XCTAssertFalse(app.staticTexts["Alice streaming track"].exists)
        app.terminate(); app.launch()
        if app.navigationBars.buttons["BackButton"].waitForExistence(timeout: 5) { app.navigationBars.buttons["BackButton"].tap() }
        if app.navigationBars.buttons["BackButton"].exists { app.navigationBars.buttons["BackButton"].tap() }
        for (provider, remoteID) in [("Spotify", "fixture-playlist"), ("SoundCloud", "soundcloud:playlists:123")] {
            XCTAssertTrue(app.buttons["music.source.\(provider)"].waitForExistence(timeout: 20))
            XCTAssertFalse(app.staticTexts["Published \(provider.lowercased()) copy"].exists)
            app.buttons["music.source.\(provider)"].tap()
            XCTAssertTrue(app.buttons["music.playlist.\(remoteID)"].waitForExistence(timeout: 20))
            XCTAssertTrue(app.images["music.downloaded.\(remoteID)"].exists)
            XCTAssertFalse(app.buttons["music.download.\(remoteID)"].exists)
            XCTAssertFalse(app.staticTexts["1 tracks · Downloaded"].exists)
            app.buttons["music.playlist.\(remoteID)"].tap()
            let trackID = "downloaded-\(provider.lowercased())-\(runID):track"
            let bpm = app.staticTexts["track.bpm.\(trackID)"]
            XCTAssertTrue(bpm.waitForExistence(timeout: 10))
            XCTAssertEqual(bpm.label, "128.0")
            XCTAssertEqual(app.staticTexts["track.key.\(trackID)"].label, "8A")
            XCTAssertFalse(app.buttons["music.playlist.retry"].exists)
            capture(app, "\(provider) original playlist with acquired analysis")
            app.navigationBars.buttons["BackButton"].tap()
            app.navigationBars.buttons["BackButton"].tap()
        }
        openSettings(app)
        app.buttons["connect.logout"].tap()
    }

    private func openSettings(_ app: XCUIApplication) {
        for _ in 0..<5 {
            if app.navigationBars.buttons["BackButton"].exists { app.navigationBars.buttons["BackButton"].tap() }
            else if app.navigationBars.buttons["BackButton"].exists { app.navigationBars.buttons["BackButton"].tap() }
            else { break }
        }
        openSidebar(app, destination: "library.drawer.settings")
        app.buttons["library.drawer.settings"].tap()
        XCTAssertTrue(app.buttons["connect.login"].waitForExistence(timeout: 5))
    }
    private func openSidebar(_ app: XCUIApplication, destination: String,
                             file: StaticString = #filePath, line: UInt = #line) {
        let menu = app.buttons["library.drawer.open"]
        let ready = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == true AND hittable == true"), object: menu)
        let readyResult = XCTWaiter.wait(for: [ready], timeout: 20)
        if readyResult != .completed { captureSidebarFailure(app, "Sidebar opener unavailable") }
        XCTAssertEqual(readyResult, .completed, file: file, line: line)
        menu.tap()
        let visible = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == true AND hittable == true"), object: app.buttons[destination])
        let visibleResult = XCTWaiter.wait(for: [visible], timeout: 5)
        if visibleResult != .completed { captureSidebarFailure(app, "Sidebar missing after one tap") }
        XCTAssertEqual(visibleResult, .completed, "Sidebar destination must appear after one tap", file: file, line: line)
    }
    private func captureSidebarFailure(_ app: XCUIApplication, _ name: String) {
        capture(app, name)
        let evidence = XCTAttachment(string: app.debugDescription)
        evidence.name = name + " accessibility"; evidence.lifetime = .keepAlways; add(evidence)
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
        XCTAssertTrue(app.buttons["connect.done"].waitForNonExistence(timeout: 20), "Login dismisses settings: \(app.staticTexts["connect.error"].exists ? app.staticTexts["connect.error"].label : app.debugDescription)")
        XCTAssertTrue(app.buttons["library.drawer.open"].waitForExistence(timeout: 20), "Login returns to the native library")
    }
    private func capture(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot()); attachment.name = name; attachment.lifetime = .keepAlways; add(attachment)
    }
}

#endif

#if os(iOS)
import XCTest

@MainActor
final class DJLinkUITests: XCTestCase {
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
        let connect = app.buttons["djlink.connect"]
        XCTAssertTrue(connect.waitForExistence(timeout: 5))
        XCTAssertFalse(connect.isEnabled, "Demo audio must never be advertised to hardware")
        app.buttons["Refresh connections"].tap()
        XCTAssertFalse(app.staticTexts["djlink.error"].exists, "The C bridge must return decoded interface data")
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "iPhone DJ Link connection"
        screenshot.lifetime = .keepAlways
        add(screenshot)
        app.buttons["Done"].tap()
        XCTAssertTrue(sidebar.waitForExistence(timeout: 5))
    }
}
#endif

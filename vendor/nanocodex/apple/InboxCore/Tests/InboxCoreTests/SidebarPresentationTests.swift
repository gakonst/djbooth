import XCTest
@testable import InboxCore

final class SidebarPresentationTests: XCTestCase {
    func testManualDoneDoesNotChangeRunningStatusOrHistory() throws {
        var card = AgentCard(id: "agent", title: "Running work")
        try card.apply(state: .object(["agent_id": .string("agent"), "latest_event_cursor": .string("1"),
                                     "active_turns": .array([.string("running")])]))
        card.applyPresentation(.object(["done": .bool(true), "doneAt": .number(123)]))
        XCTAssertTrue(card.done); XCTAssertEqual(card.doneAt, 123)
        XCTAssertTrue(card.isRunning); XCTAssertEqual(card.activeTurns, ["running"])
        XCTAssertEqual(card.latestCursor, Cursor(rawValue: "1"))
        card.applyPresentation(.object(["status": .string("running"), "updatedAt": .number(200)]))
        XCTAssertTrue(card.done, "Execution updates without manual metadata must not reopen sessions")
        card.applyPresentation(.object(["done": .bool(false), "doneAt": .null, "updatedAt": .number(300)]))
        XCTAssertFalse(card.done); XCTAssertNil(card.doneAt); XCTAssertTrue(card.isRunning)
    }

    func testDoneSessionsAreExcludedFromNavigationUnlessExplicitlyFocused() {
        var done = AgentCard(id: "done", title: "Done", updatedAt: Date().timeIntervalSince1970 * 1000)
        done.done = true
        let active = AgentCard(id: "active", title: "Active", updatedAt: done.updatedAt)
        func projection(focused: String?) -> InboxRosterProjection {
            .init(cards: [done, active], focusedID: focused, opened: [], closed: [], tabOrder: [], pinnedID: nil,
                  filter: .all, seen: [:], deferred: [:])
        }
        XCTAssertEqual(projection(focused: "active").resolve().eligible, ["active"])
        XCTAssertTrue(projection(focused: "done").resolve().eligible.contains("done"), "Done filter can still open saved history")
    }

    func testDoneReceiptRejectsDelayedPresentationAndRoster() {
        var card = AgentCard(id: "agent", title: "Work")
        card.applyPresentation(.object(["revision": .number(5), "updatedAt": .number(100), "status": .string("running"),
                                       "done": .bool(false), "doneAt": .null]))
        var stale = card
        card.applyDoneReceipt(done: true, doneAt: 200, presentationRevision: 6)
        card.applyPresentation(.object(["revision": .number(5), "updatedAt": .number(150), "status": .string("running"),
                                       "done": .bool(false), "doneAt": .null]))
        XCTAssertTrue(card.done)
        card.mergeDone(from: stale)
        XCTAssertTrue(card.done)
        card.applyDoneReceipt(done: false, doneAt: nil, presentationRevision: 7)
        stale.applyPresentation(.object(["revision": .number(6), "updatedAt": .number(200), "status": .string("running"),
                                        "done": .bool(true), "doneAt": .number(200)]))
        card.mergeDone(from: stale)
        XCTAssertFalse(card.done)
        card.applyPresentation(.object(["revision": .number(6), "updatedAt": .number(200), "done": .bool(true), "doneAt": .number(200)]))
        XCTAssertFalse(card.done)
        card.applyPresentation(.object(["revision": .number(8), "updatedAt": .number(300), "done": .bool(true), "doneAt": .number(300)]))
        XCTAssertTrue(card.done)
        card.applyPresentation(.object(["updatedAt": .number(400), "done": .bool(false)]))
        XCTAssertTrue(card.done, "Unversioned old deliveries cannot cross a revision fence")
    }

    func testOlderTurnCannotSupplyCurrentActivity() {
        var card = AgentCard(id: "agent", title: "Fix sidebar")
        card.checked = true; card.status = "Running"; card.activeTurns = ["new"]
        card.presentationActivity = "I'm checking old work"; card.presentationTurnID = "old"
        XCTAssertEqual(card.sidebarActivity, "Working")
    }
    func testLatestPromptIsOptionalVersionedAndDoesNotRenameManualTitle() {
        var card = AgentCard(id: "agent", title: "My manual name")
        card.applyPresentation(.object([
            "status": .string("running"), "updatedAt": .number(200),
            "lastUserPrompt": .string("Check the mobile navigation")
        ]))
        XCTAssertEqual(card.sidebarLastUserPrompt, "Check the mobile navigation")
        XCTAssertEqual(card.title, "My manual name")
        XCTAssertTrue(card.isRunningInSidebar)
        card.applyPresentation(.object([
            "status": .string("idle"), "updatedAt": .number(100),
            "lastUserPrompt": .string("Older prompt")
        ]))
        XCTAssertEqual(card.sidebarLastUserPrompt, "Check the mobile navigation")
        XCTAssertTrue(card.isRunningInSidebar)
        card.applyPresentation(.object(["status": .string("completed"), "updatedAt": .number(300)]))
        XCTAssertEqual(card.sidebarLastUserPrompt, "")
        XCTAssertFalse(card.isRunningInSidebar)
    }

    func testLocalPromptWinsUntilNewerPresentationArrives() {
        var card = AgentCard(id: "agent", title: "Manual title")
        card.applyPresentation(.object(["status": .string("running"), "updatedAt": .number(100), "lastUserMessageAt": .number(100), "lastUserPrompt": .string("Old prompt")]))
        card.noteSubmittedPrompt("New local prompt", at: 200)
        XCTAssertEqual(card.sidebarLastUserPrompt, "New local prompt")
        card.applyPresentation(.object(["status": .string("running"), "updatedAt": .number(250), "lastUserMessageAt": .number(100), "lastUserPrompt": .string("Old prompt")]))
        XCTAssertEqual(card.sidebarLastUserPrompt, "New local prompt")
        XCTAssertEqual(card.lastUserMessageAt, 200)
        card.applyPresentation(.object(["status": .string("running"), "updatedAt": .number(300), "lastUserMessageAt": .number(300), "lastUserPrompt": .string("New remote prompt")]))
        XCTAssertEqual(card.sidebarLastUserPrompt, "New remote prompt")
        XCTAssertEqual(card.title, "Manual title")
    }

    func testNewRosterActivityWinsOverPreviouslyCheckedTurn() {
        var card = AgentCard(id: "agent", title: "Agent")
        card.checked = true; card.activeTurns = ["previous"]
        card.applyPresentation(.object([
            "status": .string("stopping"), "updatedAt": .number(200),
            "activeTurnIds": .array([.string("current")]), "activityTurnId": .string("current"),
            "activity": .string("Finishing the current operation")
        ]))
        XCTAssertTrue(card.isRunningInSidebar)
        XCTAssertEqual(card.sidebarActivity, "Finishing the current operation")
        card.applyPresentation(.object([
            "status": .string("completed"), "updatedAt": .number(300), "activeTurnIds": .array([])
        ]))
        XCTAssertFalse(card.isRunningInSidebar)
        XCTAssertEqual(card.sidebarActivity, "")
    }

}

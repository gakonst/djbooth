import Foundation
import XCTest
@testable import InboxCore

final class AgentThreadNotificationTests: XCTestCase {
    private func thread(_ id: String, turn: String = "run", status: String = "Running", text: String = "Working") -> AgentThreadNotification {
        .init(id: id, revision: status + ":" + turn, title: id, subtitle: status, body: text, isRunning: status == "Running", kind: status == "Ready" ? .response : status == "Delivery" ? .delivery : .status,
              deliveryIDs: status == "Delivery" ? Set(turn.split(separator: ",").map(String.init)) : [])
    }
    func testRunningProgressAndHistoricalOutcomesStaySilent() {
        var ledger = AgentNotificationLedger()
        let threads = (0..<100).map { thread("agent-\($0)") }
        let old = thread("old", status: "Ready")
        XCTAssertEqual(ledger.reconcile(threads + [old], retaining: []), [])
        XCTAssertEqual(threads.filter { ledger.shouldPublish($0, foreground: false) }.count, 0)
        XCTAssertFalse(ledger.shouldPublish(old, foreground: false))
        XCTAssertFalse(ledger.shouldPublish(threads[0], foreground: true))
        XCTAssertFalse(ledger.shouldPublish(threads[0], foreground: false))
        XCTAssertFalse(ledger.shouldPublish(threads[1], foreground: false))
        let ready = thread("agent-1", status: "Ready")
        XCTAssertTrue(ledger.shouldPublish(ready, foreground: false))
        XCTAssertFalse(ledger.shouldPublish(ready, foreground: true))
        ledger.didPublish(ready)
        XCTAssertFalse(ledger.shouldPublish(thread("agent-1", status: "Ready", text: "Updated excerpt"), foreground: false))
        XCTAssertFalse(ledger.shouldPublish(thread("agent-1", turn: "next", status: "Ready"), foreground: false))
        _ = ledger.reconcile([thread("agent-1", turn: "next")], retaining: [])
        XCTAssertTrue(ledger.shouldPublish(thread("agent-1", turn: "next", status: "Ready"), foreground: false))
    }
    func testDismissalSurvivesRelaunchAndProgressButNewWorkCanNotify() throws {
        var ledger = AgentNotificationLedger()
        _ = ledger.reconcile([thread("a")], retaining: [])
        let ready = thread("a", status: "Ready")
        ledger.didPublish(ready); ledger.dismiss(id: "a", revision: ready.revision)
        ledger = try JSONDecoder().decode(AgentNotificationLedger.self, from: JSONEncoder().encode(ledger))
        XCTAssertFalse(ledger.shouldPublish(ready, foreground: false))
        _ = ledger.reconcile([thread("a", turn: "next-run")], retaining: [])
        XCTAssertFalse(ledger.shouldPublish(thread("a", turn: "next-run"), foreground: false))
        XCTAssertTrue(ledger.shouldPublish(thread("a", turn: "next-run", status: "Ready"), foreground: false))
        XCTAssertFalse(String(decoding: try JSONEncoder().encode(ledger), as: UTF8.self).contains("Working"))
    }
    // iOS delivery needs Simulator coverage; these persisted-policy regressions
    // catch relaunch and observation races independently of OS scheduling.
    func testFailuresAndForegroundOutcomesCannotNotifyLater() throws {
        var ledger = AgentNotificationLedger()
        _ = ledger.reconcile([thread("failed"), thread("visible")], retaining: [])
        let failed = thread("failed", status: "Failed")
        XCTAssertFalse(ledger.shouldPublish(failed, foreground: false))
        _ = ledger.reconcile([failed], retaining: ["visible"])
        let ready = thread("visible", status: "Ready")
        _ = ledger.reconcile([ready], retaining: ["failed"], foreground: true)
        ledger = try JSONDecoder().decode(AgentNotificationLedger.self, from: JSONEncoder().encode(ledger))
        XCTAssertFalse(ledger.shouldPublish(ready, foreground: false))
        XCTAssertFalse(ledger.shouldPublish(thread("failed", turn: "retry", status: "Ready"), foreground: false))
    }
    func testDeliveryFailureNotifiesOnceWithoutAnActiveTurn() throws {
        var ledger = AgentNotificationLedger()
        let delivery = thread("a", turn: "message-1", status: "Delivery")
        _ = ledger.reconcile([delivery], retaining: [])
        XCTAssertTrue(ledger.shouldPublish(delivery, foreground: false))
        XCTAssertFalse(ledger.shouldPublish(delivery, foreground: true))
        ledger.didPublish(delivery)
        ledger = try JSONDecoder().decode(AgentNotificationLedger.self, from: JSONEncoder().encode(ledger))
        XCTAssertFalse(ledger.shouldPublish(delivery, foreground: false))
        XCTAssertEqual(ledger.reconcile([], retaining: []), ["a"])
    }
    func testShrinkingFailedSetDoesNotRepeatAndNewFailureCanNotify() {
        var ledger = AgentNotificationLedger()
        let both = thread("a", turn: "one,two", status: "Delivery")
        ledger.didPublish(both)
        XCTAssertFalse(ledger.shouldPublish(thread("a", turn: "two", status: "Delivery"), foreground: false))
        XCTAssertTrue(ledger.shouldPublish(thread("a", turn: "two,three", status: "Delivery"), foreground: false))
    }
    func testLateDismissalCannotRearmForegroundDelivery() throws {
        var ledger = AgentNotificationLedger()
        let old = thread("a", turn: "one", status: "Delivery")
        let next = thread("a", turn: "two", status: "Delivery")
        ledger.didPublish(old)
        _ = ledger.reconcile([next], retaining: [], foreground: true)
        ledger.dismiss(id: "a", revision: old.revision)
        ledger = try JSONDecoder().decode(AgentNotificationLedger.self, from: JSONEncoder().encode(ledger))
        XCTAssertFalse(ledger.shouldPublish(next, foreground: false))
    }
    func testFailedFollowupDoesNotConsumeObservedRemoteCompletion() {
        var ledger = AgentNotificationLedger()
        _ = ledger.reconcile([thread("a")], retaining: [])
        var delivery = thread("a", turn: "followup", status: "Delivery")
        delivery = .init(id: delivery.id, revision: delivery.revision, title: delivery.title,
                         subtitle: delivery.subtitle, body: delivery.body, isRunning: true,
                         kind: .delivery, deliveryIDs: delivery.deliveryIDs)
        _ = ledger.reconcile([delivery], retaining: [], foreground: true)
        XCTAssertTrue(ledger.shouldPublish(thread("a", status: "Ready"), foreground: false))
        ledger.didPublish(delivery)
        XCTAssertTrue(ledger.shouldPublish(thread("a", status: "Ready"), foreground: false))
    }
    func testRealProjectionRetainsDeliveryReceiptDuringRetry() throws {
        var card = AgentCard(id: "a", title: "Report")
        card.checked = true; card.status = "Idle"
        var message = PendingMessage(agentID: "a", input: "Private request", predecessor: "", id: "message")
        message.phase = .failed
        var ledger = AgentNotificationLedger()
        let failed = try XCTUnwrap(AgentThreadNotification.make(cards: [card], seen: [:], deferred: [:], pending: [message]).first)
        _ = ledger.reconcile([failed], retaining: [])
        ledger.didPublish(failed)
        message.phase = .submitting
        let retrying = AgentThreadNotification.make(cards: [card], seen: [:], deferred: [:], pending: [message])
        _ = ledger.reconcile(retrying, retaining: [])
        XCTAssertTrue(retrying.allSatisfy { !ledger.shouldPublish($0, foreground: false) })
        message.phase = .failed
        let again = try XCTUnwrap(AgentThreadNotification.make(cards: [card], seen: [:], deferred: [:], pending: [message]).first)
        _ = ledger.reconcile([again], retaining: [])
        XCTAssertFalse(ledger.shouldPublish(again, foreground: false))
        _ = ledger.reconcile([], retaining: [])
        XCTAssertTrue(ledger.handledDeliveries.isEmpty)
    }
    func testForegroundCompletionMaskedByDeliveryDoesNotNotifyLater() {
        var ledger = AgentNotificationLedger()
        _ = ledger.reconcile([thread("a")], retaining: [])
        _ = ledger.reconcile([thread("a", turn: "followup", status: "Delivery")], retaining: [], foreground: true)
        XCTAssertFalse(ledger.shouldPublish(thread("a", status: "Ready"), foreground: false))
    }
    func testUncheckedRestorationRetainsReceiptsAndVerifiedRemovalCleansOnlyThatThread() {
        var ledger = AgentNotificationLedger()
        let a = thread("a", status: "Ready"), b = thread("b", status: "Ready")
        _ = ledger.reconcile([a, b], retaining: [])
        ledger.didPublish(a); ledger.didPublish(b)
        XCTAssertEqual(ledger.reconcile([], retaining: ["a", "b"]), [])
        XCTAssertEqual(ledger.reconcile([b], retaining: []), ["a"])
        XCTAssertNil(ledger.published["a"])
        XCTAssertNotNil(ledger.published["b"])
    }
    func testLateDismissalCannotHideNewTurn() {
        var ledger = AgentNotificationLedger()
        let old = thread("a", status: "Ready"), new = thread("a", turn: "new", status: "Ready")
        _ = ledger.reconcile([old], retaining: [])
        ledger.didPublish(old); ledger.didPublish(new); ledger.dismiss(id: "a", revision: old.revision)
        XCTAssertNil(ledger.dismissed["a"])
    }
    func testDeliveryIdentityDoesNotChangeWithBackgroundAgentTurns() throws {
        var card = AgentCard(id: "a", title: "Draft report")
        card.checked = true; card.activeTurns = ["first"]
        var message = PendingMessage(agentID: "a", input: "Private message", predecessor: "", id: "message")
        message.phase = .failed
        let first = try XCTUnwrap(AgentThreadNotification.make(cards: [card], seen: [:], deferred: [:], pending: [message]).first)
        card.activeTurns = ["retry"]
        let retry = try XCTUnwrap(AgentThreadNotification.make(cards: [card], seen: [:], deferred: [:], pending: [message]).first)
        XCTAssertEqual(first.kind, .delivery)
        XCTAssertEqual(first.revision, retry.revision)
        var ledger = AgentNotificationLedger()
        XCTAssertTrue(ledger.shouldPublish(first, foreground: false))
        ledger.didPublish(first)
        XCTAssertFalse(ledger.shouldPublish(retry, foreground: false))
    }
    func testThreadProjectionKeepsIdentitiesExcerptsAndQueueSeparate() throws {
        var a = AgentCard(id: "a", title: "Fix reconnect")
        a.activeTurns = ["run-a"]; a.checked = true
        var b = AgentCard(id: "b", title: "Review docs")
        b.activeTurns = ["run-b"]; b.checked = true
        var queued = PendingMessage(agentID: "a", input: "Private input", predecessor: "run-a")
        queued.phase = .queued
        let threads = AgentThreadNotification.make(cards: [a, b], seen: [:], deferred: [:], pending: [queued])
        XCTAssertEqual(Set(threads.map(\.id)), ["a", "b"])
        XCTAssertTrue(threads.first(where: { $0.id == "a" })!.body.contains("1 queued follow-up."))
        XCTAssertFalse(threads.first(where: { $0.id == "b" })!.body.contains("queued"))
        XCTAssertTrue(threads.allSatisfy { !$0.body.contains("Private input") && $0.subtitle == "Running when last checked" })
        XCTAssertNotEqual(threads[0].fingerprint, threads[1].fingerprint)
    }
}

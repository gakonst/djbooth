import Foundation
import CryptoKit

/// One native notification per conversation. Reuse the bounded, user-facing
/// projection without putting other agents or private outbox input in the body.
public struct AgentThreadNotification: Equatable, Sendable, Identifiable {
    public enum Kind: Equatable, Sendable { case status, response, delivery }

    public let id: String
    public let revision: String
    public let title: String
    public let subtitle: String
    public let body: String
    public let isRunning: Bool
    public var kind: Kind = .status
    public var deliveryIDs: Set<String> = []
    public var pendingDeliveryIDs: Set<String> = []

    public var fingerprint: String {
        let data = (try? JSONEncoder().encode([revision, title, subtitle, body])) ?? Data()
        return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    public static func make(cards: [AgentCard], seen: [String: Cursor], deferred: [String: Cursor],
                            pending: [PendingMessage]) -> [Self] {
        let messages = Dictionary(grouping: pending, by: \.agentID)
        return cards.sorted(by: AgentCard.mostRecentFirst).compactMap { card in
            let outbox = messages[card.id] ?? []
            let snapshot = AgentActivitySnapshot.make(cards: [card], seen: seen, deferred: deferred,
                                                      paused: true, pending: outbox)
            let pendingIDs = Set(outbox.map(\.id))
            guard let entry = snapshot.entries.first, !entry.id.isEmpty else {
                // Retain retry receipts while an idle/read thread temporarily has
                // no visible outcome. This bookkeeping entry can never notify.
                guard !pendingIDs.isEmpty, !card.id.isEmpty, card.id.utf8.count <= 256 else { return nil }
                return Self(id: card.id, revision: "pending", title: "", subtitle: "", body: "",
                            isRunning: card.isRunning, pendingDeliveryIDs: pendingIDs)
            }
            let phase: String
            switch entry.status {
            case "delivery": phase = "Delivery unconfirmed"
            case "failed": phase = "Turn failed"
            case "ready": phase = "Response ready"
            default: phase = "Running when last checked"
            }
            let turn = card.activeTurns.first ?? "outcome-" + card.outcomeCursor.rawValue
            let deliveryIDs = Set(outbox.filter { $0.phase == .failed }.map(\.id))
            let delivery = deliveryIDs.sorted().joined(separator: ",")
            // A background turn changing must not re-alert for the same unsent message.
            let revision = entry.status == "delivery" ? "delivery:" + delivery : entry.status + ":" + turn
            let kind: Kind = entry.status == "delivery" ? .delivery :
                entry.status == "ready" && card.checked && card.error == nil ? .response : .status
            var body = entry.detail
            if let queued = entry.queued, queued > 0 {
                body += "\n\(queued) queued \(queued == 1 ? "follow-up" : "follow-ups")."
            }
            if card.isRunning { body += "\nOpen for current status." }
            return Self(id: card.id, revision: revision, title: entry.title,
                        subtitle: phase, body: body, isRunning: card.isRunning, kind: kind, deliveryIDs: deliveryIDs, pendingDeliveryIDs: pendingIDs)
        }
    }
}

/// Persist only IDs and hashes. Clearing a thread suppresses its current phase
/// across polling and relaunch. A response consumes its observed run; delivery
/// failures are identified by message, independently of background agent turns.
public struct AgentNotificationLedger: Codable, Sendable {
    public struct Receipt: Codable, Sendable {
        public var revision: String
        public var fingerprint: String
    }
    public private(set) var tracked = Set<String>()
    public private(set) var published: [String: Receipt] = [:]
    public private(set) var dismissed: [String: String] = [:]
    public private(set) var handledDeliveries: [String: Set<String>] = [:]
    public init() {}

    public mutating func reconcile(_ threads: [AgentThreadNotification], retaining unchecked: Set<String>, foreground: Bool = false) -> Set<String> {
        let allowed = Set(threads.map(\.id)).union(unchecked)
        let removed = tracked.union(published.keys).union(dismissed.keys).union(handledDeliveries.keys).subtracting(allowed)
        tracked.formIntersection(allowed)
        published = published.filter { allowed.contains($0.key) }
        dismissed = dismissed.filter { allowed.contains($0.key) }
        let pendingIDs = Dictionary(uniqueKeysWithValues: threads.map {
            ($0.id, $0.pendingDeliveryIDs.union($0.deliveryIDs))
        })
        handledDeliveries = handledDeliveries.compactMapValues { $0.isEmpty ? nil : $0 }
        for (id, ids) in handledDeliveries where !unchecked.contains(id) {
            let remaining = ids.intersection(pendingIDs[id] ?? [])
            handledDeliveries[id] = remaining.isEmpty ? nil : remaining
        }
        tracked.formUnion(threads.filter(\.isRunning).map(\.id))
        for thread in threads {
            if thread.kind == .delivery {
                // Delivery of a follow-up is independent of the running turn.
                if foreground {
                    handledDeliveries[thread.id, default: []].formUnion(thread.deliveryIDs)
                    if !thread.isRunning { tracked.remove(thread.id) }
                }
            } else if !thread.isRunning && (foreground || thread.kind == .status) {
                // An outcome already visible in-app must not become a late alert.
                tracked.remove(thread.id)
                dismissed[thread.id] = thread.revision
            }
        }
        return removed
    }

    public func shouldPublish(_ thread: AgentThreadNotification, foreground: Bool) -> Bool {
        !foreground && thread.kind != .status
            && (thread.kind == .delivery
                ? !thread.deliveryIDs.isSubset(of: handledDeliveries[thread.id] ?? [])
                : !thread.isRunning && tracked.contains(thread.id))
            && dismissed[thread.id] != thread.revision
            && published[thread.id]?.revision != thread.revision
    }

    public mutating func didPublish(_ thread: AgentThreadNotification) {
        if thread.kind == .delivery {
            handledDeliveries[thread.id, default: []].formUnion(thread.deliveryIDs)
        } else { tracked.remove(thread.id) }
        dismissed[thread.id] = nil
        published[thread.id] = Receipt(revision: thread.revision, fingerprint: thread.fingerprint)
    }

    public mutating func dismiss(id: String, revision: String) {
        // Late callbacks for older notifications must not suppress newer work.
        guard published[id]?.revision == revision, dismissed[id] == nil || dismissed[id] == revision else { return }
        dismissed[id] = revision
    }
}

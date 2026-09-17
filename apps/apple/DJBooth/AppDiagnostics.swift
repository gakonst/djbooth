#if os(iOS)
import Foundation
import DJBoothKit
import MetricKit
import UIKit

/// Apple lifecycle/MetricKit adapters only. Rust owns logging, retention and all
/// DJ Link traffic capture. No credentials or account objects enter this API.
final class AppDiagnostics: NSObject, MXMetricManagerSubscriber, @unchecked Sendable {
    static let shared = AppDiagnostics()
    private let queue = DispatchQueue(label: "xyz.gakonst.djbooth.diagnostics", qos: .utility)
    private let watchdog = DispatchQueue(label: "xyz.gakonst.djbooth.watchdog", qos: .utility)
    @MainActor private var started = false
    // Heartbeat state is confined to watchdog, independent of diagnostic I/O.
    private var timer: DispatchSourceTimer?
    private var foreground = false
    private var pendingHeartbeat = false
    private var sentAt: TimeInterval = 0
    private var stalled = false
    private var heartbeatGeneration = 0
    // Confined to the diagnostics queue.
    private var initialized = false

    @MainActor func start() {
        guard !started else { return }
        started = true
        let app = ["version": Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?",
                   "build": Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "?",
                   "os": ProcessInfo.processInfo.operatingSystemVersionString]
        let root = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("DJBooth/Diagnostics", isDirectory: true)
        queue.async {
            guard !self.initialized else { return }
            do {
                try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
                var values = URLResourceValues(); values.isExcludedFromBackup = true
                var directory = root; try directory.setResourceValues(values)
                let args: [String: Any] = ["root": root.path, "session": UUID().uuidString, "app": app]
                _ = try DJLinkBindings.request("diagnostics.initialize", arguments: JSONSerialization.data(withJSONObject: args))
                self.initialized = true
                self.write("app_started", [:])
                self.watchdog.async {
                    let timer = DispatchSource.makeTimerSource(queue: self.watchdog)
                    timer.schedule(deadline: .now() + 1, repeating: 1, leeway: .milliseconds(200))
                    timer.setEventHandler { [weak self] in self?.heartbeat() }
                    self.timer = timer; timer.resume()
                }
            } catch { NSLog("[Diagnostics] initialization failed: %@", error.localizedDescription) }
        }
        #if DEBUG && targetEnvironment(simulator)
        if ProcessInfo.processInfo.arguments.contains("--diagnostics-stall-probe") {
            DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
                self.event("stall_probe_started")
                Thread.sleep(forTimeInterval: 5)
            }
        }
        #endif
        MXMetricManager.shared.add(self)
        for payload in MXMetricManager.shared.pastDiagnosticPayloads ?? [] { saveMetric(payload.jsonRepresentation(), kind: "diagnostic") }
        NotificationCenter.default.addObserver(self, selector: #selector(active), name: UIApplication.didBecomeActiveNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(inactive), name: UIApplication.willResignActiveNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(background), name: UIApplication.didEnterBackgroundNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(memoryWarning), name: UIApplication.didReceiveMemoryWarningNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(terminating), name: UIApplication.willTerminateNotification, object: nil)
        phase(UIApplication.shared.applicationState == .active ? "active" : "inactive", active: UIApplication.shared.applicationState == .active)
    }
    @objc private func active() { phase("active", active: true) }
    @objc private func inactive() { phase("inactive", active: false) }
    @objc private func background() { phase("background", active: false) }
    @objc private func memoryWarning() { event("memory_warning") }
    @objc private func terminating() { phase("termination_notification", active: false) }
    private func phase(_ name: String, active: Bool) {
        watchdog.async {
            self.foreground = active
            self.heartbeatGeneration += 1
            self.pendingHeartbeat = false; self.stalled = false
        }
        event("lifecycle", ["phase": name])
        if !active { queue.async { _ = try? DJLinkBindings.request("diagnostics.flush") } }
    }
    func ready() async {
        await withCheckedContinuation { continuation in queue.async { continuation.resume() } }
    }
    static func failureFields(_ error: Error) -> [String: String] {
        if error is CancellationError { return ["failure": "cancelled"] }
        if let client = error as? ClientError, case let .http(status, _) = client {
            return ["failure": [401, 403].contains(status) ? "authorization" : status == 429 ? "rate_limit" : "http", "http_status": String(status)]
        }
        let value = error as NSError
        if value.domain == NSURLErrorDomain {
            return ["failure": value.code == NSURLErrorTimedOut ? "timeout" : "transport", "error_code": String(value.code)]
        }
        return ["failure": "internal"]
    }
    func event(_ name: String, _ fields: [String: String] = [:]) {
        var observed = fields
        observed["observed_time_ms"] = String(Int(Date().timeIntervalSince1970 * 1000))
        observed["observed_uptime_ms"] = String(Int(ProcessInfo.processInfo.systemUptime * 1000))
        let values = observed
        queue.async { self.write(name, values) }
    }
    private func write(_ name: String, _ fields: [String: String]) {
        guard initialized else { return }
        do {
            let args: [String: Any] = ["name": name, "fields": fields]
            _ = try DJLinkBindings.request("diagnostics.event", arguments: JSONSerialization.data(withJSONObject: args))
        } catch { NSLog("[Diagnostics] event failed: %@", error.localizedDescription) }
    }
    private func heartbeat() {
        guard foreground else { return }
        let now = ProcessInfo.processInfo.systemUptime
        if pendingHeartbeat {
            if !stalled && now - sentAt >= 3 {
                stalled = true
                event("main_thread_stall", ["duration_ms": String(Int((now - sentAt) * 1000))])
                queue.async { _ = try? DJLinkBindings.request("diagnostics.flush") }
            }
            return
        }
        pendingHeartbeat = true; sentAt = now
        let generation = heartbeatGeneration
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.watchdog.async {
                guard generation == self.heartbeatGeneration else { return }
                if self.stalled { self.event("main_thread_recovered", ["duration_ms": String(Int((ProcessInfo.processInfo.systemUptime - self.sentAt) * 1000))]) }
                self.pendingHeartbeat = false; self.stalled = false
            }
        }
    }
    func didReceive(_ payloads: [MXDiagnosticPayload]) {
        for payload in payloads { saveMetric(payload.jsonRepresentation(), kind: "diagnostic") }
    }
    func didReceive(_ payloads: [MXMetricPayload]) {
        for payload in payloads { saveMetric(payload.jsonRepresentation(), kind: "metrics") }
    }
    private func saveMetric(_ data: Data, kind: String) {
        queue.async {
            do {
                // Original payload retains Apple's timestamps, app version and
                // binary UUIDs: delayed reports may refer to an earlier build.
                let payload = try JSONSerialization.jsonObject(with: data)
                let envelope: [String: Any] = ["kind": kind, "payload": payload]
                _ = try DJLinkBindings.request("diagnostics.metric", arguments: JSONSerialization.data(withJSONObject: envelope))
                self.write("metrickit_received", ["kind": kind])
                _ = try DJLinkBindings.request("diagnostics.flush")
            } catch { NSLog("[Diagnostics] MetricKit persistence failed: %@", error.localizedDescription) }
        }
    }
}
#endif

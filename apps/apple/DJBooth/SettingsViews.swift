import SwiftUI
import DJBoothKit

struct ConnectionSettings: View {
    @Bindable var model: BoothModel
    @Environment(\.dismiss) private var dismiss
    @State private var cloudURL = ""
    @State private var token = ""
    @State private var workstationURL = ""
    @State private var runtime = DesktopRuntime()
    @State private var connecting = false
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Label("Music lives on this device first", systemImage: "checkmark.shield")
                    Text("Your library, collections, and downloaded audio stay available offline. Cloud sync carries changes between your devices.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Section("Cloud library") {
                    Text(model.syncStatus).font(.caption).foregroundStyle(.secondary)
                    Button("Sync now") { Task { await model.synchronize() } }
                        .disabled(model.cloudURL.isEmpty || model.syncing || model.demo)
                    TextField("https://your-library.workers.dev", text: $cloudURL).autocorrectionDisabled()
                    SecureField("Sync token", text: $token)
                    Button("Connect cloud library") {
                        connecting = true
                        Task {
                            defer { connecting = false }
                            do { try await model.configureCloud(url: cloudURL, token: token); token = ""; dismiss() }
                            catch { model.message = error.localizedDescription }
                        }
                    }.disabled(cloudURL.isEmpty || token.isEmpty || model.demo || connecting)
                    if connecting { ProgressView("Opening library…") }
                    Text("Credentials are saved in this device’s Keychain.").font(.caption).foregroundStyle(.secondary)
                }
                if !model.conflicts.isEmpty {
                    Section("Review changes") {
                        ForEach(model.conflicts) { conflict in
                            VStack(alignment: .leading, spacing: 8) {
                                Text(conflictTitle(conflict)).font(.subheadline.weight(.medium))
                                Text("Edited on another device. Choose the version to keep.")
                                    .font(.caption).foregroundStyle(.secondary)
                                Button("Keep this device’s version") { model.resolve(conflict, keepLocal: true) }
                                Button("Use cloud version") { model.resolve(conflict, keepLocal: false) }
                            }.padding(.vertical, 4)
                        }
                    }
                }
                #if os(macOS) || targetEnvironment(simulator)
                Section("Mac library service") {
                    TextField("http://127.0.0.1:4179", text: $workstationURL)
                    Button("Connect to Mac library") {
                        do {
                            _ = try Endpoint(workstationURL, loopbackOnly: true)
                            model.workstationURL = workstationURL
                            UserDefaults.standard.set(workstationURL, forKey: "workstationURL")
                            Task { await model.refreshWorkstation() }
                        } catch { model.message = error.localizedDescription }
                    }
                    #if os(macOS)
                    Button("Start library service") { Task { await runtime.run(["serve", "--no-assistant", "--no-link", "--format", "json"]); await model.refreshWorkstation() } }
                        .disabled(runtime.running || model.demo)
                    if runtime.running { ProgressView("Starting djbooth…") }
                    if let error = runtime.error { Text(error).foregroundStyle(.red).font(.caption) }
                    #endif
                }
                #endif
                Section("Storage") {
                    LabeledContent("Tracks", value: "\(model.tracks.count)")
                    LabeledContent("Available offline", value: "\(model.offlineIDs.count)")
                    LabeledContent("Pending changes", value: "\(model.pendingCount)")
                }
            }.formStyle(.grouped).navigationTitle("Sync & settings")
                .toolbar { Button("Done") { dismiss() } }
                .onAppear { cloudURL = model.cloudURL; workstationURL = model.workstationURL }
        }
        #if os(macOS)
        .frame(minWidth: 560, minHeight: 530)
        #endif
    }
    private func conflictTitle(_ conflict: SyncConflict) -> String {
        let name = model.tracks.first { $0.id == conflict.entityID }?.title
            ?? model.collections.first { $0.id == conflict.entityID }?.name
            ?? conflict.entityID
        let kind = conflict.kind == .annotation ? "Comment & color" : conflict.kind.rawValue.capitalized
        return "\(name) · \(kind)"
    }
}

struct ImportSheet: View {
    @Bindable var model: BoothModel
    @Environment(\.dismiss) private var dismiss
    @State private var source = ""
    @State private var showCloudSettings = false
    @State private var runtime = DesktopRuntime()
    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("Found something good?").font(.title2.bold())
                    Text("Paste a playlist or set link. Cloudflare downloads and analyzes the tracks, then adds them to your cloud library. You can close the app while it runs.").font(.subheadline).foregroundStyle(.secondary)
                    TextField("Paste a playlist or set link", text: $source).autocorrectionDisabled()
                }
                Section {
                    if model.canImportToCloud {
                        Button("Import to cloud library") { Task { await model.submitImport(source) } }
                            .buttonStyle(.borderedProminent)
                            .disabled(source.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.submittingImport)
                            .accessibilityIdentifier("import.submit")
                        if model.submittingImport { ProgressView("Sending request…") }
                    } else {
                        Text("Connect your cloud library to import music.").foregroundStyle(.secondary)
                        Button("Cloud settings") { showCloudSettings = true }
                    }
                    if let error = model.importError { Text(error).font(.caption).foregroundStyle(.red) }
                }
                if !model.importJobs.isEmpty {
                    Section("Imports") {
                        ForEach(model.importJobs) { job in
                            VStack(alignment: .leading, spacing: 8) {
                                Text(job.source).font(.caption).lineLimit(2)
                                Text(job.message).font(.subheadline)
                                if job.isActive {
                                    if job.total > 0 {
                                        ProgressView(value: Double(job.current), total: Double(job.total))
                                        Text("\(job.phase.capitalized) · \(job.current)/\(job.total)").font(.caption).foregroundStyle(.secondary)
                                    } else { ProgressView() }
                                }
                                if job.status == "failed" {
                                    Button("Retry import") { Task { await model.retryImport(job) } }.disabled(model.submittingImport)
                                }
                                if let id = job.collectionID, let collection = model.collections.first(where: { $0.id == id }) {
                                    Button("Open playlist") { model.openCollection(collection); dismiss() }
                                    Button("Keep playlist offline") { Task { await model.keepCollectionOffline(collection) } }
                                }
                            }.padding(.vertical, 4)
                        }
                    }
                }
                #if os(macOS)
                Section("This Mac") {
                    Button("Import locally") {
                        Task { await runtime.run(["import", source.trimmingCharacters(in: .whitespacesAndNewlines), "--progress", "always", "--format", "json"]); await model.refreshWorkstation() }
                    }.disabled(source.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || source.hasPrefix("-") || runtime.running || model.demo)
                    if runtime.running { ProgressView("Importing…") }
                    if let error = runtime.error { Text(error).font(.caption).foregroundStyle(.red) }
                }
                #endif
            }.formStyle(.grouped).navigationTitle("Bring music in").toolbar { Button("Done") { dismiss() } }
                .sheet(isPresented: $showCloudSettings) { ConnectionSettings(model: model) }
                .onAppear { source = model.pendingImportSource }
                .task {
                    while !Task.isCancelled {
                        await model.refreshImports()
                        do { try await Task.sleep(for: .seconds(5)) } catch { return }
                    }
                }
        }
        #if os(macOS)
        .frame(minWidth: 570, minHeight: 410)
        #endif
    }
}

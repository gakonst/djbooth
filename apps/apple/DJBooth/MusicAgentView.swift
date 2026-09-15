import DJBoothKit
import SwiftUI

struct MusicAgentMessage: Identifiable {
    let id = UUID()
    let role: String
    let text: String
}

struct MusicAgentView: View {
    @Bindable var model: BoothModel
    @Environment(\.dismiss) private var dismiss
    @State private var input = ""
    var body: some View {
        NavigationStack {
            VStack(spacing: 12) {
                if model.cloudAccountID == nil {
                    ContentUnavailableView("Connect your music", systemImage: "music.note", description: Text("Sign in with Nanocodex in Sync & settings to use your music agent."))
                    Button("Sync & settings") { dismiss(); model.showSettings = true }
                } else {
                    ScrollViewReader { proxy in
                        ScrollView {
                            LazyVStack(alignment: .leading, spacing: 20) {
                                if model.agentMessages.isEmpty {
                                    Text("Ask about your library, playlists, what's playing, or your downloads. Your agent can look things up in DJ Booth on this phone.").foregroundStyle(.secondary)
                                    ForEach(["What's in my library?", "Which tracks are available offline?", "What's playing and what's next?"], id: \.self) { suggestion in
                                        Button(suggestion) { model.beginAgentTurn(suggestion) }.disabled(!model.phoneToolsReady || model.agentPendingID != nil)
                                    }
                                }
                                ForEach(model.agentMessages) { message in
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text(message.role).font(.caption.bold()).foregroundStyle(.secondary)
                                        Text(.init(message.text)).textSelection(.enabled)
                                    }.frame(maxWidth: .infinity, alignment: .leading).id(message.id)
                                }
                            }.padding()
                        }.onChange(of: model.agentMessages.count) { _, _ in
                            if let last = model.agentMessages.last { proxy.scrollTo(last.id, anchor: .bottom) }
                        }
                    }
                    HStack {
                        Image(systemName: model.phoneToolsReady ? "iphone.gen3.radiowaves.left.and.right" : "iphone.gen3")
                        Text(model.phoneToolsReady ? "Connected to this phone · Can read your library and app state" : (model.phoneToolsError ?? "Connecting to this phone…"))
                            .accessibilityIdentifier("agent.phoneStatus")
                    }.font(.caption).foregroundStyle(.secondary).padding(.horizontal)
                    if model.phoneToolsError != nil {
                        Button("Reconnect Nanocodex") { dismiss(); model.showSettings = true }
                    }
                    if let error = model.agentError {
                        Text(error).font(.caption).foregroundStyle(.red).padding(.horizontal).accessibilityIdentifier("agent.error")
                        if model.agentPendingID != nil { Button("Retry") { model.agentRetry += 1 } }
                    }
                    if model.agentPendingID != nil {
                        HStack {
                            ProgressView("Your agent is working…")
                            Spacer()
                            Button("Stop") { Task { await model.cancelAgentTurn() } }.accessibilityIdentifier("agent.stop")
                        }.padding(.horizontal)
                    }
                    HStack(alignment: .bottom) {
                        TextField("Ask about your library or app…", text: $input, axis: .vertical)
                            .lineLimit(1...5).textFieldStyle(.roundedBorder).accessibilityIdentifier("agent.input")
                        Button("Send") {
                            model.beginAgentTurn(input)
                            input = ""
                        }.disabled(input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || input.count > 16000 || model.agentPendingID != nil || !model.phoneToolsReady)
                            .accessibilityIdentifier("agent.send")
                    }.padding()
                }
            }.navigationTitle("DJ Booth agent")
                .toolbar { Button("Done") { dismiss() }.accessibilityIdentifier("agent.done") }
                .task(id: "\(model.cloudAccountID ?? ""): \(model.agentPendingID ?? ""): \(model.agentRetry)") { await model.observeAgentTurn() }
        }
        #if os(macOS)
        .frame(minWidth: 560, minHeight: 530)
        #endif
    }
}

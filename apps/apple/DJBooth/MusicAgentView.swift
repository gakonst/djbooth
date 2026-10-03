import DJBoothKit
import NanocodexConnectEmbed
import SwiftUI

/// The library's companion surface; the account-bound agent owns the conversation.
struct MusicAgentView: View {
    @Bindable var model: BoothModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    #if os(iOS)
    @State private var composing = false
    @State private var composerOverflows = false
    @State private var nativeScroll = EmbedScrollProxy()
    @State private var nativeScrolling = false
    @State private var nativeNearLatest = true
    #else
    @FocusState private var composing: Bool
    #endif
    @State private var followingLatest = true
    @State private var didScrollInitially = false

    var body: some View {
        VStack(spacing: 0) {
            header
            if model.hasCloudSession || model.demo {
                conversation
                composer
            } else {
                ContentUnavailableView("Your music companion", systemImage: "wand.and.stars",
                    description: Text("Connect Nanocodex to pick up your DJ Booth conversation."))
                Button("Connect Nanocodex", action: openSettings).buttonStyle(.borderedProminent).padding(.bottom, 32)
            }
        }
        .background(BoothStyle.background.ignoresSafeArea())
        .tint(BoothStyle.accent).preferredColorScheme(.dark)
        .task(id: "\(model.accountConnectionID):\(model.agentPendingID ?? ""):\(scenePhase)") {
            guard scenePhase == .active else { return }
            await model.loadAgentHistory()
        }
        .task(id: model.agentDraft) {
            do { try await Task.sleep(for: .milliseconds(300)); model.persistAgentConversation() } catch {}
        }
        .onDisappear { model.persistAgentConversation() }
        #if os(macOS)
        .frame(minWidth: 560, minHeight: 620)
        #endif
    }

    private var header: some View {
        HStack(spacing: 12) {
            Button { close() } label: {
                Image(systemName: "chevron.left").font(.system(size: 17, weight: .medium))
                    .frame(width: 36, height: 44)
            }.accessibilityLabel("Back to music").accessibilityIdentifier("agent.done")
            avatar(size: 36)
            VStack(alignment: .leading, spacing: 3) {
                Text("Booth").font(.system(size: 19, weight: .semibold, design: .rounded))
                Text("Your music companion").font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            if model.agentHistoryLoading { ProgressView().controlSize(.small).accessibilityLabel("Loading conversation") }
        }
        .padding(.leading, 6).padding(.trailing, 20).padding(.vertical, 10)
        .background(BoothStyle.surface)
        .overlay(alignment: .bottom) { Rectangle().fill(BoothStyle.border).frame(height: 0.5) }
    }

    @ViewBuilder private var conversation: some View {
        #if os(iOS)
        if #available(iOS 18.0, *) {
            nativeConversation
        } else {
            scrollConversation
        }
        #else
        scrollConversation
        #endif
    }

    private var scrollConversation: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 24) {
                    if model.agentNextBefore != nil || model.agentHistoryError != nil {
                        historyControls {
                            let anchor = model.agentMessages.first?.id
                            Task {
                                await model.loadAgentHistory(earlier: true)
                                if let anchor { proxy.scrollTo(anchor, anchor: .top) }
                            }
                        }
                    }
                    if model.agentMessages.isEmpty && !model.agentHistoryLoading { welcome }
                    ForEach(model.agentMessages) { message in
                        messageRow(message).id(message.id)
                    }
                    if model.agentPendingID != nil {
                        working
                    }
                    Color.clear.frame(height: 1).id("latest")
                        .onAppear { followingLatest = true }
                        .onDisappear { followingLatest = false }
                }
                .frame(maxWidth: 720).frame(maxWidth: .infinity)
                .padding(.horizontal, 22).padding(.vertical, 24)
            }
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: model.agentMessages.last?.id) { _, _ in
                if followingLatest || !didScrollInitially {
                    proxy.scrollTo("latest", anchor: .bottom); didScrollInitially = true
                }
            }
            .onAppear {
                if !model.agentMessages.isEmpty {
                    proxy.scrollTo("latest", anchor: .bottom); didScrollInitially = true
                }
            }
            .overlay(alignment: .bottomTrailing) {
                if !followingLatest && !model.agentMessages.isEmpty {
                    latestButton { proxy.scrollTo("latest", anchor: .bottom) }.padding(16)
                }
            }
        }
    }

    // Transport, receipts, history paging, consent, and errors remain with BoothModel.
    // The SDK owns row virtualization and reading-position restoration on iOS 18.
    #if os(iOS)
    @available(iOS 18.0, *)
    private var nativeConversation: some View {
        EmbedTranscript(rows: nativeRows, proxy: nativeScroll, followsLatest: followingLatest,
                        layout: .init(maximumRowWidth: 720, horizontalPadding: 22,
                                      rowSpacing: 24, verticalPadding: 24),
                        onMetrics: { metrics in
            let nearLatest = metrics.contentSize.height - metrics.contentOffset.y
                - metrics.containerSize.height + metrics.contentInsets.bottom <= 24
            nativeNearLatest = nearLatest
            if !nativeScrolling && nearLatest { followingLatest = true }
        }, onPhase: { _, phase in
            nativeScrolling = phase == .tracking || phase == .interacting || phase == .decelerating
            if nativeScrolling { followingLatest = false }
            else if nativeNearLatest { followingLatest = true }
        })
        .id(model.accountConnectionID)
        .overlay(alignment: .bottomTrailing) {
            if !followingLatest && !model.agentMessages.isEmpty {
                latestButton {
                    followingLatest = true
                    nativeScroll.followLatest(animated: true)
                }.padding(16)
            }
        }
    }

    @available(iOS 18.0, *)
    private var nativeRows: [EmbedTranscript.Row] {
        var rows: [EmbedTranscript.Row] = []
        if model.agentNextBefore != nil || model.agentHistoryError != nil {
            let historyRevision = [model.agentNextBefore ?? "", model.agentHistoryError ?? "",
                                   String(model.agentHistoryLoading), String(model.agentHistoryNeedsConsent)]
            rows.append(.init(id: "history", countsAsMessage: false, revision: historyRevision) {
                historyControls {
                    followingLatest = false
                    let anchor = model.agentMessages.first?.id
                    Task {
                        await model.loadAgentHistory(earlier: true)
                        if let anchor { nativeScroll.scrollTo("message:" + anchor) }
                    }
                }
            })
        }
        if model.agentMessages.isEmpty && !model.agentHistoryLoading {
            rows.append(.init(id: "welcome", countsAsMessage: false, revision: model.agentPendingID ?? "") { welcome })
        }
        for message in model.agentMessages {
            rows.append(.init(id: "message:" + message.id, revision: [message.role, message.text]) {
                messageRow(message)
            })
        }
        if let pending = model.agentPendingID {
            rows.append(.init(id: "working", countsAsMessage: false, revision: pending) { working })
        }
        rows.append(.init(id: "latest", countsAsMessage: false, revision: 0) { Color.clear.frame(height: 1) })
        return rows
    }
    #endif

    private func historyControls(loadEarlier: @escaping () -> Void) -> some View {
        VStack(alignment: .leading, spacing: 24) {
            if model.agentNextBefore != nil {
                Button(action: loadEarlier) {
                    Label("Earlier messages", systemImage: "arrow.up").font(.caption.weight(.medium))
                        .frame(maxWidth: .infinity).padding(.vertical, 8)
                }.disabled(model.agentHistoryLoading).accessibilityIdentifier("agent.earlier")
            }
            if let error = model.agentHistoryError {
                VStack(alignment: .leading, spacing: 8) {
                    Text(error).font(.caption).foregroundStyle(.secondary)
                    if model.agentHistoryNeedsConsent {
                        Button("Allow this conversation", action: openSettings)
                    } else {
                        Button("Retry history") { Task { await model.loadAgentHistory() } }
                    }
                }.font(.caption.weight(.medium)).padding(14)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(BoothStyle.surface, in: RoundedRectangle(cornerRadius: 14))
            }
        }
    }

    private var working: some View {
        HStack(spacing: 10) {
            ProgressView().controlSize(.small)
            Text("Booth is working…").font(.subheadline).foregroundStyle(.secondary)
        }.padding(.vertical, 4).accessibilityIdentifier("agent.working")
    }

    private func latestButton(action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label("Latest", systemImage: "arrow.down").font(.caption.weight(.semibold))
                .padding(.horizontal, 14).padding(.vertical, 10)
                .background(BoothStyle.raised, in: Capsule())
                .overlay(Capsule().stroke(BoothStyle.border))
        }
    }

    private var welcome: some View {
        VStack(alignment: .leading, spacing: 18) {
            avatar(size: 60).padding(.top, 28)
            Text("A little help\nbehind the decks.")
                .font(.system(size: 32, weight: .semibold, design: .rounded)).tracking(-0.8)
            Text("Find your next track, shape a playlist, or bring something new into your library.")
                .font(.body).foregroundStyle(.secondary).lineSpacing(4)
            VStack(spacing: 10) {
                suggestion("Find something to play", detail: "A fresh angle on your library", icon: "sparkles",
                           prompt: "Look through my library and suggest something to play next.")
                suggestion("Build a set with me", detail: "Start with a mood and a direction", icon: "music.note.list",
                           prompt: "Help me plan a set from my library. Ask me about the mood first.")
                suggestion("Bring in new music", detail: "Playlists, tracks, and discoveries", icon: "arrow.down.circle",
                           prompt: "Help me import some new music. What can I bring in?")
            }.padding(.top, 10)
            Label("Only this conversation is shared with DJ Booth.", systemImage: "lock")
                .font(.caption).foregroundStyle(.secondary).padding(.top, 6)
        }.padding(.bottom, 16)
    }

    private func suggestion(_ title: String, detail: String, icon: String, prompt: String) -> some View {
        Button { followingLatest = true; model.beginAgentTurn(prompt) } label: {
            HStack(spacing: 14) {
                Image(systemName: icon).font(.system(size: 18)).foregroundStyle(BoothStyle.accent).frame(width: 24)
                VStack(alignment: .leading, spacing: 4) {
                    Text(title).font(.subheadline.weight(.medium)).foregroundStyle(.primary)
                    Text(detail).font(.caption).foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
                Image(systemName: "arrow.up.right").font(.caption).foregroundStyle(.secondary)
            }.padding(16).background(BoothStyle.surface, in: RoundedRectangle(cornerRadius: 16))
                .overlay(RoundedRectangle(cornerRadius: 16).stroke(BoothStyle.border, lineWidth: 0.5))
        }.buttonStyle(.plain).disabled(model.agentPendingID != nil)
    }

    private func messageRow(_ message: MusicAgentMessage) -> some View {
        HStack(alignment: .top, spacing: 10) {
            if message.role == "You" { Spacer(minLength: 32) }
            else if message.role != "Status" { avatar(size: 26) }
            VStack(alignment: .leading, spacing: 7) {
                if message.role == "DJ Booth" { Text("Booth").font(.caption.weight(.semibold)).foregroundStyle(BoothStyle.accent) }
                if message.role == "DJ Booth" {
                    EmbedMarkdown(text: message.text, compact: true)
                } else {
                    Text(.init(message.text)).font(message.role == "Status" ? .caption : .body)
                        .foregroundStyle(message.role == "Status" ? .secondary : .primary)
                        .lineSpacing(4).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(message.role == "You" ? 14 : 0)
            .background(message.role == "You" ? BoothStyle.accent.opacity(0.13) : .clear,
                        in: RoundedRectangle(cornerRadius: 18))
            if message.role != "You" { Spacer(minLength: 0) }
        }.frame(maxWidth: .infinity, alignment: message.role == "You" ? .trailing : .leading)
    }

    private var composer: some View {
        VStack(spacing: 10) {
            if let error = model.agentError {
                HStack {
                    Text(error).font(.caption).foregroundStyle(.red).accessibilityIdentifier("agent.error")
                    if model.agentPendingID != nil { Button("Retry") { model.agentRetry += 1 }.font(.caption.bold()) }
                }
            }
            HStack(alignment: .bottom, spacing: 12) {
                #if os(iOS)
                EmbedComposerEditor(text: $model.agentDraft, focused: $composing,
                                    overflowing: $composerOverflows, visibleLines: 6,
                                    accessibilityLabel: "Ask Booth…")
                    .padding(.vertical, 2).accessibilityIdentifier("agent.input")
                    .overlay(alignment: .topLeading) {
                        if model.agentDraft.isEmpty {
                            Text("Ask Booth…").foregroundStyle(.secondary).padding(.vertical, 10)
                                .allowsHitTesting(false).accessibilityHidden(true)
                        }
                    }
                #else
                TextField("Ask Booth…", text: $model.agentDraft, axis: .vertical)
                    .font(.body).lineLimit(1...6).textFieldStyle(.plain).focused($composing)
                    .padding(.vertical, 10).accessibilityIdentifier("agent.input")
                #endif
                if model.agentPendingID != nil {
                    Button { Task { await model.cancelAgentTurn() } } label: {
                        Image(systemName: "stop.fill").font(.system(size: 13, weight: .semibold)).frame(width: 38, height: 38)
                    }.background(BoothStyle.raised, in: Circle()).accessibilityLabel("Stop")
                        .accessibilityIdentifier("agent.stop")
                } else {
                    Button { followingLatest = true; model.beginAgentTurn(model.agentDraft); composing = false } label: {
                        Image(systemName: "arrow.up").font(.system(size: 17, weight: .semibold))
                            .foregroundStyle(BoothStyle.background).frame(width: 38, height: 38)
                            .background(BoothStyle.accent, in: Circle())
                    }.disabled(model.agentDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.agentDraft.count > 16000)
                        .accessibilityLabel("Send").accessibilityIdentifier("agent.send")
                }
            }.padding(8).padding(.leading, 8)
                .background(BoothStyle.surface, in: RoundedRectangle(cornerRadius: 26))
                .overlay(RoundedRectangle(cornerRadius: 26).stroke(BoothStyle.border))
            Text(model.phoneToolsReady ? "Connected to your library" : "Your conversation stays with your account")
                .font(.system(size: 11)).foregroundStyle(.secondary).accessibilityIdentifier("agent.phoneStatus")
        }.frame(maxWidth: 720).frame(maxWidth: .infinity)
            .padding(.horizontal, 16).padding(.top, 12).padding(.bottom, 10)
            .background(BoothStyle.background)
    }

    private func avatar(size: CGFloat) -> some View {
        Image(systemName: "wand.and.stars").font(.system(size: size * 0.43, weight: .medium))
            .foregroundStyle(BoothStyle.accent).frame(width: size, height: size)
            .background(BoothStyle.accent.opacity(0.12), in: RoundedRectangle(cornerRadius: size * 0.32))
    }
    private func close() { model.persistAgentConversation(); model.showAgent = false; dismiss() }
    private func openSettings() { close(); model.showSettings = true }
}

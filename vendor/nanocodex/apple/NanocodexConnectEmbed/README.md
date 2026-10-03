# Nanocodex Connect Embed for Apple apps

`NanocodexConnectEmbed` is the native SwiftUI presentation package for iOS 17+
and macOS 14+. `EmbedTranscript` requires iOS 18+ because its scroll-phase
contract uses SwiftUI `ScrollPhase`. Its availability is checked by the compiler.
The transcript, scroll contracts, cell visibility, and composer editor are
iOS-only UIKit components. The composer and shared rendering components support
iOS 17; iOS 17 hosts keep their existing scroll container. Markdown, generated media, latest
screen, and live screen components are also available on macOS; Mac hosts keep
their own scroll container and editor.
The Nanocodex iPhone/iPad app consumes this same package. It contains the app's
virtualized UIKit/SwiftUI transcript engine and composes the public
`NanocodexUI` and `NanocodexRemote` rendering contracts. It requires no React,
JavaScript runtime, or web view.

The host owns conversation state, Connect authorization, HTTP/SSE, message
submission, delivery receipts, attachments, tool decisions, and navigation.
The package does not create a connection or send a message when rendered.
Pass each update into rows with stable IDs and a changed revision, and supply
native views for messages, tools, approvals, errors, and retry controls.

## Add the package

With this repository checked out alongside the host app, add
`apple/NanocodexConnectEmbed` as a local Swift package in Xcode, or use a local
SwiftPM dependency:

```swift
.package(path: "../nanocodex/apple/NanocodexConnectEmbed")
// In the consuming target's dependencies:
.product(name: "NanocodexConnectEmbed", package: "NanocodexConnectEmbed")
```

Keep the sibling `NanocodexUI`, `NanocodexRemote`, and `InboxCore` directories;
the package uses their public products through relative dependencies. The
repository root is not a remote SwiftPM manifest. This local source package
is not a separately published Swift package URL. Use the app's supported
Xcode/Swift version in [mobile dependencies](../MOBILE_DEPENDENCIES.md).

## Compose a conversation

```swift
import SwiftUI
import NanocodexConnectEmbed

struct EmbedMessage: Identifiable {
    let id: String
    let revision: Int
    let text: String
}

@available(iOS 18.0, *)
@MainActor
struct EmbeddedConversation: View {
    let conversationID: String
    let messages: [EmbedMessage]
    let canSend: Bool
    let onSend: (String) -> Void
    @State private var scroll = EmbedScrollProxy()
    @State private var followsLatest = true
    @State private var draft = ""
    @State private var focused = false
    @State private var overflowing = false

    var body: some View {
        VStack(spacing: 0) {
            EmbedTranscript(
                rows: messages.map { message in
                    EmbedTranscript.Row(id: message.id, revision: message.revision) {
                        EmbedMarkdown(text: message.text, compact: true)
                    }
                },
                proxy: scroll,
                followsLatest: followsLatest,
                layout: .init(horizontalPadding: 16, rowSpacing: 12),
                onPhase: { _, phase in
                    if phase == .tracking || phase == .interacting { followsLatest = false }
                }
            )
            .id(conversationID)
            if !followsLatest {
                Button("Latest") {
                    followsLatest = true
                    scroll.followLatest(animated: true)
                }
            }
            HStack(alignment: .bottom) {
                EmbedComposerEditor(text: $draft, focused: $focused,
                                    overflowing: $overflowing)
                Button("Send") { onSend(draft) }
                    .disabled(!canSend || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }.padding()
        }
    }
}
```

The host should retain or clear the draft according to its delivery policy and
mount a distinct conversation view/proxy for each thread (for example
`EmbeddedConversation(...).id(conversationID)`). Disabling Send and surfacing
admission errors remain host responsibilities. No automatic submission or
retry is performed by the composer.

`Row` accepts any SwiftUI content; a Markdown row is only one example. IDs must
be unique within a transcript. Change `revision` for every input affecting a
row, including tool disclosure state and authorization changes. Unchanged rows
retain hosted state during streaming and diffable snapshots. `countsAsMessage`
only controls debug render counts; set it to false for status/header/footer rows.

`EmbedTranscriptLayout` defaults to no padding, spacing, or maximum width.
The host controls chrome and colors. `topInset` and `bottomInset` reserve room
for floating UI. `onFrames` reports realized visible rows relative to the usable
top edge; `EmbedScrollProxy.scrollTo(_:topOffset:)` restores that same coordinate.
`onMetrics` exposes native content offset, size, viewport, and adjusted insets.

For expensive row media, read `@Environment(\.embedTranscriptVisible)` and pass
it as `loadsThumbnail` to `EmbedImageAttachment` or `EmbedGeneratedOutputView`.
Recycled cells stop reporting visibility without changing their row identity.
The aliases retain the underlying `NanocodexUI` initializers, URL handlers,
image-paste callbacks, accessibility identifiers, and native media previews.

## Screens

`EmbedLatestScreen` displays the latest captured screen using the existing
`ChatLatestScreen` API. Its optional `onWatchLive` callback lets the host opt in
to a live viewer. `EmbedLiveScreen` accepts a conversation identity, an
`EmbedRemoteService`, bindings for `EmbedScreenSelection?` and expansion, and
`onClose` / `onControls` callbacks. Changing conversation identity destroys the
old viewer; expanding the same conversation preserves its connection. The
underlying viewer suspends when inactive and closes when removed.

Live screens use the existing `NanocodexRemote` account hand transport at
`/v1/account/hands`. A Connect grant alone does not establish access to those
routes. Include the live component only when the host already has an authorized
`RemoteService`; authentication stays in that service's private request closure.
The embed is view-only; the host presents separately authorized interactive
controls when `onControls` is invoked. Closing a viewer does not close the
host's shared `RemoteService`.

## Validation

The shipped consumer is `apple/NanocodexInbox.xcodeproj`; its UI journeys cover
streamed Markdown and tools, history prepend/restore, composer draft retention,
bounded mounted cells, and screen lifecycle. Run them on an existing iOS
Simulator through the repository's shared-machine guard:

```sh
scripts/xcodebuild-guard.sh test \
  -project apple/NanocodexInbox.xcodeproj -scheme NanocodexInbox \
  -destination "platform=iOS Simulator,id=$SIMULATOR_UDID" \
  -only-testing:NanocodexInboxUITests/InboxUITests/testStreamingMarkdownAndToolProgressShareTimeline \
  -only-testing:NanocodexInboxUITests/InboxUITests/testNativeHistoryWindowCrossesEventAndByteBudgetsAndReturnsToLiveTail \
  -only-testing:NanocodexInboxUITests/InboxUITests/testConversationComposerKeepsReadingPositionAndSharesDraft \
  -only-testing:NanocodexInboxUITests/InboxUITests/testNativeTranscriptBoundsMountedCellsFor500Rows \
  -only-testing:NanocodexInboxUITests/InboxUITests/testThreadScreenDockPreservesDraftAndThreadNavigation \
  -resultBundlePath output/connect-embed-native.xcresult
```

On Linux, `python3 apple/scripts/prepare-xtool.py --configuration debug`
(with Pillow installed) checks the Xcode inputs and generates the real xtool
package graph, including this package. Run `python3 apple/scripts/test-ios-linux.py`
for the packaging journey, including missing-package failure and staging recovery.
`build-ios-linux.sh` consumes this generated graph through `apple/Package.swift`;
there is no separate native module list to maintain. Staging is not Swift compilation,
simulator execution, or signing. A stock Linux host cannot run the UIKit/
SwiftUI UI journeys; they still require the Apple toolchain and iOS runtime.

#if os(iOS)
import SwiftUI
import UIKit

/// Guides an OS setting; address discovery and the DJ Link connection stay in Rust.
struct DJLinkWiredSetupView: View {
    @Bindable var link: DJLinkConnection
    @Environment(\.openURL) private var openURL
    @State private var savedInterface: DJLinkInterface?
    @State private var copiedField: String?
    @State private var settingsUnavailable = false

    var body: some View {
        Form {
            Section {
                Text("Skip the address wait").font(.title2.bold())
                Text("On a direct CDJ connection, iPhone can spend about 20 seconds asking for an automatic address. Saving a manual wired address may avoid that wait on future connections.")
                Text("Optional · Set up once for this wired connection")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Section("1. Connect once") {
                Text("Connect your phone to the CDJ and wait for a deck to appear. Keep the cable connected while you change Settings.")
                if let interface = savedInterface {
                    copyRow("IP Address", value: interface.ip, id: "ip")
                    copyRow("Subnet Mask", value: interface.netmask, id: "mask")
                    LabeledContent("Router", value: "Leave empty")
                    Text("These values came from your phone’s working CDJ connection. Use them only for this connection.")
                        .font(.caption).foregroundStyle(.secondary)
                } else {
                    Label("Waiting for a direct CDJ connection", systemImage: "cable.connector")
                        .accessibilityIdentifier("djlink.wiredSetup.waiting")
                    Text("Your address will appear here after a deck connects. Keep automatic addressing if this network uses a router to assign addresses.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            Section("2. Save the address in iPhone Settings") {
                Text("Open Settings, then go back to its main screen. Choose Ethernet → your connected adapter → Configure IP → Manual.")
                Text("Enter the IP Address and Subnet Mask shown above, leave Router empty, then tap Save. Leave Wi-Fi settings unchanged.")
                Button("Open Settings", systemImage: "gearshape") {
                    guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
                    openURL(url) { accepted in settingsUnavailable = !accepted }
                }.disabled(savedInterface == nil)
                    .accessibilityIdentifier("djlink.wiredSetup.settings")
                if settingsUnavailable {
                    Text("Open the Settings app from your Home Screen to continue.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            Section("3. Check your next connection") {
                Text("Return to DJ Booth, unplug and reconnect the cable, and keep the app open. Your decks connect automatically once the wired address is ready.")
                Text("If the wait remains, check that Manual and your saved address are still selected in Ethernet settings.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Section("Switch back anytime") {
                Text("For a different network, or if the connection stops working, return to Settings → Ethernet → your adapter → Configure IP and choose Automatic.")
            }
        }
        .navigationTitle("Faster wired setup")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear { rememberInterface(link.wiredSetupInterface) }
        .onChange(of: link.wiredSetupInterface) { _, interface in rememberInterface(interface) }
    }

    private func rememberInterface(_ interface: DJLinkInterface?) {
        // Keep the current instructions available across the Settings round-trip.
        // Do not persist an address or treat a successful connection as proof
        // that the user changed iOS from DHCP to Manual.
        guard let interface else { return }
        if savedInterface != interface { copiedField = nil; savedInterface = interface }
    }

    private func copyRow(_ title: String, value: String, id: String) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.caption).foregroundStyle(.secondary)
                Text(value).monospaced().textSelection(.enabled)
            }
            Spacer()
            Button(copiedField == id ? "Copied" : "Copy") {
                UIPasteboard.general.setItems([[UIPasteboard.typeAutomatic: value]], options: [.localOnly: true])
                copiedField = id
            }.buttonStyle(.bordered)
                .accessibilityLabel("\(copiedField == id ? "Copied" : "Copy") \(title)")
                .accessibilityIdentifier("djlink.wiredSetup.copy.\(id)")
        }
    }
}
#endif

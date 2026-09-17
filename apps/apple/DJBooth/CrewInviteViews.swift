#if os(iOS)
import CoreImage.CIFilterBuiltins
import DJBoothKit
import SwiftUI

struct CrewInviteView: View {
    let crewName: String
    let invite: CrewInvite
    let endpoint: URL
    @Environment(\.dismiss) private var dismiss
    @State private var copied = false
    private var link: URL { endpoint.appendingPathComponent("join").appendingPathComponent(invite.token) }
    private var qr: UIImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(link.absoluteString.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage,
              let image = CIContext().createCGImage(output.transformed(by: CGAffineTransform(scaleX: 8, y: 8)), from: output.extent.applying(CGAffineTransform(scaleX: 8, y: 8))) else { return nil }
        return UIImage(cgImage: image)
    }
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 22) {
                    Text("Invite to \(crewName)").font(.title2.bold()).multilineTextAlignment(.center)
                    Text("Share playlists. Find your next track together.").foregroundStyle(.secondary).multilineTextAlignment(.center)
                    if let qr {
                        Image(uiImage: qr).interpolation(.none).resizable().scaledToFit()
                            .frame(maxWidth: 240).padding(20).background(.white, in: RoundedRectangle(cornerRadius: 20))
                            .accessibilityLabel("Crew invite QR code").accessibilityIdentifier("crew.invite.qr")
                    }
                    Text("Scan with your iPhone camera to join.").font(.subheadline).foregroundStyle(.secondary)
                    ShareLink(item: link, subject: Text("Join \(crewName) on DJ Booth"), preview: SharePreview("Join \(crewName) on DJ Booth")) {
                        Label("Share invite", systemImage: "square.and.arrow.up").frame(maxWidth: .infinity).padding(.vertical, 6)
                    }.buttonStyle(.borderedProminent).accessibilityIdentifier("crew.invite.share")
                    Text("AirDrop, Messages or your favorite app").font(.caption).foregroundStyle(.secondary)
                    Button {
                        UIPasteboard.general.url = link; copied = true
                    } label: { Label(copied ? "Link copied" : "Copy link", systemImage: copied ? "checkmark" : "link") }
                        .accessibilityIdentifier("crew.invite.copy")
                    Text("One person · \(invite.role == .viewer ? "Can view" : "Can edit") · Expires \(Date(timeIntervalSince1970: Double(invite.expiresAt)).formatted(date: .abbreviated, time: .omitted))")
                        .font(.caption).foregroundStyle(.secondary).multilineTextAlignment(.center)
                }.padding(24)
            }.navigationTitle("Invite to crew").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }.preferredColorScheme(.dark)
    }
}

struct CrewJoinView: View {
    @Bindable var model: BoothModel
    let invite: CrewInviteLink
    @Environment(\.dismiss) private var dismiss
    @State private var preview: CrewInvitePreview?
    @State private var displayName = ""
    @State private var error: String?
    @State private var loading = false
    @State private var joining = false
    @State private var signingIn = false
    @State private var login = ConnectLogin()

    var body: some View {
        NavigationStack {
            Form {
                if let preview {
                    Section {
                        Label(preview.crewName, systemImage: "folder.badge.person.crop").font(.title2.bold())
                        Text("Every playlist in this folder is shared with the crew.")
                        Text(preview.role == .viewer ? "You’ll be able to view the crew’s playlists." : "You’ll be able to add tracks and edit the crew’s playlists.").foregroundStyle(.secondary)
                    }
                    Section("Your name in the crew") {
                        TextField("Your name", text: $displayName).textContentType(.name).autocorrectionDisabled()
                            .accessibilityIdentifier("crew.join.name")
                    }
                    Section {
                        if model.hasCloudSession {
                            Button {
                                joining = true; error = nil
                                Task {
                                    defer { joining = false }
                                    do {
                                        let id = try await model.acceptCrewInvite(invite.token, displayName: displayName.trimmingCharacters(in: .whitespacesAndNewlines))
                                        model.openCrewFolder(id); dismiss()
                                    } catch { self.error = error.localizedDescription }
                                }
                            } label: { HStack { Text("Join crew"); if joining { Spacer(); ProgressView() } } }
                                .disabled(joining || displayName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                                .accessibilityIdentifier("crew.join.confirm")
                        } else {
                            Button {
                                signingIn = true; error = nil
                                Task {
                                    defer { signingIn = false }
                                    do {
                                        let endpoint = try Endpoint(model.crewInviteEndpoint.absoluteString)
                                        let token = try await login.signIn(endpoint: endpoint)
                                        try await model.configureCloud(url: endpoint.url.absoluteString, token: token)
                                    } catch { self.error = error.localizedDescription }
                                }
                            } label: { HStack { Text("Sign in to join"); if signingIn { Spacer(); ProgressView() } } }
                                .disabled(signingIn).accessibilityIdentifier("crew.join.signIn")
                            Text("Sign in with your phone number. Your invite will stay here.").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                } else if loading { ProgressView("Loading invite…") }
                if let error {
                    Section {
                        Text(error).foregroundStyle(.red).accessibilityIdentifier("crew.join.error")
                        if preview == nil { Button("Try again") { Task { await load() } }.disabled(loading) }
                    }
                }
            }.navigationTitle("Join crew").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(joining || signingIn) } }
                .task(id: invite.id) { await load() }
        }.interactiveDismissDisabled(joining || signingIn).preferredColorScheme(.dark)
    }
    private func load() async {
        loading = true; error = nil
        defer { loading = false }
        do { preview = try await CloudClient.previewCrewInvite(invite) }
        catch { self.error = error.localizedDescription }
    }
}
#endif

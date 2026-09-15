import SwiftUI
import UniformTypeIdentifiers
import DJBoothKit

/// Folder authorization only. USB music uses the ordinary library and player.
struct USBLibraryView: View {
    @Bindable var model: BoothModel
    @Environment(\.dismiss) private var dismiss
    @State private var pickingFolder = false
    @State private var selection: URL?
    @State private var failure: String?

    var body: some View {
        NavigationStack {
            Group {
                if model.usbReading {
                    ProgressView("Opening USB library…").frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    ContentUnavailableView {
                        Label(failure == nil ? "Connect your USB library" : "Could not open USB library", systemImage: "externaldrive")
                    } description: {
                        Text(failure ?? "Choose the USB stick’s top-level folder once to grant access. DJ Booth remembers it and reconnects automatically. Your playlists open in the library with the normal player, notes, and colors.")
                    } actions: {
                        Button("Choose USB folder") { chooseFolder() }.accessibilityIdentifier("usb.chooseFolder")
                    }
                }
            }
            .navigationTitle("USB library")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() }.accessibilityIdentifier("usb.done") } }
        }
        .fileImporter(isPresented: $pickingFolder, allowedContentTypes: [.folder]) { result in
            switch result {
            case .success(let root): selection = root
            case .failure(let error): failure = error.localizedDescription
            }
        }
        .task(id: selection) {
            guard let selection else { return }
            do { try await model.connectUSB(selection); if !Task.isCancelled { dismiss() } }
            catch { if !Task.isCancelled { failure = error.localizedDescription } }
            self.selection = nil
        }
        .accessibilityIdentifier("usb.browser")
    }
    private func chooseFolder() {
        #if DEBUG && targetEnvironment(simulator)
        if ProcessInfo.processInfo.arguments.contains("--ui-test-library"),
           let path = ProcessInfo.processInfo.environment["DJBOOTH_TEST_USB_ROOT"] {
            selection = URL(fileURLWithPath: path, isDirectory: true)
            return
        }
        #endif
        pickingFolder = true
    }
}

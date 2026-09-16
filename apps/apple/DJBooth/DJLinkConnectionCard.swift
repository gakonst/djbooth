#if os(iOS)
import SwiftUI
import DJBoothKit

struct DJLinkConnectionCard: View {
    @Bindable var model: BoothModel
    @State private var showingMixer = true
    @State private var showingRecording = false
    private var link: DJLinkConnection { model.djLink }
    private var network: Bool { link.cableDetected || link.busy || link.status.running }
    var body: some View {
        if network || model.usbConnected || model.usbReading {
            VStack(spacing: 0) {
                Button { if network { model.showDJLink = true } else { model.showSettings = true } } label: {
                    HStack(spacing: 10) {
                        Image(systemName: network ? "cable.connector" : "externaldrive")
                            .font(.title3).foregroundStyle(BoothStyle.accent)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(title).boothFont(13, relativeTo: .subheadline, weight: .semibold)
                            Text(detail).boothFont(11, relativeTo: .caption).foregroundStyle(.secondary).lineLimit(2)
                        }.frame(maxWidth: .infinity, alignment: .leading)
                        if network && link.error == nil && (link.status.devices?.isEmpty != false) {
                            ProgressView().controlSize(.small)
                        }
                        Image(systemName: "chevron.right").font(.caption).foregroundStyle(.secondary)
                    }.padding(.horizontal, 14).padding(.vertical, 10)
                        .background(BoothStyle.raised, in: RoundedRectangle(cornerRadius: 12))
                }.buttonStyle(.plain)
                    .accessibilityIdentifier("djlink.connection.card")
                    .accessibilityLabel("\(title). \(detail)")
                if !link.detectedDecks.isEmpty {
                    mixerHeader
                    TimelineView(.periodic(from: .now, by: 1)) { _ in
                        mixerRows
                    }
                }
            }.background(BoothStyle.raised, in: RoundedRectangle(cornerRadius: 12))
                .padding(.horizontal, 10).padding(.vertical, 6)
                .background(BoothStyle.background)
        }
    }
    private var mixerHeader: some View {
        HStack {
            Button { showingMixer.toggle() } label: {
                Label("Mixer", systemImage: showingMixer ? "chevron.down" : "chevron.right")
                    .frame(minHeight: 32)
            }.accessibilityIdentifier("djlink.mixer.toggle")
            Spacer()
            Button { showingRecording = true } label: {
                Label(link.recording.isRecording ? "Recording" : "Record", systemImage: link.recording.isRecording ? "record.circle.fill" : "record.circle")
                    .foregroundStyle(link.recording.isRecording ? .red : BoothStyle.accent)
            }.accessibilityIdentifier("recording.open")
                .sheet(isPresented: $showingRecording) {
                    NavigationStack {
                        BoothRecordingView(model: model)
                            .toolbar { Button("Done") { showingRecording = false } }
                    }
                }
            if link.mixers.count > 1 {
                Menu(link.selectedMixer?.event.source_ip ?? "Select mixer") {
                    ForEach(link.mixers.keys.sorted(), id: \.self) { ip in
                        Button(ip) { link.selectedMixerIP = ip }
                    }
                }
            }
            Text("Tap CH to match your wiring").foregroundStyle(.secondary)
        }.boothFont(10, relativeTo: .caption2).buttonStyle(.plain)
            .padding(.horizontal, 14)
    }
    private var mixerRows: some View {
        let now = ProcessInfo.processInfo.systemUptime
        let mixer = link.selectedMixer
        let crossfader = link.mixerPercent("crossfader.position", networkValue: mixer.flatMap { $0.isFresh(at: now) ? $0.event.mixer.crossfader : nil })
        return VStack(spacing: 4) {
            ScrollView(.vertical) {
                VStack(spacing: 0) {
                    ForEach(link.detectedDecks) { device in
                        VStack(spacing: 0) {
                            DJLinkDeckPlayerRow(model: model, device: device,
                                deck: link.decks.first { $0.id == device.player })
                            if showingMixer { mixerRow(device, mixer: mixer, now: now) }
                        }
                    }
                }
            }.frame(height: CGFloat(min(link.detectedDecks.count, 2)) * (showingMixer ? 150 : 84))
                .accessibilityIdentifier("djlink.mixer.rows")
            if showingMixer {
            HStack(spacing: 8) {
                Text(!link.midiMixers.isEmpty ? "DJM-A9 · USB MIDI" : mixer == nil ? "Waiting for mixer data" : (mixer?.isFresh(at: now) == true ? "DJM-A9" : "Mixer signal lost"))
                    .foregroundStyle(.secondary)
                Spacer()
                Text("Crossfader")
                GeometryReader { geometry in
                    Capsule().fill(.white.opacity(0.12)).frame(height: 3).frame(maxHeight: .infinity)
                    if let crossfader {
                        Capsule().fill(BoothStyle.accent).frame(width: 3, height: 12)
                            .offset(x: (geometry.size.width - 3) * crossfader / 100)
                    }
                }.frame(width: 48, height: 12)
                    .accessibilityLabel("Crossfader")
                    .accessibilityValue(crossfader.map { "\(Int($0.rounded())) percent from left" } ?? "Unavailable")
            }.boothFont(10, relativeTo: .caption2).padding(.horizontal, 14).padding(.bottom, 10)
            }
        }
    }
    private func mixerRow(_ device: DJLinkStatus.Device, mixer: DJLinkMixerObservation?, now: TimeInterval) -> some View {
        let channelNumber = link.mixerChannel(for: device.player)
        let channel = mixer?.channel(channelNumber, at: now)
        func value(_ control: String, _ networkValue: UInt8?) -> Double? {
            guard let channelNumber else { return nil }
            return link.mixerPercent("channel.\(channelNumber).\(control)", networkValue: networkValue)
        }
        let selected = !link.showingPhonePlayer && link.selectedDeck?.id == device.player
        return HStack(spacing: 5) {
            VStack(alignment: .leading, spacing: 0) {
                Button {
                    link.showingPhonePlayer = false
                    link.selectedPlayer = device.player
                } label: {
                    Text("Deck \(device.player)").fontWeight(selected ? .bold : .regular)
                        .foregroundStyle(selected ? BoothStyle.accent : .primary).frame(minHeight: 30)
                }.accessibilityIdentifier("djlink.deck.\(device.player)")
                Menu {
                    Button("Unassigned") { link.assignMixerChannel(nil, to: device.player) }
                    ForEach(1...4, id: \.self) { channel in
                        Button("Channel \(channel)") { link.assignMixerChannel(channel, to: device.player) }
                    }
                } label: {
                    Text(channelNumber.map { "CH \($0) ⌄" } ?? "CH — ⌄").foregroundStyle(.secondary).frame(minHeight: 28)
                }.accessibilityLabel("Mixer channel for deck \(device.player)")
                    .accessibilityIdentifier("djlink.channel.\(device.player)")
            }.boothFont(10, relativeTo: .caption2).frame(width: 57, alignment: .leading)
            mixerControl("Trim", value: value("trim", channel?.trim), player: device.player)
            mixerControl("High", value: value("eq.high", channel?.eq_high), player: device.player)
            mixerControl("Mid", value: value("eq.mid", channel?.eq_mid), player: device.player)
            mixerControl("Low", value: value("eq.low", channel?.eq_low), player: device.player)
            mixerControl("Color", value: value("color", channel?.color), player: device.player)
            mixerControl("Fader", value: value("fader", channel?.fader), player: device.player, fader: true)
        }.buttonStyle(.plain).padding(.horizontal, 10).frame(height: 66)
            .background(selected ? Color.white.opacity(0.035) : .clear)
            .accessibilityElement(children: .contain).accessibilityIdentifier("djlink.mixer.row.\(device.player)")
    }
    private func mixerControl(_ label: String, value: Double?, player: Int, fader: Bool = false) -> some View {
        VStack(spacing: 3) {
            Text(label).foregroundStyle(.secondary)
            ZStack {
                if fader {
                    Capsule().fill(.white.opacity(0.15)).frame(width: 3, height: 18)
                    if let value {
                        Capsule().fill(BoothStyle.accent).frame(width: 13, height: 3)
                            .offset(y: 8 - value / 100 * 16)
                    }
                } else {
                    Circle().stroke(.white.opacity(0.18), lineWidth: 2).frame(width: 18, height: 18)
                    if let value {
                        Capsule().fill(BoothStyle.accent).frame(width: 2, height: 8).offset(y: -4)
                            .rotationEffect(.degrees(value / 100 * 270 - 135))
                    }
                }
            }.frame(height: 20)
            Text(value.map { "\(Int($0.rounded()))%" } ?? "—")
                .monospacedDigit().foregroundStyle(value == nil ? .secondary : .primary)
        }.boothFont(9, relativeTo: .caption2).frame(maxWidth: .infinity)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Deck \(player) \(label)")
            .accessibilityValue(value.map { "\(Int($0.rounded())) percent" } ?? "Unavailable")
            .accessibilityIdentifier("djlink.mixer.\(player).\(label.lowercased())")
    }
    private var title: String {
        if !network { return model.usbReading ? "Reading USB library…" : "USB library connected" }
        if link.error != nil { return "CDJ connection needs attention" }
        let count = link.status.devices?.filter { (1...6).contains($0.player) }.count ?? 0
        if count > 0 { return count == 1 ? "CDJ connected" : "\(count) decks connected" }
        return link.status.running ? "Finding decks…" : "Cable detected"
    }
    private var detail: String {
        if !network { return model.usbDevice?.name ?? "Your USB music is available" }
        if let error = link.error { return error }
        if let devices = link.status.devices, !devices.isEmpty {
            return devices.map { "\($0.model) · Player \($0.player)" }.joined(separator: "  •  ")
        }
        return link.status.running ? "Connecting automatically" : "Starting your CDJ connection…"
    }
}

/// One normal waveform renderer and cache per deck; no protocol or clock reducer.
private struct DJLinkDeckPlayerRow: View {
    @Bindable var model: BoothModel
    let device: DJLinkStatus.Device
    let deck: DJLinkDeck?
    @State private var cache = PlaybackWaveformCache()
    private var track: Track? { deck?.presentationTrack(in: model.tracksByID) }
    private var display: PlaybackDisplay { PlaybackDisplay(track: track, deck: deck?.state) }
    var body: some View {
        VStack(spacing: 3) {
            Button {
                model.djLink.selectedPlayer = device.player
                model.djLink.showingPhonePlayer = false
            } label: {
                HStack(spacing: 6) {
                    Text("Deck \(device.player)").fontWeight(.semibold)
                    Text(track?.title ?? (deck == nil ? "Waiting for status" : "No track loaded")).lineLimit(1)
                    Spacer(minLength: 0)
                    Text(deck?.state.effective_bpm_hundreds.map { String(format: "%.1f BPM", Double($0) / 100) } ?? "— BPM")
                    Text(display.key ?? "—").accessibilityHint(display.keyHint)
                }
            }.buttonStyle(.plain).accessibilityIdentifier("djlink.deck.select.\(device.player)")
            if let deck {
                PlaybackWaveform(player: model.player, display: display, cache: cache,
                                 accessibilityID: "djlink.deck.waveform.\(device.player)")
                    .frame(height: 40)
                HStack {
                    Text(deck.state.tempo_master ? "MASTER · \(deck.state.play_state.capitalized)" : deck.state.play_state.capitalized)
                    Spacer()
                    Text(display.deckPosition.map { (deck.state.playhead_source == "beat_grid" ? "≈" : "") + timeLabel($0) } ?? "—:—")
                        .accessibilityIdentifier("djlink.deck.elapsed.\(device.player)")
                    Text("/ " + (display.deckDuration.map(timeLabel) ?? "—:—"))
                }.foregroundStyle(.secondary)
            } else {
                Text("Waiting for deck telemetry").foregroundStyle(.secondary).frame(height: 56)
            }
        }.boothFont(10, relativeTo: .caption2).monospacedDigit()
            .padding(.horizontal, 12).frame(height: 84)
            .background { PlaybackWaveformLoader(track: track, cache: cache) }
    }
}

#endif

import SwiftUI
import DJBoothKit

enum BoothStyle {
    // Same palette as the existing djbooth workstation.
    static let accent = Color(red: 0.655, green: 0.545, blue: 0.98)
    static let background = Color(red: 0.035, green: 0.039, blue: 0.051)
    static let surface = Color(red: 0.051, green: 0.059, blue: 0.075)
    static let raised = Color(red: 0.071, green: 0.078, blue: 0.098)
    static let border = Color(red: 0.137, green: 0.149, blue: 0.176)
    static let mint = Color(red: 0.494, green: 0.886, blue: 0.722)
}

#if os(iOS)
import UIKit

extension BoothStyle {
    static func configureLibraryNavigation(_ navigation: UINavigationController) {
        navigation.navigationBar.prefersLargeTitles = false
        navigation.view.backgroundColor = UIColor(background)
        navigation.view.tintColor = UIColor(accent)
        let appearance = UINavigationBarAppearance()
        appearance.configureWithOpaqueBackground()
        appearance.backgroundColor = UIColor(background)
        appearance.shadowColor = UIColor(border)
        navigation.navigationBar.standardAppearance = appearance
        navigation.navigationBar.scrollEdgeAppearance = appearance
        navigation.navigationBar.compactAppearance = appearance
    }
}

extension View {
    func boothLibraryList() -> some View {
        listStyle(.plain).scrollContentBackground(.hidden)
            .environment(\.defaultMinListRowHeight, 0)
            .background(BoothStyle.background)
    }
    func boothLibraryCell(horizontalInset: CGFloat = 0) -> some View {
        listRowInsets(EdgeInsets(top: 0, leading: horizontalInset, bottom: 0, trailing: horizontalInset))
            .listRowSeparator(.hidden).listRowBackground(BoothStyle.background)
    }
}
#endif

/// Compact system type that participates in Dynamic Type and Bold Text.
private struct BoothFont: ViewModifier {
    @ScaledMetric private var size: CGFloat
    @Environment(\.legibilityWeight) private var legibility
    let weight: Font.Weight
    let design: Font.Design
    init(size: CGFloat, relativeTo style: Font.TextStyle, weight: Font.Weight, design: Font.Design) {
        _size = ScaledMetric(wrappedValue: size, relativeTo: style)
        self.weight = weight; self.design = design
    }
    func body(content: Content) -> some View {
        content.font(.system(size: size, weight: legibility == .bold && weight == .regular ? .semibold : weight, design: design))
    }
}

extension View {
    func boothFont(_ size: CGFloat, relativeTo style: Font.TextStyle = .caption,
                   weight: Font.Weight = .regular, design: Font.Design = .default) -> some View {
        modifier(BoothFont(size: size, relativeTo: style, weight: weight, design: design))
    }
}

/// Immediate touch feedback, without scaling content or competing with row pans.
struct BoothRowButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .opacity(configuration.isPressed ? 0.65 : 1)
            .background(configuration.isPressed ? Color.primary.opacity(0.06) : .clear)
    }
}

/// Glass belongs to the primary transport control, never to the music/waveform layer.
struct BoothTransportStyle: ViewModifier {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.colorSchemeContrast) private var contrast
    func body(content: Content) -> some View {
        if #available(iOS 26, macOS 26, *), !reduceTransparency, contrast != .increased {
            content.buttonStyle(.glassProminent).buttonBorderShape(.circle).tint(.white)
        } else {
            content.buttonStyle(.borderedProminent).buttonBorderShape(.circle).tint(.white)
        }
    }
}

struct BoothGlass: ViewModifier {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    func body(content: Content) -> some View {
        if reduceTransparency {
            content.background(BoothStyle.surface, in: RoundedRectangle(cornerRadius: 20))
        } else if #available(macOS 26, iOS 26, *) {
            content.glassEffect(.regular, in: RoundedRectangle(cornerRadius: 20))
        } else {
            content.background(.regularMaterial, in: RoundedRectangle(cornerRadius: 20))
        }
    }
}

/// Deterministic artwork for recordings without a cover; it never impersonates provider art.
struct RecordArtwork: View {
    let seed: String
    var size: CGFloat = 60
    var large = false
    private var index: Int { seed.utf8.reduce(0) { ($0 + Int($1)) % 6 } }
    private let palettes: [[Color]] = [
        [Color(red: 0.14, green: 0.22, blue: 0.28), Color(red: 0.52, green: 0.70, blue: 0.68)],
        [Color(red: 0.85, green: 0.30, blue: 0.18), Color(red: 0.96, green: 0.70, blue: 0.40)],
        [Color(red: 0.35, green: 0.27, blue: 0.56), Color(red: 0.72, green: 0.64, blue: 0.81)],
        [Color(red: 0.18, green: 0.34, blue: 0.28), Color(red: 0.64, green: 0.69, blue: 0.45)],
        [Color(red: 0.24, green: 0.36, blue: 0.55), Color(red: 0.62, green: 0.76, blue: 0.83)],
        [Color(red: 0.54, green: 0.29, blue: 0.37), Color(red: 0.89, green: 0.68, blue: 0.60)]
    ]
    var body: some View {
        GeometryReader { geometry in
            let width = geometry.size.width
            ZStack {
                LinearGradient(colors: palettes[index], startPoint: .topLeading, endPoint: .bottomTrailing)
                ForEach(0..<10) { ring in
                    Circle().stroke(.white.opacity(0.10), lineWidth: width * 0.008)
                        .frame(width: width * (0.20 + Double(ring) * 0.105))
                        .offset(x: width * 0.18, y: width * 0.1)
                }
                Circle().fill(.black.opacity(0.45)).frame(width: width * 0.28).offset(x: width * 0.18, y: width * 0.1)
                Circle().fill(palettes[index][1]).frame(width: width * 0.12).offset(x: width * 0.18, y: width * 0.1)
                Circle().fill(.black).frame(width: width * 0.025).offset(x: width * 0.18, y: width * 0.1)
                if large {
                    VStack(alignment: .leading) {
                        Text("DJ / BOOTH").font(.system(size: width * 0.052, weight: .bold, design: .monospaced)).tracking(2)
                        Spacer()
                        Text(seed.uppercased()).font(.system(size: width * 0.12, weight: .black, design: .rounded)).lineLimit(3)
                    }.foregroundStyle(.white.opacity(0.9)).padding(width * 0.1).frame(maxWidth: .infinity, alignment: .leading)
                }
            }.frame(width: geometry.size.width, height: geometry.size.height)
                .clipShape(RoundedRectangle(cornerRadius: large ? 12 : 4))
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

struct TrackArtwork: View {
    let track: Track
    let model: BoothModel
    var size: CGFloat = 48
    var body: some View {
        if model.workstationTracks[track.id]?.artworkAvailable == true, model.workstationConnected, let id = track.localContentID, let workstation = model.workstation {
            AsyncImage(url: workstation.endpoint.path("api", "artwork", id)) { image in image.resizable().scaledToFill() }
                placeholder: { RecordArtwork(seed: track.album ?? track.title, size: size) }
                .frame(width: size, height: size).clipShape(RoundedRectangle(cornerRadius: 8))
        } else { RecordArtwork(seed: track.album ?? track.title, size: size) }
    }
}

func timeLabel(_ seconds: Double?) -> String {
    let value = max(0, Int((seconds ?? 0).isFinite ? seconds ?? 0 : 0))
    return String(format: "%d:%02d", value / 60, value % 60)
}

import Foundation

/// A link to a generated file in this conversation's private Brain workspace.
/// Never treat a sandbox URI as a public URL or accept an arbitrary Hand path.
public struct PublishedOutputLink: Identifiable, Equatable, Hashable, Sendable {
    public let path: String
    public let title: String
    public var id: String { path }
    public var filename: String { String(path.split(separator: "/").last ?? "output") }
    public var fileExtension: String { (filename as NSString).pathExtension.lowercased() }
    public var isVideo: Bool { ["mp4", "mov", "m4v", "webm"].contains(fileExtension) }
    public var isImage: Bool { ["png", "jpg", "jpeg", "gif", "webp", "heic"].contains(fileExtension) }

    public init?(url: URL, title: String = "") {
        guard url.scheme?.lowercased() == "sandbox", url.host == nil, url.user == nil,
              url.password == nil, url.query == nil, url.fragment == nil,
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let decoded = components.percentEncodedPath.removingPercentEncoding,
              Self.validPath(decoded) else { return nil }
        path = decoded
        let label = title.trimmingCharacters(in: .whitespacesAndNewlines)
        self.title = label.isEmpty ? String(decoded.split(separator: "/").last!) : String(label.prefix(160))
    }

    public static func validPath(_ path: String) -> Bool {
        path.hasPrefix("/brain/outputs/") && path.utf8.count <= 8192
            && !path.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 || $0 == "\\" })
            && path.split(separator: "/", omittingEmptySubsequences: false).dropFirst().allSatisfy { !$0.isEmpty && $0 != "." && $0 != ".." }
    }

    /// Parse the same Markdown semantics shown to the user: a link-like string
    /// inside a code span/fence must not become a downloadable file card.
    public static func parse(_ markdown: String) -> [Self] {
        guard let styled = try? AttributedString(markdown: markdown,
            options: .init(failurePolicy: .returnPartiallyParsedIfPossible)) else { return [] }
        var result: [Self] = [], seen = Set<String>()
        for run in styled.runs {
            guard let url = run.link,
                  let link = Self(url: url, title: String(styled[run.range].characters)),
                  seen.insert(link.path).inserted else { continue }
            result.append(link)
            if result.count == 64 { break }
        }
        return result
    }
}

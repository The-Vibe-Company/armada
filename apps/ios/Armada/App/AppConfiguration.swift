import Foundation

/// Reads the build contract of #689: `Config/Info.plist` exposes `ARMADA_API_URL`, pinned per
/// configuration. A missing or unexpanded value fails closed; the app never guesses an origin and
/// offers no environment switch.
enum AppConfiguration {
    static let apiURLKey = "ARMADA_API_URL"

    static func apiOrigin(bundle: Bundle = .main) -> URL? {
        guard let raw = bundle.object(forInfoDictionaryKey: apiURLKey) as? String else { return nil }
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty, !value.contains("$("), let url = URL(string: value),
              url.scheme == "https", url.host != nil else { return nil }
        return url
    }
}

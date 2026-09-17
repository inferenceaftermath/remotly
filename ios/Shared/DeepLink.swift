// The link from a Live Activity into the app (shared/design/DESIGN.md §4.11): `remotly://pane?id=<pane id>` opens that
// pane. Compiled into the app (which handles it in `RootView.onOpenURL`) and the widget (which sets it as `widgetURL`).
// WidgetKit hands the URL to the containing app itself, so the `remotly` scheme is deliberately NOT registered in
// `Remotly/Info.plist`: registering it would make the system Camera offer to open a `remotly://pair` QR in the app,
// which does not pair from a URL. A pairing URL is not a pane link and is ignored here.
import Foundation

enum DeepLink {
    static let scheme = "remotly"
    static let paneHost = "pane"

    /// `remotly://pane?id=w1:p3`; nil only if the id cannot be encoded.
    static func pane(_ id: String) -> URL? {
        var parts = URLComponents()
        parts.scheme = scheme
        parts.host = paneHost
        parts.queryItems = [URLQueryItem(name: "id", value: id)]
        return parts.url
    }

    /// The pane id carried by a pane link; nil for any other URL.
    static func paneId(from url: URL) -> String? {
        guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              parts.scheme?.lowercased() == scheme, parts.host?.lowercased() == paneHost,
              let id = parts.queryItems?.first(where: { $0.name == "id" })?.value, !id.isEmpty
        else { return nil }
        return id
    }
}

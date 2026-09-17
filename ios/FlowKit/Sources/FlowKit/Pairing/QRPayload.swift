// `remotly://pair?u=…&fp=…&c=…&n=…` (shared/protocol/remotly-protocol.md §3). The bridge encodes the
// query with URLSearchParams (form encoding: spaces become `+`), so decode accordingly.
import Foundation

public struct QRPayload: Hashable, Sendable {
    /// WebSocket origin: scheme, host, port; no path (`wss://100.101.102.103:7460`).
    public var origin: URL
    /// Unpadded base64url SHA-256 of the leaf certificate DER; nil when the cert is publicly trusted.
    public var fingerprint: String?
    /// Normalised pairing code (upper-case, no spaces or dashes).
    public var code: String
    public var hostName: String

    public init(origin: URL, fingerprint: String?, code: String, hostName: String) {
        self.origin = origin
        self.fingerprint = fingerprint.flatMap { $0.isEmpty ? nil : $0 }
        self.code = QRPayload.normalizeCode(code)
        self.hostName = hostName
    }

    /// Parses a scanned or pasted payload. Returns nil unless scheme, host, `u`, `c` (8 characters of the alphabet) and
    /// `fp` (43 base64url characters when present) are valid.
    public init?(string: String) {
        let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let components = URLComponents(string: trimmed),
              components.scheme?.lowercased() == "remotly",
              components.host?.lowercased() == "pair",
              let query = components.percentEncodedQuery else { return nil }
        let params = QRPayload.formDecode(query)
        guard let u = params["u"], let origin = QRPayload.normalizeOrigin(u),
              let c = params["c"], QRPayload.isValidCode(QRPayload.normalizeCode(c)) else { return nil }
        let fp = params["fp"]?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !fp.isEmpty, !QRPayload.isValidFingerprint(fp) { return nil } // same rejection as Android's QrPayload.parse
        self.init(origin: origin, fingerprint: fp, code: c, hostName: params["n"] ?? origin.host() ?? "")
    }

    /// `wss://host:port/ws`
    public var webSocketURL: URL { origin.appending(path: "ws") }
    /// `https://host:port` for `POST /pair` and `GET /health`.
    public var restBaseURL: URL { QRPayload.https(origin) }

    /// Upper-cases and strips spaces and dashes; the bridge normalises the same way.
    public static func normalizeCode(_ raw: String) -> String {
        String(raw.uppercased().filter { !$0.isWhitespace && $0 != "-" })
    }

    /// The pairing code alphabet of `remotly-bridge pair`: A–Z without I and O, digits 2–9.
    public static let codeAlphabet: Set<Character> = Set("ABCDEFGHJKLMNPQRSTUVWXYZ23456789")

    /// A normalised code: exactly 8 characters of the alphabet.
    public static func isValidCode(_ code: String) -> Bool {
        code.count == 8 && code.allSatisfy { codeAlphabet.contains($0) }
    }

    /// Unpadded base64url of 32 bytes is always 43 characters.
    public static func isValidFingerprint(_ fingerprint: String) -> Bool {
        fingerprint.count == 43 && fingerprint.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }
    }

    /// Accepts `wss://h:p`, `https://h:p`, `ws://`, `http://` or a bare `h:p` and returns a `wss://`
    /// (or `ws://`) origin without path, query or fragment.
    public static func normalizeOrigin(_ text: String) -> URL? {
        var s = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !s.isEmpty else { return nil }
        if !s.contains("://") { s = "wss://" + s }
        guard var comps = URLComponents(string: s), let host = comps.host, !host.isEmpty else { return nil }
        switch comps.scheme?.lowercased() {
        case "wss", "https": comps.scheme = "wss"
        case "ws", "http": comps.scheme = "ws"
        default: return nil
        }
        comps.path = ""
        comps.query = nil
        comps.fragment = nil
        comps.user = nil
        comps.password = nil
        return comps.url
    }

    static func https(_ origin: URL) -> URL {
        guard var comps = URLComponents(url: origin, resolvingAgainstBaseURL: false) else { return origin }
        comps.scheme = comps.scheme == "ws" ? "http" : "https"
        return comps.url ?? origin
    }

    /// application/x-www-form-urlencoded decoding of a raw query string.
    static func formDecode(_ query: String) -> [String: String] {
        var out: [String: String] = [:]
        for pair in query.split(separator: "&", omittingEmptySubsequences: true) {
            let parts = pair.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
            guard let rawKey = parts.first else { continue }
            let rawValue = parts.count > 1 ? parts[1] : Substring("")
            func decode(_ s: Substring) -> String {
                s.replacingOccurrences(of: "+", with: " ").removingPercentEncoding ?? String(s)
            }
            out[decode(rawKey)] = decode(rawValue)
        }
        return out
    }
}

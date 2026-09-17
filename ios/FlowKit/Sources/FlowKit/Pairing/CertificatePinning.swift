// TLS trust for both pairing (URLSession data task) and the WebSocket. With a fingerprint the
// leaf certificate's SHA-256 must match and chain validation is skipped (self-signed mode);
// without one the system performs normal validation (Tailscale / publicly trusted certificate).
import CryptoKit
import Foundation
import Security

public enum CertificateFingerprint {
    /// Unpadded base64url of SHA-256 over `der`.
    public static func base64URL(sha256Of der: Data) -> String {
        base64URL(Data(SHA256.hash(data: der)))
    }

    public static func base64URL(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    /// Canonical form for comparison: accepts base64 or base64url, padded or not, any whitespace.
    public static func normalize(_ fingerprint: String) -> String {
        fingerprint
            .filter { !$0.isWhitespace }
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    public static func matches(_ actual: String, expected: String) -> Bool {
        let a = normalize(actual)
        let e = normalize(expected)
        return !a.isEmpty && a == e
    }

    /// DER bytes of the leaf certificate of a server trust.
    public static func leafDER(of trust: SecTrust) -> Data? {
        guard let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate], let leaf = chain.first else { return nil }
        return SecCertificateCopyData(leaf) as Data
    }

    public static func leafFingerprint(of trust: SecTrust) -> String? {
        leafDER(of: trust).map { base64URL(sha256Of: $0) }
    }
}

/// What the delegate saw during the most recent server-trust challenge (surfaced in pairing errors so a
/// mismatch can be told apart from "the pin was never consulted").
public struct PinningOutcome: Sendable, Hashable {
    public var actual: String?
    public var expected: String
    public var accepted: Bool
}

/// URLSession delegate shared by `PairingClient` and `FlowConnection`.
///
/// Implements the classic completion-handler delegate methods (session- and task-level): the
/// async-only variant was not consulted on device (2026-09-03, iOS 26 / TestFlight build 30), so
/// URLSession fell back to default trust evaluation and rejected the self-signed certificate.
public final class PinningSessionDelegate: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    public let fingerprint: String?
    private let lock = NSLock()
    private var _lastOutcome: PinningOutcome?

    public init(fingerprint: String?) {
        self.fingerprint = fingerprint.flatMap { $0.isEmpty ? nil : $0 }
        super.init()
    }

    /// Result of the last pin check, `nil` if no server-trust challenge reached this delegate yet.
    public var lastOutcome: PinningOutcome? { lock.withLock { _lastOutcome } }

    public func urlSession(
        _ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping @Sendable (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        let (disposition, credential) = decide(challenge)
        completionHandler(disposition, credential)
    }

    public func urlSession(
        _ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping @Sendable (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        let (disposition, credential) = decide(challenge)
        completionHandler(disposition, credential)
    }

    private func decide(_ challenge: URLAuthenticationChallenge) -> (URLSession.AuthChallengeDisposition, URLCredential?) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust else {
            return (.performDefaultHandling, nil)
        }
        guard let expected = fingerprint else {
            return (.performDefaultHandling, nil)
        }
        let actual = CertificateFingerprint.leafFingerprint(of: trust)
        let accepted = actual.map { CertificateFingerprint.matches($0, expected: expected) } ?? false
        lock.withLock { _lastOutcome = PinningOutcome(actual: actual, expected: expected, accepted: accepted) }
        return accepted ? (.useCredential, URLCredential(trust: trust)) : (.cancelAuthenticationChallenge, nil)
    }
}

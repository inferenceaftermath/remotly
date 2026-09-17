// `POST /pair` (shared/protocol/remotly-protocol.md §2).
import Foundation

public struct PairingResponse: Decodable, Hashable, Sendable {
    public var token: String
    public var deviceId: String
    public var hostName: String
    enum CodingKeys: String, CodingKey { case token, deviceId = "device_id", hostName = "host_name" }
}

public enum PairingError: Error, Hashable, Sendable, LocalizedError {
    case badCode
    case forbidden
    case lockedOut(retryAfterMs: Int?)
    case badRequest
    /// The pin failed or was never consulted; `detail` says which (actual vs expected fingerprint).
    case certificateMismatch(detail: String)
    /// The pin matched and the trust was accepted, yet iOS still refused the connection.
    case tlsRejected(detail: String)
    case server(status: Int)
    case transport(String)

    public var errorDescription: String? {
        switch self {
        case .badCode: return "Wrong or expired pairing code."
        case .forbidden: return "The bridge refused this device (not on the tailnet?)."
        case .lockedOut(let ms):
            if let ms { return "Too many attempts; try again in \(Int((Double(ms) / 60_000).rounded(.up))) min." }
            return "Too many attempts; try again later."
        case .badRequest: return "The bridge rejected the request."
        case .certificateMismatch(let detail): return "The host's certificate does not match the fingerprint. \(detail)"
        case .tlsRejected(let detail): return "iOS refused the secure connection to the host. \(detail)"
        case .server(let status): return "Unexpected response (HTTP \(status))."
        case .transport(let message): return message
        }
    }
}

public struct PairingClient: Sendable {
    public let origin: URL
    public let fingerprint: String?

    /// `origin` is the `wss://host:port` origin from the QR payload; REST uses the same origin over https.
    public init(origin: URL, fingerprint: String?) {
        self.origin = origin
        self.fingerprint = fingerprint.flatMap { $0.isEmpty ? nil : $0 }
    }

    private func makeSession(delegate: PinningSessionDelegate) -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 15
        config.waitsForConnectivity = false
        return URLSession(configuration: config, delegate: delegate, delegateQueue: nil)
    }

    /// `URLError N, stream S, Domain code, …`: the URLError code plus CFNetwork's stream code
    /// (`-98xx` = Security framework TLS errors) and the underlying-error chain, so a device-side
    /// failure can be diagnosed from the alert text alone.
    static func errorCodes(_ error: URLError) -> String {
        var parts = ["URLError \(error.code.rawValue)"]
        let info = error.errorUserInfo
        if let stream = info["_kCFStreamErrorCodeKey"] { parts.append("stream \(stream)") }
        var next = info[NSUnderlyingErrorKey] as? NSError
        var depth = 0
        while let e = next, depth < 3 {
            parts.append("\(e.domain) \(e.code)")
            next = e.userInfo[NSUnderlyingErrorKey] as? NSError
            depth += 1
        }
        return parts.joined(separator: ", ")
    }

    /// Human-readable reason for a TLS failure while a fingerprint is pinned.
    static func pinningDetail(_ outcome: PinningOutcome?, error: URLError) -> String {
        let codes = errorCodes(error)
        guard let outcome else {
            return "TLS failed before the pin was checked (\(codes))."
        }
        if outcome.accepted {
            // Pin matched and the trust was accepted, yet the connection still failed on the phone.
            return "The pinned fingerprint matched and the certificate was accepted by the app, but the system still closed the connection (\(codes)). A device policy that rejects untrusted TLS certificates does this; a publicly trusted (Tailscale) certificate on the bridge avoids it."
        }
        return "Host presented \(outcome.actual ?? "no leaf certificate"), expected \(outcome.expected) (\(codes))."
    }

    public func pair(code: String, deviceName: String, appVersion: String, platform: String = "ios") async throws -> PairingResponse {
        let delegate = PinningSessionDelegate(fingerprint: fingerprint)
        let session = makeSession(delegate: delegate)
        defer { session.finishTasksAndInvalidate() }
        var request = URLRequest(url: QRPayload.https(origin).appending(path: "pair"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.setValue("application/json", forHTTPHeaderField: "accept")
        let device: [String: String] = [
            "name": String(deviceName.trimmingCharacters(in: .whitespacesAndNewlines).prefix(64)),
            "platform": platform,
            "app_version": String(appVersion.prefix(32)),
        ]
        let body: [String: Any] = ["code": QRPayload.normalizeCode(code), "device": device]
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let result: (data: Data, response: URLResponse)
        do {
            result = try await session.data(for: request)
        } catch let error as URLError {
            if fingerprint != nil, [.cancelled, .serverCertificateUntrusted, .secureConnectionFailed].contains(error.code) {
                let detail = Self.pinningDetail(delegate.lastOutcome, error: error)
                if delegate.lastOutcome?.accepted == true { throw PairingError.tlsRejected(detail: detail) }
                throw PairingError.certificateMismatch(detail: detail)
            }
            throw PairingError.transport(error.localizedDescription)
        } catch {
            throw PairingError.transport(error.localizedDescription)
        }
        let data = result.data
        guard let http = result.response as? HTTPURLResponse else { throw PairingError.transport("Not an HTTP response") }
        let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        switch http.statusCode {
        case 200:
            return try JSONDecoder().decode(PairingResponse.self, from: data)
        case 400:
            throw PairingError.badRequest
        case 403:
            throw (json?["error"] as? String) == "forbidden" ? PairingError.forbidden : PairingError.badCode
        case 429:
            throw PairingError.lockedOut(retryAfterMs: json?["retry_after_ms"] as? Int)
        default:
            throw PairingError.server(status: http.statusCode)
        }
    }
}

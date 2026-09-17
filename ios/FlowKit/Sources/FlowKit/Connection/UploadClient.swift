// `POST /upload` (shared/protocol/remotly-protocol.md §2): a photo from the phone becomes a file on the host
// that the program in a pane reads by path. Same origin, TLS trust and device token as the WebSocket.
import Foundation

public struct UploadResult: Decodable, Hashable, Sendable {
    /// Absolute path of the stored file on the host.
    public var path: String
    public var bytes: Int
}

public enum UploadError: Error, Hashable, Sendable, LocalizedError {
    case auth
    case forbidden
    case tooLarge
    case unsupportedType
    case server(status: Int)
    case transport(String)

    public var errorDescription: String? {
        switch self {
        case .auth: return "The bridge no longer accepts this device. Pair again."
        case .forbidden: return "The bridge refused this device (not on the tailnet?)."
        case .tooLarge: return "The photo is too large for the bridge."
        case .unsupportedType: return "The bridge accepts JPEG and PNG only."
        case .server(let status): return "Upload failed (HTTP \(status))."
        case .transport(let message): return message
        }
    }
}

public struct UploadClient: Sendable {
    public let host: PairedHost

    public init(host: PairedHost) {
        self.host = host
    }

    public func upload(_ data: Data, contentType: String = "image/jpeg") async throws -> UploadResult {
        var request = URLRequest(url: host.restBaseURL.appending(path: "upload"))
        request.httpMethod = "POST"
        request.setValue(contentType, forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(host.token)", forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 60
        let config = URLSessionConfiguration.ephemeral
        config.waitsForConnectivity = false
        let session = URLSession(configuration: config, delegate: PinningSessionDelegate(fingerprint: host.fingerprint), delegateQueue: nil)
        defer { session.finishTasksAndInvalidate() }
        let body: Data
        let response: URLResponse
        do {
            (body, response) = try await session.upload(for: request, from: data)
        } catch {
            throw UploadError.transport(error.localizedDescription)
        }
        switch (response as? HTTPURLResponse)?.statusCode ?? 0 {
        case 200:
            do { return try JSONDecoder().decode(UploadResult.self, from: body) } catch { throw UploadError.server(status: 200) }
        case 401: throw UploadError.auth
        case 403: throw UploadError.forbidden
        case 413: throw UploadError.tooLarge
        case 415: throw UploadError.unsupportedType
        case let status: throw UploadError.server(status: status)
        }
    }
}

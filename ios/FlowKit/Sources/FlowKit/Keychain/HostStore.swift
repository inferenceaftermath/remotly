// The single paired host, persisted as one Keychain generic-password item (v1 supports one host).
// `kSecAttrAccessibleAfterFirstUnlock` so notification actions can read it while the phone is locked.
import Foundation
import Security

public struct PairedHost: Codable, Hashable, Sendable {
    public var name: String
    /// `wss://host:port` origin.
    public var url: URL
    public var fingerprint: String?
    public var token: String
    public var deviceId: String

    public init(name: String, url: URL, fingerprint: String?, token: String, deviceId: String) {
        self.name = name
        self.url = url
        self.fingerprint = fingerprint.flatMap { $0.isEmpty ? nil : $0 }
        self.token = token
        self.deviceId = deviceId
    }

    public var webSocketURL: URL { url.appending(path: "ws") }
    public var restBaseURL: URL { QRPayload.https(url) }
    public var isPinned: Bool { fingerprint != nil }
}

public enum KeychainError: Error, Sendable, LocalizedError {
    case status(OSStatus)
    case corrupt

    public var errorDescription: String? {
        switch self {
        case .status(let s): return "Keychain error \(s)"
        case .corrupt: return "Stored host record is unreadable"
        }
    }
}

public struct HostStore: Sendable {
    public let service: String
    public let account: String

    public init(service: String = "com.inferenceaftermath.remotly", account: String = "paired-host") {
        self.service = service
        self.account = account
    }

    private var baseQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }

    public func load() throws -> PairedHost? {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        switch status {
        case errSecSuccess:
            guard let data = item as? Data else { throw KeychainError.corrupt }
            do {
                return try JSONDecoder().decode(PairedHost.self, from: data)
            } catch {
                throw KeychainError.corrupt
            }
        case errSecItemNotFound:
            return nil
        default:
            throw KeychainError.status(status)
        }
    }

    public func save(_ host: PairedHost) throws {
        let data = try JSONEncoder().encode(host)
        let update: [String: Any] = [kSecValueData as String: data]
        let status = SecItemUpdate(baseQuery as CFDictionary, update as CFDictionary)
        if status == errSecSuccess { return }
        guard status == errSecItemNotFound else { throw KeychainError.status(status) }
        var add = baseQuery
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        let addStatus = SecItemAdd(add as CFDictionary, nil)
        guard addStatus == errSecSuccess else { throw KeychainError.status(addStatus) }
    }

    public func delete() throws {
        let status = SecItemDelete(baseQuery as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw KeychainError.status(status) }
    }
}

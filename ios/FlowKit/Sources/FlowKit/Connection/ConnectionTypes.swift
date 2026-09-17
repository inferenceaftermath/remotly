// Public value types of the connection layer: state, events, errors.
import Foundation

public enum ConnectionState: Hashable, Sendable {
    case idle
    case connecting
    case connected
    case reconnecting(attempt: Int)
    /// The bridge rejected the token (close 4401): the device must pair again.
    case unpaired
    case stopped

    public var isConnected: Bool { self == .connected }
}

public enum ConnectionEvent: Sendable {
    case state(ConnectionState)
    case welcome(Welcome)
    case snapshot(Snapshot)
    case paneStatus(PaneStatus)
    case frame(Frame)
    case history(HistoryMessage)
    case approvalResult(ApprovalResult)
    /// The bridge changed this device's "tell me when it's done" arming (the alert fired).
    case notifyState(pane: String, done: Bool)
    case herdr(isUp: Bool)
}

public enum FlowError: Error, Hashable, Sendable, LocalizedError {
    case notConnected
    case timeout
    case closed
    case unpaired
    case encoding
    case unexpectedReply
    /// A newer watch/fit intent overtook this one (issued out of order by independent tasks); the caller drops it.
    case superseded
    case server(code: ErrorCode, message: String)

    public var errorDescription: String? {
        switch self {
        case .notConnected: return "Not connected to the bridge."
        case .timeout: return "The bridge did not answer in time."
        case .closed: return "The connection was closed."
        case .unpaired: return "This device is no longer paired."
        case .encoding: return "Could not encode the message."
        case .unexpectedReply: return "Unexpected reply from the bridge."
        case .superseded: return "A newer request replaced this one."
        case .server(let code, let message): return message.isEmpty ? code.rawValue : "\(message) (\(code.rawValue))"
        }
    }
}

public struct WatchResult: Hashable, Sendable {
    public var cols: Int
    public var rows: Int
    /// herdr's zoom state after `watch {zoom:true}`; nil when the bridge did not zoom (flag off, old herdr).
    public var zoomed: Bool? = nil
}

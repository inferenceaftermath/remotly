// What the pairing screen does with each QR the camera delivers (DESIGN.md §4.8). The camera reads a code that stays
// in view many times a second; a code whose pairing failed must not go out again on the next frame, or five frames hit
// the bridge's lockout (`pair.locked_out`, 15 minutes) before the error has even been read.
import Foundation

public struct ScanGate: Sendable {
    public enum Decision: Equatable, Sendable {
        /// Send this code. The gate is in flight until `failed` or `succeeded`; every scan meanwhile is ignored.
        case pair(QRPayload)
        /// Show the plain toast "Not a Remotly pairing code" (at most once per `foreignNoticeMs` while one is in view).
        case notice
        case ignore
    }

    /// The scanned text whose pairing is in flight.
    public private(set) var inFlight: String?
    /// The failure shown over the viewfinder; nil while scanning is live. Set by `failed`, cleared by `resume` or a different code.
    public private(set) var paused: String?
    private var rejected: String?
    private var lastForeignAt: Date?
    private let foreignNoticeMs: Int

    public init(foreignNoticeMs: Int = 2400) {
        self.foreignNoticeMs = foreignNoticeMs
    }

    /// The decision for one camera read of `text` at `now`.
    public mutating func scanned(_ text: String, now: Date = Date()) -> Decision {
        if inFlight != nil || text == rejected { return .ignore }
        guard let payload = QRPayload(string: text) else {
            if paused != nil { return .ignore }
            // Whole milliseconds, as Android's clock: Date arithmetic lands a hair under a boundary (2.3999999…).
            if let last = lastForeignAt, Int((now.timeIntervalSince(last) * 1000).rounded()) < foreignNoticeMs { return .ignore }
            lastForeignAt = now
            return .notice
        }
        inFlight = text
        rejected = nil
        paused = nil
        return .pair(payload)
    }

    /// The in-flight code was refused: it is not sent again while it stays in view, and `message` is shown until `resume`.
    public mutating func failed(_ message: String) {
        guard let code = inFlight else { return }
        rejected = code
        inFlight = nil
        paused = message
    }

    public mutating func succeeded() {
        inFlight = nil
    }

    /// The user tapped the viewfinder: the code that failed may be scanned again.
    public mutating func resume() {
        rejected = nil
        paused = nil
    }
}

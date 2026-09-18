import Foundation

/// Shared by real-host connections for one app mode. A cancelled lifetime can never become active again.
public final class ConnectionLifetime: @unchecked Sendable {
    private let lock = NSLock()
    private var active = true
    private var handlers: [UUID: @Sendable () -> Void] = [:]

    public init() {}
    public var isActive: Bool { lock.withLock { active } }

    /// Serializes transport enqueueing with cancellation. The closure must not suspend.
    func whileActive(_ body: () throws -> Void) rethrows -> Bool {
        try lock.withLock {
            guard active else { return false }
            try body()
            return true
        }
    }

    func onCancel(_ id: UUID, _ body: @escaping @Sendable () -> Void) {
        let cancelled = lock.withLock {
            if active { handlers[id] = body }
            return !active
        }
        if cancelled { body() }
    }

    func remove(_ id: UUID) { _ = lock.withLock { handlers.removeValue(forKey: id) } }

    public func cancel() {
        let callbacks = lock.withLock {
            active = false
            let callbacks = Array(handlers.values)
            handlers.removeAll()
            return callbacks
        }
        for callback in callbacks { callback() }
    }
}

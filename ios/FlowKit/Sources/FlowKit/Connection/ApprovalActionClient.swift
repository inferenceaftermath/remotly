// Notification-action flow: a short-lived `mode:"action"` connection that sends one `approve` and waits for
// `approval.result`, or one `prompt` (a reply typed into a "finished" notification), then closes
// (shared/protocol/remotly-protocol.md §4, `hello mode:"action"`).
import Foundation

/// Runs `operation` with a deadline; the loser is cancelled.
public func withTimeout<T: Sendable>(_ duration: Duration, operation: @escaping @Sendable () async throws -> T) async throws -> T {
    try await withThrowingTaskGroup(of: T.self) { group in
        group.addTask { try await operation() }
        group.addTask {
            try await Task.sleep(for: duration)
            throw FlowError.timeout
        }
        guard let first = try await group.next() else { throw FlowError.timeout }
        group.cancelAll()
        return first
    }
}

public struct ApprovalOutcomeSummary: Hashable, Sendable {
    public var title: String
    public var body: String
    public var result: ApprovalResult?
    /// True when the user should re-pair (token rejected).
    public var unpaired: Bool
    /// True when the bridge accepted the request (keys typed, or the reply delivered).
    public var sent: Bool

    public init(title: String, body: String, result: ApprovalResult? = nil, unpaired: Bool = false, sent: Bool = false) {
        self.title = title
        self.body = body
        self.result = result
        self.unpaired = unpaired
        self.sent = sent
    }
}

public enum ApprovalActionClient {
    public static func perform(action: ApprovalAction, payload: PushPayload, host: PairedHost, client: ClientInfo,
                               feedback: String? = nil, timeout: Duration = .seconds(20),
                               lifetime: ConnectionLifetime = ConnectionLifetime()) async -> ApprovalOutcomeSummary {
        let connection = FlowConnection(host: host, client: client, mode: .action, lifetime: lifetime)
        await connection.start()
        defer { Task { await connection.stop() } }
        do {
            let result = try await withTimeout(timeout) { () async throws -> ApprovalResult in
                var sent = false
                for await event in connection.events {
                    switch event {
                    case .state(.connected):
                        if !sent {
                            sent = true
                            try await connection.approve(pane: payload.pane, promptId: payload.promptId, action: action, feedback: feedback)
                        }
                    case .state(.unpaired):
                        throw FlowError.unpaired
                    case .state(.stopped):
                        throw FlowError.closed
                    case .approvalResult(let result) where result.promptId == payload.promptId:
                        return result
                    default:
                        continue
                    }
                }
                throw FlowError.closed
            }
            return summary(action: action, agent: payload.agent, result: result)
        } catch FlowError.unpaired {
            return ApprovalOutcomeSummary(title: "Remotly is not paired", body: "Open Remotly and pair with \(host.name) again.", unpaired: true)
        } catch {
            let body = (error as? LocalizedError)?.errorDescription ?? "Could not reach \(host.name)."
            return ApprovalOutcomeSummary(title: "\(action.title) failed", body: body)
        }
    }

    /// Reply typed into a "finished" notification: one `prompt` (armed for the next alert when `notify`), then close.
    public static func reply(text: String, notify: Bool, pane: String, agent: String, host: PairedHost, client: ClientInfo,
                             timeout: Duration = .seconds(20), lifetime: ConnectionLifetime = ConnectionLifetime()) async -> ApprovalOutcomeSummary {
        let who = agent.isEmpty ? "The agent" : agent.capitalized
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return ApprovalOutcomeSummary(title: "Nothing sent", body: "The reply was empty.") }
        let connection = FlowConnection(host: host, client: client, mode: .action, lifetime: lifetime)
        await connection.start()
        defer { Task { await connection.stop() } }
        do {
            try await withTimeout(timeout) { () async throws in
                for await event in connection.events {
                    switch event {
                    case .state(.connected):
                        try await connection.sendPrompt(pane: pane, text: trimmed, notify: notify)
                        return
                    case .state(.unpaired):
                        throw FlowError.unpaired
                    case .state(.stopped):
                        throw FlowError.closed
                    default:
                        continue
                    }
                }
                throw FlowError.closed
            }
            return ApprovalOutcomeSummary(title: "Reply sent",
                                          body: notify ? "\(who) has your message; you'll be told when it finishes." : "\(who) has your message.",
                                          sent: true)
        } catch FlowError.unpaired {
            return ApprovalOutcomeSummary(title: "Remotly is not paired", body: "Open Remotly and pair with \(host.name) again.", unpaired: true)
        } catch {
            let body = (error as? LocalizedError)?.errorDescription ?? "Could not reach \(host.name)."
            return ApprovalOutcomeSummary(title: "Reply failed", body: body)
        }
    }

    public static func summary(action: ApprovalAction, agent: String, result: ApprovalResult) -> ApprovalOutcomeSummary {
        let who = agent.isEmpty ? "The agent" : agent.capitalized
        switch result.outcome {
        case .sent:
            let after = result.statusAfter.map { " · now \($0.rawValue)" } ?? ""
            return ApprovalOutcomeSummary(title: "\(action.title) sent", body: "\(who) received your decision\(after).", result: result, sent: true)
        case .stale:
            return ApprovalOutcomeSummary(title: "Already resolved", body: "That prompt was answered elsewhere; nothing was sent.", result: result)
        case .notBlocked:
            return ApprovalOutcomeSummary(title: "Nothing to approve", body: "\(who) is no longer waiting; nothing was sent.", result: result)
        case .signatureMismatch:
            return ApprovalOutcomeSummary(title: "Not sent", body: "The screen does not look like an approval prompt. Open Remotly to review.", result: result)
        default:
            return ApprovalOutcomeSummary(title: "\(action.title) failed", body: result.detail ?? "The bridge could not send the keys.", result: result)
        }
    }
}

/// Hands Live Activity tokens to the bridge over a short-lived action connection. iOS wakes the app in the background
/// when a push-to-start Live Activity begins, and the activity's update token must reach the bridge then, before the
/// app's normal connection exists; without it the bridge could never update or end that activity.
public enum ActivityTokenClient {
    public static func register(_ tokens: [(pane: String?, token: String)], host: PairedHost, client: ClientInfo,
                                timeout: Duration = .seconds(15), lifetime: ConnectionLifetime = ConnectionLifetime()) async -> Bool {
        guard !tokens.isEmpty else { return true }
        let connection = FlowConnection(host: host, client: client, mode: .action, lifetime: lifetime)
        await connection.start()
        defer { Task { await connection.stop() } }
        do {
            try await withTimeout(timeout) { () async throws in
                for await event in connection.events {
                    switch event {
                    case .state(.connected):
                        for item in tokens { try await connection.registerActivity(token: item.token, pane: item.pane) }
                        return
                    case .state(.unpaired):
                        throw FlowError.unpaired
                    case .state(.stopped):
                        throw FlowError.closed
                    default:
                        continue
                    }
                }
                throw FlowError.closed
            }
            return true
        } catch {
            return false
        }
    }
}

public extension ApprovalAction {
    var title: String {
        switch self {
        case .approve: return "Approve"
        case .approveSession: return "Approve for session"
        case .deny: return "Deny"
        case .denyFeedback: return "Deny with feedback"
        case .interrupt: return "Interrupt"
        }
    }
}

public extension ApprovalResult {
    /// Short outcome text for the in-app approval bar.
    var summaryText: String {
        switch outcome {
        case .sent: return statusAfter.map { "Sent · agent is \($0.rawValue)" } ?? "Sent"
        case .stale: return "Already resolved on the desktop"
        case .notBlocked: return "Pane is no longer waiting"
        case .signatureMismatch: return "Screen does not look like an approval prompt"
        case .dialogChanged: return detail.map { "The dialog changed: \($0)" } ?? "The dialog changed; nothing sent"
        default: return detail.map { "Failed: \($0)" } ?? "Failed"
        }
    }
}

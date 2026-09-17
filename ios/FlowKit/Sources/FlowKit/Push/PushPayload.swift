// APNs payload (shared/protocol/remotly-protocol.md §9), the notification categories and stale-notification cleanup.
import Foundation
import UserNotifications

/// `flow.type`: an approval prompt, or an agent this device armed has finished.
public enum PushKind: String, Sendable {
    case approval
    case done
}

/// The `flow` dictionary of a push: `{v, type, host, pane, prompt_id?, agent, approval?}`.
public struct PushPayload: Hashable, Sendable {
    public var version: Int
    public var kind: PushKind
    public var host: String
    public var pane: String
    /// Empty for `done`.
    public var promptId: String
    public var agent: String
    /// `approval` only: the bridge's parsed dialog, when it could read one.
    public var approval: ApprovalDetails?

    public init(version: Int = 1, kind: PushKind = .approval, host: String, pane: String, promptId: String, agent: String,
                approval: ApprovalDetails? = nil) {
        self.version = version
        self.kind = kind
        self.host = host
        self.pane = pane
        self.promptId = promptId
        self.agent = agent
        self.approval = approval
    }

    /// From `UNNotificationContent.userInfo` / the remote notification dictionary.
    public init?(userInfo: [AnyHashable: Any]) {
        guard let flow = userInfo["flow"] as? [String: Any] else { return nil }
        self.init(flow: flow)
    }

    public init?(flow: [String: Any]) {
        guard let pane = flow["pane"] as? String, !pane.isEmpty else { return nil }
        // Older bridges sent approvals without `type`.
        guard let kind = PushKind(rawValue: (flow["type"] as? String) ?? PushKind.approval.rawValue) else { return nil }
        let promptId = (flow["prompt_id"] as? String) ?? ""
        if kind == .approval, promptId.isEmpty { return nil }
        let version = (flow["v"] as? Int) ?? Int((flow["v"] as? String) ?? "") ?? 1
        var approval: ApprovalDetails?
        if let dict = flow["approval"] as? [String: Any], let data = try? JSONSerialization.data(withJSONObject: dict) {
            approval = try? JSONDecoder().decode(ApprovalDetails.self, from: data)
        }
        self.init(version: version,
                  kind: kind,
                  host: (flow["host"] as? String) ?? "",
                  pane: pane,
                  promptId: promptId,
                  agent: (flow["agent"] as? String) ?? "",
                  approval: approval)
    }

    public var isApproval: Bool { kind == .approval }
    public var isDone: Bool { kind == .done }
}

public enum FlowNotifications {
    public static let approvalCategory = "REMOTLY_APPROVAL"
    /// A menu to answer in the app (AskUserQuestion, pickers): no actions, tapping opens the pane.
    public static let questionCategory = "REMOTLY_QUESTION"
    public static let doneCategory = "REMOTLY_DONE"
    public static let outcomeCategory = "REMOTLY_OUTCOME"
    public static let approveAction = "APPROVE"
    public static let denyAction = "DENY"
    public static let denyFeedbackAction = "DENY_FEEDBACK"
    public static let replyAction = "REPLY"

    /// Actions run in the background (no `.foreground`). With `requireUnlock`, Approve, Deny with feedback and Reply
    /// need the phone unlocked (Face ID / passcode from the lock screen); Deny alone is always available, denying is the safe direction.
    public static func categories(requireUnlock: Bool = true) -> Set<UNNotificationCategory> {
        let auth: UNNotificationActionOptions = requireUnlock ? [.authenticationRequired] : []
        let approve = UNNotificationAction(identifier: approveAction, title: "Approve", options: auth)
        let deny = UNNotificationAction(identifier: denyAction, title: "Deny", options: [.destructive])
        let denyFeedback = UNTextInputNotificationAction(identifier: denyFeedbackAction, title: "Deny with feedback",
                                                         options: auth.union(.destructive),
                                                         textInputButtonTitle: "Deny", textInputPlaceholder: "What should it do instead?")
        let approval = UNNotificationCategory(identifier: approvalCategory, actions: [approve, deny, denyFeedback], intentIdentifiers: [], options: [])
        let reply = UNTextInputNotificationAction(identifier: replyAction, title: "Reply", options: auth,
                                                  textInputButtonTitle: "Send", textInputPlaceholder: "Your next prompt")
        let done = UNNotificationCategory(identifier: doneCategory, actions: [reply], intentIdentifiers: [], options: [])
        let outcome = UNNotificationCategory(identifier: outcomeCategory, actions: [], intentIdentifiers: [], options: [])
        let question = UNNotificationCategory(identifier: questionCategory, actions: [], intentIdentifiers: [], options: [])
        return [approval, question, done, outcome]
    }

    /// Registers the categories and asks for alert/sound/badge/time-sensitive permission.
    public static func requestAuthorization(requireUnlock: Bool = true) async -> Bool {
        let center = UNUserNotificationCenter.current()
        center.setNotificationCategories(categories(requireUnlock: requireUnlock))
        do {
            return try await center.requestAuthorization(options: [.alert, .sound, .badge, .timeSensitive])
        } catch {
            return false
        }
    }

    public static func authorizationStatus() async -> UNAuthorizationStatus {
        await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
    }

    /// Identifiers of delivered approval notifications whose `prompt_id` is no longer live. "Finished" alerts are
    /// never stale: they stay until read. Pure helper used by `removeStaleApprovals` and by tests.
    public static func staleIdentifiers(delivered: [(identifier: String, userInfo: [AnyHashable: Any])],
                                        livePromptIds: Set<String>) -> [String] {
        delivered.compactMap { item in
            guard let payload = PushPayload(userInfo: item.userInfo), payload.isApproval else { return nil }
            return livePromptIds.contains(payload.promptId) ? nil : item.identifier
        }
    }

    /// Removes delivered approval banners for prompts that are not in the current snapshot.
    public static func removeStaleApprovals(livePromptIds: Set<String>) async {
        let center = UNUserNotificationCenter.current()
        let delivered = await center.deliveredNotifications()
        let items = delivered.map { (identifier: $0.request.identifier, userInfo: $0.request.content.userInfo) }
        let stale = staleIdentifiers(delivered: items, livePromptIds: livePromptIds)
        if !stale.isEmpty { center.removeDeliveredNotifications(withIdentifiers: stale) }
    }

    /// The user opened the pane in the app: its approval, finished and outcome notifications are read.
    public static func removeDelivered(forPane pane: String) async {
        let center = UNUserNotificationCenter.current()
        let delivered = await center.deliveredNotifications()
        let ids = delivered.compactMap { item -> String? in
            let content = item.request.content
            let samePane = content.threadIdentifier == pane || PushPayload(userInfo: content.userInfo)?.pane == pane
            return samePane ? item.request.identifier : nil
        }
        if !ids.isEmpty { center.removeDeliveredNotifications(withIdentifiers: ids) }
    }

    /// Local notification with the result of a notification action (posted from the background).
    public static func postOutcome(title: String, body: String, pane: String) async {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.threadIdentifier = pane
        content.categoryIdentifier = outcomeCategory
        content.sound = .default
        let request = UNNotificationRequest(identifier: "flow-outcome-\(pane)", content: content, trigger: nil)
        try? await UNUserNotificationCenter.current().add(request)
    }
}

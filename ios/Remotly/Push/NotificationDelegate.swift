// UNUserNotificationCenter delegate: suppresses banners for the pane being viewed, opens the pane on tap, and runs
// the notification actions (Approve / Deny / Deny with feedback / Reply) and Live Activity buttons through a
// short-lived `mode:"action"` connection.
import ActivityKit
import FlowKit
import Foundation
import UIKit
import UserNotifications

final class NotificationDelegate: NSObject, UNUserNotificationCenterDelegate {
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        guard let payload = PushPayload(userInfo: notification.request.content.userInfo) else {
            return [.banner, .list, .sound]
        }
        let viewingSamePane = await MainActor.run {
            // A "finished" push reaching the foreground app means the bridge has disarmed the pane.
            if payload.isDone { AppModel.shared.onDoneDelivered(payload.pane) }
            return AppModel.shared.isForeground && AppModel.shared.watchedPane == payload.pane
        }
        return viewingSamePane ? [] : [.banner, .list, .sound]
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        guard let payload = PushPayload(userInfo: response.notification.request.content.userInfo) else { return }
        let typed = ((response as? UNTextInputNotificationResponse)?.userText ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        switch response.actionIdentifier {
        case FlowNotifications.approveAction:
            await NotificationActions.perform(.approve, payload: payload)
        case FlowNotifications.denyAction:
            await NotificationActions.perform(.deny, payload: payload)
        case FlowNotifications.denyFeedbackAction:
            await NotificationActions.perform(.denyFeedback, payload: payload, feedback: typed.isEmpty ? nil : typed)
        case FlowNotifications.replyAction:
            await NotificationActions.reply(typed, payload: payload, notificationId: response.notification.request.identifier)
        case UNNotificationDefaultActionIdentifier:
            await MainActor.run { AppModel.shared.openPane(payload.pane) }
        default:
            break
        }
    }
}

enum NotificationActions {
    /// Background action: pair record from the Keychain → action connection → approve → outcome
    /// notification. Bounded by a background task and a 20 s deadline.
    @discardableResult
    static func perform(_ action: ApprovalAction, payload: PushPayload, feedback: String? = nil) async -> ApprovalOutcomeSummary? {
        let lifetime = await MainActor.run { AppModel.shared.realConnectionLifetime }
        guard lifetime.isActive else { return nil }
        let backgroundTask = await MainActor.run {
            UIApplication.shared.beginBackgroundTask(withName: "flow.approval", expirationHandler: nil)
        }
        defer {
            Task { @MainActor in UIApplication.shared.endBackgroundTask(backgroundTask) }
        }
        guard let host = (try? HostStore().load()) ?? nil else {
            await FlowNotifications.postOutcome(title: "Remotly is not paired", body: "Open Remotly and pair with a host.", pane: payload.pane)
            return nil
        }
        let summary = await ApprovalActionClient.perform(action: action, payload: payload, host: host,
                                                         client: AppInfo.clientInfo(deviceName: "iPhone"), feedback: feedback, timeout: .seconds(20), lifetime: lifetime)
        guard lifetime.isActive else { return nil }
        await FlowNotifications.postOutcome(title: summary.title, body: summary.body, pane: payload.pane)
        if summary.result?.outcome == .sent || summary.result?.outcome == .stale || summary.result?.outcome == .notBlocked {
            // The prompt is resolved either way; drop the banner the user acted on.
            UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: [payload.pane])
        }
        return summary
    }

    /// Reply typed into a "finished" notification: sent as the pane's next prompt, armed again when the setting says so.
    static func reply(_ text: String, payload: PushPayload, notificationId: String) async {
        let lifetime = await MainActor.run { AppModel.shared.realConnectionLifetime }
        guard lifetime.isActive else { return }
        let backgroundTask = await MainActor.run {
            UIApplication.shared.beginBackgroundTask(withName: "flow.reply", expirationHandler: nil)
        }
        defer {
            Task { @MainActor in UIApplication.shared.endBackgroundTask(backgroundTask) }
        }
        guard let host = (try? HostStore().load()) ?? nil else {
            await FlowNotifications.postOutcome(title: "Remotly is not paired", body: "Open Remotly and pair with a host.", pane: payload.pane)
            return
        }
        let notify = FlowSettings.notifyOnPrompt
        let summary = await ApprovalActionClient.reply(text: text, notify: notify, pane: payload.pane, agent: payload.agent, host: host,
                                                       client: AppInfo.clientInfo(deviceName: "iPhone"), timeout: .seconds(20), lifetime: lifetime)
        guard lifetime.isActive else { return }
        await FlowNotifications.postOutcome(title: summary.title, body: summary.body, pane: payload.pane)
        if summary.sent {
            UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: [notificationId])
            if notify { await MainActor.run { AppModel.shared.onArmedFromNotification(payload.pane) } }
        }
    }

    /// Approve / Deny tapped on the Live Activity. Runs in the app's process (LiveActivityIntent). Live Activity buttons
    /// cannot ask for Face ID, so with "Require unlock to approve" on, a locked phone only gets a hint on the activity.
    static func performFromActivity(action: ApprovalAction, pane: String, promptId: String, agent: String, host: String) async {
        guard await MainActor.run(body: { !AppModel.shared.isDemo }) else { return }
        let locked = await MainActor.run { !UIApplication.shared.isProtectedDataAvailable }
        if locked && FlowSettings.requireUnlock {
            await LiveActivityFeedback.show(pane: pane, detail: "Unlock your iPhone, then tap again")
            return
        }
        await LiveActivityFeedback.show(pane: pane, detail: "Sending \(action.title.lowercased())…")
        let payload = PushPayload(kind: .approval, host: host, pane: pane, promptId: promptId, agent: agent)
        if let summary = await perform(action, payload: payload) {
            await LiveActivityFeedback.show(pane: pane, detail: summary.title)
        }
    }
}

/// Writes a line into the pane's Live Activity from the app; the bridge's next status push replaces it.
enum LiveActivityFeedback {
    static func show(pane: String, detail: String) async {
        for activity in Activity<FlowActivityAttributes>.activities where activity.attributes.pane == pane {
            var state = activity.content.state
            state.detail = detail
            await activity.update(ActivityContent(state: state, staleDate: nil))
        }
    }
}

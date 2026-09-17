// User preferences behind the Notifications section of Settings (UserDefaults, all default on). Read by the
// notification delegate and the Live Activity intent as well as by views, hence plain statics.
import FlowKit
import Foundation
import UserNotifications

enum FlowSettings {
    static let notifyOnPromptKey = "notifyOnPrompt"
    static let requireUnlockKey = "requireUnlockToApprove"
    static let liveActivitiesKey = "liveActivities"

    /// Every prompt sent from this phone arms "tell me when it's done" for its pane.
    static var notifyOnPrompt: Bool { flag(notifyOnPromptKey) }
    /// Approve, Deny with feedback and Reply from a notification or Live Activity need an unlocked phone.
    static var requireUnlock: Bool { flag(requireUnlockKey) }
    /// Live Activity (Lock Screen / Dynamic Island) per working agent, started by the bridge over push.
    static var liveActivities: Bool { flag(liveActivitiesKey) }

    private static func flag(_ key: String) -> Bool { (UserDefaults.standard.object(forKey: key) as? Bool) ?? true }

    /// (Re)registers the notification categories with the current unlock rule.
    static func applyNotificationCategories() {
        UNUserNotificationCenter.current().setNotificationCategories(FlowNotifications.categories(requireUnlock: requireUnlock))
    }
}

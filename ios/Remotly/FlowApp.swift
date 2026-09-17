// App entry point. The AppDelegate adaptor handles APNs registration; notification presentation and
// actions live in NotificationDelegate.
import FlowKit
import SwiftUI
import UIKit
import UserNotifications

@main
struct FlowApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(AppModel.shared)
        }
    }
}

@MainActor
final class AppDelegate: NSObject, UIApplicationDelegate {
    private let notificationDelegate = NotificationDelegate()

    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        let center = UNUserNotificationCenter.current()
        center.delegate = notificationDelegate
        center.setNotificationCategories(FlowNotifications.categories(requireUnlock: FlowSettings.requireUnlock))
        // A device token is available regardless of alert permission; the bridge only pushes to
        // registered tokens, and the user grants alerts from Settings → Notifications.
        application.registerForRemoteNotifications()
        // Also runs when iOS wakes the app in the background for a push-to-start Live Activity: that is the
        // only moment to catch the activity's update token and hand it to the bridge.
        AppModel.shared.startObservingActivities()
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
        AppModel.shared.setPushToken(hex)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        AppModel.shared.lastError = "Push registration failed: \(error.localizedDescription)"
    }
}

// Bundle facts used in `hello` and `POST /pair`.
import FlowKit
import Foundation

enum AppInfo {
    static var version: String {
        let info = Bundle.main.infoDictionary
        let short = (info?["CFBundleShortVersionString"] as? String) ?? "0"
        let build = (info?["CFBundleVersion"] as? String) ?? "0"
        return "\(short) (\(build))"
    }

    static var bundleIdentifier: String { Bundle.main.bundleIdentifier ?? "com.inferenceaftermath.remotly" }

    static func clientInfo(deviceName: String) -> ClientInfo {
        ClientInfo(platform: "ios", appVersion: version, deviceName: deviceName)
    }
}

// Client → server messages (shared/protocol/remotly-protocol.md §4) and the key names of §5.
import Foundation

public enum HelloMode: String, Sendable { case full, action }
public enum ZoomMode: String, Sendable { case toggle, on, off }
public enum PushEnvironment: String, Sendable { case sandbox, production }

public enum ApprovalAction: String, CaseIterable, Sendable {
    case approve
    case approveSession = "approve_session"
    case deny
    case denyFeedback = "deny_feedback"
    case interrupt
}

public struct ClientInfo: Encodable, Hashable, Sendable {
    public var platform: String
    public var appVersion: String
    public var deviceName: String

    enum CodingKeys: String, CodingKey { case platform, appVersion = "app_version", deviceName = "device_name" }

    public init(platform: String = "ios", appVersion: String, deviceName: String) {
        self.platform = platform
        self.appVersion = String(appVersion.prefix(32))
        self.deviceName = String(deviceName.trimmingCharacters(in: .whitespacesAndNewlines).prefix(64))
    }
}

public enum ClientMessage: Sendable {
    case hello(token: String, client: ClientInfo, mode: HelloMode)
    /// `zoom`: the bridge zooms the pane on the desktop while this device watches it (§4 `watch {zoom:true}`).
    case watch(id: String, pane: String, zoom: Bool = false)
    case unwatch(id: String, pane: String)
    case history(id: String, pane: String, lines: Int, unwrapped: Bool)
    case keys(id: String, pane: String, keys: [String])
    /// Touch scrolling forwarded to the program: `wheel` = SGR mouse-wheel reports, `arrows` = Up/Down keys (§4 `scroll`).
    case scroll(id: String, pane: String, direction: String, lines: Int, mode: String, col: Int, row: Int)
    /// New terminal (herdr tab) on the desktop, optionally running `command` once its shell is up (§4 `pane.create`).
    case paneCreate(id: String, label: String?, command: String?)
    /// Close the pane on the desktop: its shell and whatever runs in it end (§4 `pane.close`).
    case paneClose(id: String, pane: String)
    case text(id: String, pane: String, text: String)
    /// `notify` arms "tell me when it's done" for this device in the same request (§4 `prompt`).
    case prompt(id: String, pane: String, text: String, notify: Bool)
    /// Arm/disarm the "tell me when it's done" alert for this device on a pane (§4 `notify`).
    case notify(id: String, pane: String, done: Bool)
    /// Live Activity tokens: `pane == nil` hands over the push-to-start token, otherwise the activity's update token (§4 `activity.register`).
    case activityRegister(id: String, token: String?, pane: String?)
    case activityUnregister(id: String, pane: String?)
    case approve(id: String, pane: String, promptId: String, action: ApprovalAction, feedback: String?, force: Bool)
    /// Answer the dialog on screen by moving its cursor to `option` (1-based) and pressing Enter; `label` guards against a changed menu.
    case choose(id: String, pane: String, promptId: String, option: Int, label: String)
    case zoom(id: String, pane: String, mode: ZoomMode)
    /// Resize the pane's PTY on the desktop to this device's grid; `release` gives it back (§4 `fit`).
    case fit(id: String, pane: String, cols: Int?, rows: Int?, release: Bool)
    /// `pane == nil` encodes `"pane": null`. Fire-and-forget unless `id` is present.
    case viewing(pane: String?, id: String?)
    case pushRegister(id: String, platform: String, token: String, env: PushEnvironment)
    case pushUnregister(id: String)

    public var type: String {
        switch self {
        case .hello: return "hello"
        case .watch: return "watch"
        case .unwatch: return "unwatch"
        case .history: return "history"
        case .keys: return "keys"
        case .scroll: return "scroll"
        case .paneCreate: return "pane.create"
        case .paneClose: return "pane.close"
        case .text: return "text"
        case .prompt: return "prompt"
        case .notify: return "notify"
        case .activityRegister: return "activity.register"
        case .activityUnregister: return "activity.unregister"
        case .approve: return "approve"
        case .choose: return "choose"
        case .zoom: return "zoom"
        case .fit: return "fit"
        case .viewing: return "viewing"
        case .pushRegister: return "push.register"
        case .pushUnregister: return "push.unregister"
        }
    }
}

struct AnyKey: CodingKey, ExpressibleByStringLiteral {
    var stringValue: String
    var intValue: Int? { nil }
    init(stringValue: String) { self.stringValue = stringValue }
    init?(intValue: Int) { return nil }
    init(stringLiteral value: String) { stringValue = value }
}

extension ClientMessage: Encodable {
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: AnyKey.self)
        try c.encode(type, forKey: "t")
        switch self {
        case .hello(let token, let client, let mode):
            try c.encode(token, forKey: "token")
            try c.encode(client, forKey: "client")
            try c.encode(mode.rawValue, forKey: "mode")
        case .watch(let id, let pane, let zoom):
            try c.encode(id, forKey: "id")
            try c.encode(pane, forKey: "pane")
            if zoom { try c.encode(true, forKey: "zoom") }
        case .unwatch(let id, let pane), .paneClose(let id, let pane):
            try c.encode(id, forKey: "id")
            try c.encode(pane, forKey: "pane")
        case .history(let id, let pane, let lines, let unwrapped):
            try c.encode(id, forKey: "id")
            try c.encode(pane, forKey: "pane")
            try c.encode(min(max(lines, 1), 999), forKey: "lines")
            if unwrapped { try c.encode(true, forKey: "unwrapped") }
        case .keys(let id, let pane, let keys):
            try c.encode(id, forKey: "id")
            try c.encode(pane, forKey: "pane")
            try c.encode(keys, forKey: "keys")
        case .scroll(let id, let pane, let direction, let lines, let mode, let col, let row):
            try c.encode(id, forKey: "id")
            try c.encode(pane, forKey: "pane")
            try c.encode(direction, forKey: "direction")
            try c.encode(min(max(lines, 1), 50), forKey: "lines")
            try c.encode(mode, forKey: "mode")
            try c.encode(col, forKey: "col")
            try c.encode(row, forKey: "row")
        case .paneCreate(let id, let label, let command):
            try c.encode(id, forKey: "id")
            if let label, !label.isEmpty { try c.encode(label, forKey: "label") }
            if let command, !command.isEmpty { try c.encode(command, forKey: "command") }
        case .text(let id, let pane, let text):
            try c.encode(id, forKey: "id")
            try c.encode(pane, forKey: "pane")
            try c.encode(text, forKey: "text")
        case .prompt(let id, let pane, let text, let notify):
            try c.encode(id, forKey: "id")
            try c.encode(pane, forKey: "pane")
            try c.encode(text, forKey: "text")
            if notify { try c.encode(true, forKey: "notify") }
        case .notify(let id, let pane, let done):
            try c.encode(id, forKey: "id")
            try c.encode(pane, forKey: "pane")
            try c.encode(done, forKey: "done")
        case .activityRegister(let id, let token, let pane):
            try c.encode(id, forKey: "id")
            if let token { try c.encode(token, forKey: "token") }
            if let pane { try c.encode(pane, forKey: "pane") }
        case .activityUnregister(let id, let pane):
            try c.encode(id, forKey: "id")
            if let pane { try c.encode(pane, forKey: "pane") }
        case .approve(let id, let pane, let promptId, let action, let feedback, let force):
            try c.encode(id, forKey: "id")
            try c.encode(pane, forKey: "pane")
            try c.encode(promptId, forKey: "prompt_id")
            try c.encode(action.rawValue, forKey: "action")
            if let feedback { try c.encode(feedback, forKey: "feedback") }
            if force { try c.encode(true, forKey: "force") }
        case .choose(let id, let pane, let promptId, let option, let label):
            try c.encode(id, forKey: "id")
            try c.encode(pane, forKey: "pane")
            try c.encode(promptId, forKey: "prompt_id")
            try c.encode(option, forKey: "option")
            try c.encode(label, forKey: "label")
        case .zoom(let id, let pane, let mode):
            try c.encode(id, forKey: "id")
            try c.encode(pane, forKey: "pane")
            try c.encode(mode.rawValue, forKey: "mode")
        case .fit(let id, let pane, let cols, let rows, let release):
            try c.encode(id, forKey: "id")
            try c.encode(pane, forKey: "pane")
            if let cols { try c.encode(cols, forKey: "cols") }
            if let rows { try c.encode(rows, forKey: "rows") }
            if release { try c.encode(true, forKey: "release") }
        case .viewing(let pane, let id):
            if let pane { try c.encode(pane, forKey: "pane") } else { try c.encodeNil(forKey: "pane") }
            if let id { try c.encode(id, forKey: "id") }
        case .pushRegister(let id, let platform, let token, let env):
            try c.encode(id, forKey: "id")
            try c.encode(platform, forKey: "platform")
            try c.encode(token, forKey: "token")
            try c.encode(env.rawValue, forKey: "env")
        case .pushUnregister(let id):
            try c.encode(id, forKey: "id")
        }
    }

    /// One WebSocket text message.
    public func encoded() throws -> String {
        let data = try JSONEncoder().encode(self)
        guard let text = String(data: data, encoding: .utf8) else { throw FlowError.encoding }
        return text
    }
}

/// herdr key names accepted by `keys` (§5). Names are lower-case and case-sensitive.
public enum KeyName {
    public static let esc = "esc"
    public static let tab = "tab"
    public static let enter = "enter"
    public static let backspace = "backspace"
    public static let up = "up"
    public static let down = "down"
    public static let left = "left"
    public static let right = "right"
    public static let space = "space"
    public static let home = "home"
    public static let end = "end"
    public static let pageUp = "pageup"
    public static let pageDown = "pagedown"
    public static let delete = "delete"
    public static let insert = "insert"
    public static let shiftTab = "shift+tab"
    public static let shiftEnter = "shift+enter"

    /// `ctrl+<x>` for a single lower-case letter or one of `[ ] \ ^ _`.
    public static func ctrl(_ key: Character) -> String { "ctrl+\(String(key).lowercased())" }
    public static func alt(_ key: Character) -> String { "alt+\(String(key).lowercased())" }
    public static func function(_ n: Int) -> String { "f\(min(max(n, 1), 12))" }
}

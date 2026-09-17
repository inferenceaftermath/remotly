// Server → client messages of the Remotly protocol v1 (shared/protocol/remotly-protocol.md §6–§7).
// Field names follow the wire format exactly; Swift names are camelCase via explicit CodingKeys.
import Foundation

/// Protocol version implemented by this package.
public let flowProtocolVersion = 1

// MARK: - Frames (§7)

/// A run covers `w` cells from column `c`: either narrow characters (one cell each) or exactly one
/// wide grapheme (`w == 2`). `s` is a per-connection style id (integer on the wire).
public struct WireRun: Codable, Hashable, Sendable {
    public var c: Int
    public var w: Int
    public var s: Int
    public var t: String
    public init(c: Int, w: Int, s: Int, t: String) { self.c = c; self.w = w; self.s = s; self.t = t }
}

public struct WireLine: Codable, Hashable, Sendable {
    public var y: Int
    public var runs: [WireRun]
    public init(y: Int, runs: [WireRun]) { self.y = y; self.runs = runs }
}

public struct HistoryLine: Codable, Hashable, Sendable {
    public var runs: [WireRun]
    public init(runs: [WireRun]) { self.runs = runs }
}

public struct Frame: Codable, Hashable, Sendable {
    public var pane: String
    public var rev: Int
    public var cols: Int
    public var rows: Int
    public var full: Bool
    public var lines: [WireLine]
    /// Only ids not yet sent on this connection; keys are strings on the wire.
    public var styles: [String: Style]
    /// True while an alternate-screen program (Claude Code, vim, tmux, less) is in the pane's foreground; nil when the bridge does not know yet.
    public var alt: Bool?

    public init(pane: String, rev: Int, cols: Int, rows: Int, full: Bool, lines: [WireLine], styles: [String: Style] = [:], alt: Bool? = nil) {
        self.pane = pane; self.rev = rev; self.cols = cols; self.rows = rows
        self.full = full; self.lines = lines; self.styles = styles; self.alt = alt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        pane = try c.decode(String.self, forKey: .pane)
        rev = try c.decodeIfPresent(Int.self, forKey: .rev) ?? 0
        cols = try c.decode(Int.self, forKey: .cols)
        rows = try c.decode(Int.self, forKey: .rows)
        full = try c.decodeIfPresent(Bool.self, forKey: .full) ?? false
        lines = try c.decodeIfPresent([WireLine].self, forKey: .lines) ?? []
        styles = try c.decodeIfPresent([String: Style].self, forKey: .styles) ?? [:]
        alt = try c.decodeIfPresent(Bool.self, forKey: .alt)
    }
}

public struct HistoryMessage: Decodable, Sendable {
    public var id: String
    public var pane: String
    public var lines: [HistoryLine]
    public var styles: [String: Style]
    public var hasMore: Bool
    /// Lines herdr holds above the screen; 0 means nothing older exists (the program draws its own screen, or a fresh shell). nil from an older bridge.
    public var scrollback: Int?

    enum CodingKeys: String, CodingKey { case id, pane, lines, styles, hasMore = "has_more", scrollback }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try decodeID(from: c, forKey: .id) ?? ""
        pane = try c.decode(String.self, forKey: .pane)
        lines = try c.decodeIfPresent([HistoryLine].self, forKey: .lines) ?? []
        styles = try c.decodeIfPresent([String: Style].self, forKey: .styles) ?? [:]
        hasMore = try c.decodeIfPresent(Bool.self, forKey: .hasMore) ?? false
        scrollback = try c.decodeIfPresent(Int.self, forKey: .scrollback)
    }
}

// MARK: - Approvals, host state, welcome, ok, error

public struct ApprovalOutcome: RawRepresentable, Codable, Hashable, Sendable {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public init(from decoder: Decoder) throws { rawValue = try decoder.singleValueContainer().decode(String.self) }
    public func encode(to encoder: Encoder) throws { var c = encoder.singleValueContainer(); try c.encode(rawValue) }
    public static let sent = ApprovalOutcome(rawValue: "sent")
    public static let stale = ApprovalOutcome(rawValue: "stale")
    public static let notBlocked = ApprovalOutcome(rawValue: "not_blocked")
    public static let signatureMismatch = ApprovalOutcome(rawValue: "signature_mismatch")
    /// `choose`: the menu on screen no longer matches what the phone showed; nothing was sent.
    public static let dialogChanged = ApprovalOutcome(rawValue: "dialog_changed")
    public static let failed = ApprovalOutcome(rawValue: "failed")
}

public struct ApprovalResult: Codable, Hashable, Sendable {
    public var pane: String
    public var promptId: String
    public var outcome: ApprovalOutcome
    public var detail: String?
    public var statusAfter: AgentStatus?

    enum CodingKeys: String, CodingKey { case pane, outcome, detail, promptId = "prompt_id", statusAfter = "status_after" }

    public init(pane: String, promptId: String, outcome: ApprovalOutcome, detail: String? = nil, statusAfter: AgentStatus? = nil) {
        self.pane = pane; self.promptId = promptId; self.outcome = outcome; self.detail = detail; self.statusAfter = statusAfter
    }
}

public struct HerdrStateMessage: Decodable, Hashable, Sendable {
    public var state: String
    public var isUp: Bool { state == "up" }
}

public struct Welcome: Decodable, Hashable, Sendable {
    public struct HostInfo: Decodable, Hashable, Sendable {
        public var name: String
        public var herdrVersion: String?
        public var herdrProtocol: Int?
        public var flowVersion: String?
        enum CodingKeys: String, CodingKey {
            case name, herdrVersion = "herdr_version", herdrProtocol = "herdr_protocol", flowVersion = "flow_version"
        }
    }

    public struct DeviceInfo: Decodable, Hashable, Sendable {
        public var id: String
        public var name: String
    }

    public var `protocol`: Int
    public var host: HostInfo
    public var device: DeviceInfo
    public var snapshot: Snapshot?
    /// Panes this device asked to be told about when their agent finishes (§6 `notify_done`; full mode only).
    public var notifyDone: [String]

    enum CodingKeys: String, CodingKey { case `protocol`, host, device, snapshot, notifyDone = "notify_done" }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        `protocol` = try c.decode(Int.self, forKey: .`protocol`)
        host = try c.decode(HostInfo.self, forKey: .host)
        device = try c.decode(DeviceInfo.self, forKey: .device)
        snapshot = try c.decodeIfPresent(Snapshot.self, forKey: .snapshot)
        notifyDone = try c.decodeIfPresent([String].self, forKey: .notifyDone) ?? []
    }
}

/// The bridge changed this device's "tell me when it's done" arming on its own (the alert fired).
public struct NotifyStateMessage: Decodable, Hashable, Sendable {
    public var pane: String
    public var done: Bool
}

/// `ok` replies. `watch` → `cols`/`rows`; `zoom` → `zoomed`; `pane.create` → `pane`/`tab`; `notify` → `done`; other result fields are ignored.
public struct OKMessage: Decodable, Sendable {
    public var id: String
    public var cols: Int?
    public var rows: Int?
    public var zoomed: Bool?
    public var pane: String?
    public var tab: String?
    public var done: Bool?

    enum CodingKeys: String, CodingKey { case id, cols, rows, zoomed, pane, tab, done }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try decodeID(from: c, forKey: .id) ?? ""
        cols = try c.decodeIfPresent(Int.self, forKey: .cols)
        rows = try c.decodeIfPresent(Int.self, forKey: .rows)
        zoomed = try c.decodeIfPresent(Bool.self, forKey: .zoomed)
        pane = try c.decodeIfPresent(String.self, forKey: .pane)
        tab = try c.decodeIfPresent(String.self, forKey: .tab)
        done = try c.decodeIfPresent(Bool.self, forKey: .done)
    }
}

public struct ErrorCode: RawRepresentable, Codable, Hashable, Sendable {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public init(from decoder: Decoder) throws { rawValue = try decoder.singleValueContainer().decode(String.self) }
    public func encode(to encoder: Encoder) throws { var c = encoder.singleValueContainer(); try c.encode(rawValue) }
    public static let auth = ErrorCode(rawValue: "auth")
    public static let badRequest = ErrorCode(rawValue: "bad_request")
    public static let unknownPane = ErrorCode(rawValue: "unknown_pane")
    public static let notWatching = ErrorCode(rawValue: "not_watching")
    public static let herdrDown = ErrorCode(rawValue: "herdr_down")
    public static let herdrError = ErrorCode(rawValue: "herdr_error")
    public static let unsupportedAgent = ErrorCode(rawValue: "unsupported_agent")
    public static let invalidKey = ErrorCode(rawValue: "invalid_key")
    public static let unsupported = ErrorCode(rawValue: "unsupported")
}

public struct ErrorMessage: Decodable, Hashable, Sendable {
    public var id: String?
    public var code: ErrorCode
    public var message: String

    enum CodingKeys: String, CodingKey { case id, code, message }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try decodeID(from: c, forKey: .id)
        code = try c.decodeIfPresent(ErrorCode.self, forKey: .code) ?? ErrorCode(rawValue: "unknown")
        message = try c.decodeIfPresent(String.self, forKey: .message) ?? ""
    }
}

/// Request ids are strings on the wire; tolerate numbers from older bridges.
func decodeID<K: CodingKey>(from container: KeyedDecodingContainer<K>, forKey key: K) throws -> String? {
    if let s = try? container.decodeIfPresent(String.self, forKey: key) { return s }
    if let n = try? container.decodeIfPresent(Int.self, forKey: key) { return String(n) }
    return nil
}

// MARK: - Envelope

/// Every server message, keyed on `t`. Unknown types decode as `.unknown` so a newer bridge does
/// not break an older app.
public enum ServerMessage: Sendable {
    case welcome(Welcome)
    case snapshot(Snapshot)
    case paneStatus(PaneStatus)
    case frame(Frame)
    case history(HistoryMessage)
    case approvalResult(ApprovalResult)
    case notifyState(NotifyStateMessage)
    case herdr(HerdrStateMessage)
    case ok(OKMessage)
    case error(ErrorMessage)
    case unknown(type: String)
}

extension ServerMessage: Decodable {
    private enum TypeKey: String, CodingKey { case t }

    public init(from decoder: Decoder) throws {
        let type = try decoder.container(keyedBy: TypeKey.self).decode(String.self, forKey: .t)
        switch type {
        case "welcome": self = .welcome(try Welcome(from: decoder))
        case "snapshot": self = .snapshot(try Snapshot(from: decoder))
        case "pane.status": self = .paneStatus(try PaneStatus(from: decoder))
        case "frame": self = .frame(try Frame(from: decoder))
        case "history": self = .history(try HistoryMessage(from: decoder))
        case "approval.result": self = .approvalResult(try ApprovalResult(from: decoder))
        case "notify.state": self = .notifyState(try NotifyStateMessage(from: decoder))
        case "herdr": self = .herdr(try HerdrStateMessage(from: decoder))
        case "ok": self = .ok(try OKMessage(from: decoder))
        case "error": self = .error(try ErrorMessage(from: decoder))
        default: self = .unknown(type: type)
        }
    }

    /// Decodes one WebSocket text message.
    public static func decode(_ data: Data) throws -> ServerMessage {
        try JSONDecoder().decode(ServerMessage.self, from: data)
    }
}

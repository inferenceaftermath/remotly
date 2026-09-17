// Workspace / tab / pane snapshot and pane.status (shared/protocol/remotly-protocol.md §6).
import Foundation

// MARK: - Snapshot and status (§6)

/// herdr agent status. A struct rather than an enum so unknown future values still decode.
public struct AgentStatus: RawRepresentable, Codable, Hashable, Sendable {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public init(from decoder: Decoder) throws { rawValue = try decoder.singleValueContainer().decode(String.self) }
    public func encode(to encoder: Encoder) throws { var c = encoder.singleValueContainer(); try c.encode(rawValue) }

    public static let idle = AgentStatus(rawValue: "idle")
    public static let working = AgentStatus(rawValue: "working")
    public static let blocked = AgentStatus(rawValue: "blocked")
    public static let done = AgentStatus(rawValue: "done")
    public static let unknown = AgentStatus(rawValue: "unknown")

    /// Sort order for pane lists: blocked → working → idle → done → everything else.
    public var sortRank: Int {
        switch self {
        case .blocked: return 0
        case .working: return 1
        case .idle: return 2
        case .done: return 3
        default: return 4
        }
    }
}

public struct Workspace: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var name: String
    public init(id: String, name: String) { self.id = id; self.name = name }
}

public struct Tab: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var workspaceId: String
    public var name: String
    enum CodingKeys: String, CodingKey { case id, workspaceId = "workspace_id", name }
    public init(id: String, workspaceId: String, name: String) { self.id = id; self.workspaceId = workspaceId; self.name = name }
}

/// The bridge's structured reading of the agent's approval dialog (§6 `approval`): present only while the pane is
/// blocked and the screen parsed. All but `question`/`options` may be absent.
public struct ApprovalDetails: Codable, Hashable, Sendable {
    public var tool: String?
    public var command: String?
    public var path: String?
    public var description: String?
    public var question: String
    public var options: [String]
    /// 1-based index of the option carrying the desktop's selection marker, when visible.
    public var selected: Int?
    /// `permission` (a tool about to run: yes/no) or `choice` (AskUserQuestion menus, pickers).
    public var kind: String

    public init(tool: String? = nil, command: String? = nil, path: String? = nil, description: String? = nil,
                question: String = "", options: [String] = [], selected: Int? = nil, kind: String = "permission") {
        self.tool = tool; self.command = command; self.path = path; self.description = description
        self.question = question; self.options = options; self.selected = selected; self.kind = kind
    }

    public var isChoice: Bool { kind == "choice" }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        tool = try c.decodeIfPresent(String.self, forKey: .tool)
        command = try c.decodeIfPresent(String.self, forKey: .command)
        path = try c.decodeIfPresent(String.self, forKey: .path)
        description = try c.decodeIfPresent(String.self, forKey: .description)
        question = try c.decodeIfPresent(String.self, forKey: .question) ?? ""
        options = try c.decodeIfPresent([String].self, forKey: .options) ?? []
        selected = try c.decodeIfPresent(Int.self, forKey: .selected)
        kind = try c.decodeIfPresent(String.self, forKey: .kind) ?? "permission"
    }

    /// What runs, in the dialog's words: the command or file with its tool (`Bash: npm test`), else the question.
    public var headline: String {
        guard let what = command ?? path else { return question }
        return tool.map { "\($0): \(what)" } ?? what
    }
}

public struct Pane: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var tabId: String
    public var workspaceId: String
    public var title: String
    public var agent: String?
    public var displayAgent: String?
    public var agentStatus: AgentStatus
    public var stateLabel: String?
    public var cwd: String?
    public var focused: Bool
    /// Present only while `agentStatus == .blocked`.
    public var promptId: String?
    /// The parsed approval dialog; only while blocked, and only when the bridge could read one.
    public var approval: ApprovalDetails?
    /// Milliseconds since the epoch when the agent began its current stretch of work (`working`, carried through
    /// `blocked`); nil when idle, done, unknown, or from a bridge that does not send it. Drives the elapsed times.
    public var since: Int?

    enum CodingKeys: String, CodingKey {
        case id, title, agent, cwd, focused, approval, since
        case tabId = "tab_id"
        case workspaceId = "workspace_id"
        case displayAgent = "display_agent"
        case agentStatus = "agent_status"
        case stateLabel = "state_label"
        case promptId = "prompt_id"
    }

    public init(id: String, tabId: String, workspaceId: String, title: String, agent: String? = nil, displayAgent: String? = nil,
                agentStatus: AgentStatus = .unknown, stateLabel: String? = nil, cwd: String? = nil, focused: Bool = false, promptId: String? = nil,
                approval: ApprovalDetails? = nil, since: Int? = nil) {
        self.id = id; self.tabId = tabId; self.workspaceId = workspaceId; self.title = title; self.agent = agent
        self.displayAgent = displayAgent; self.agentStatus = agentStatus; self.stateLabel = stateLabel; self.cwd = cwd
        self.focused = focused; self.promptId = promptId; self.approval = approval; self.since = since
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        tabId = try c.decodeIfPresent(String.self, forKey: .tabId) ?? ""
        workspaceId = try c.decodeIfPresent(String.self, forKey: .workspaceId) ?? ""
        title = try c.decodeIfPresent(String.self, forKey: .title) ?? id
        agent = try c.decodeIfPresent(String.self, forKey: .agent)
        displayAgent = try c.decodeIfPresent(String.self, forKey: .displayAgent)
        agentStatus = try c.decodeIfPresent(AgentStatus.self, forKey: .agentStatus) ?? .unknown
        stateLabel = try c.decodeIfPresent(String.self, forKey: .stateLabel)
        cwd = try c.decodeIfPresent(String.self, forKey: .cwd)
        focused = try c.decodeIfPresent(Bool.self, forKey: .focused) ?? false
        promptId = try c.decodeIfPresent(String.self, forKey: .promptId)
        approval = try c.decodeIfPresent(ApprovalDetails.self, forKey: .approval)
        since = try c.decodeIfPresent(Int.self, forKey: .since)
    }

    /// A coding agent runs here (herdr names it by id and/or display name); false for a plain shell.
    public var hasAgent: Bool { !(agent ?? "").isEmpty || !(displayAgent ?? "").isEmpty }
    public var isBlocked: Bool { agentStatus == .blocked }
}

public struct Snapshot: Codable, Hashable, Sendable {
    public var workspaces: [Workspace]
    public var tabs: [Tab]
    public var panes: [Pane]
    public var focusedPaneId: String?

    enum CodingKeys: String, CodingKey { case workspaces, tabs, panes, focusedPaneId = "focused_pane_id" }

    public init(workspaces: [Workspace] = [], tabs: [Tab] = [], panes: [Pane] = [], focusedPaneId: String? = nil) {
        self.workspaces = workspaces; self.tabs = tabs; self.panes = panes; self.focusedPaneId = focusedPaneId
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        workspaces = try c.decodeIfPresent([Workspace].self, forKey: .workspaces) ?? []
        tabs = try c.decodeIfPresent([Tab].self, forKey: .tabs) ?? []
        panes = try c.decodeIfPresent([Pane].self, forKey: .panes) ?? []
        focusedPaneId = try c.decodeIfPresent(String.self, forKey: .focusedPaneId)
    }

    /// prompt ids of every currently blocked pane (used to clear stale notifications).
    public var livePromptIds: Set<String> { Set(panes.compactMap(\.promptId)) }
}

public struct PaneStatus: Codable, Hashable, Sendable {
    public var pane: String
    public var agentStatus: AgentStatus
    public var agent: String?
    public var displayAgent: String?
    public var title: String?
    public var stateLabel: String?
    public var promptId: String?
    public var approval: ApprovalDetails?
    /// See `Pane.since`; nil when the agent is not working (or the bridge predates the field).
    public var since: Int?

    enum CodingKeys: String, CodingKey {
        case pane, agent, title, approval, since
        case agentStatus = "agent_status"
        case displayAgent = "display_agent"
        case stateLabel = "state_label"
        case promptId = "prompt_id"
    }
}

// Live Activity of one working agent, started, updated and ended by the bridge over APNs
// (shared/protocol/remotly-protocol.md §9). Compiled into the app and the FlowActivity widget extension. The type
// name and every field are the wire contract: `attributes-type`, `attributes` and `content-state` of the push.
import ActivityKit
import Foundation

struct FlowActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        /// herdr agent status: working | blocked | idle | done | unknown.
        var status: String
        /// Start of this stretch of work, seconds since the epoch; the elapsed timer counts from here.
        var since: Int
        /// Pane title.
        var title: String
        /// Present while blocked: the prompt the Approve / Deny buttons answer.
        var promptId: String?
        /// One line about the pending approval (`Bash: npm test`), or a note from the app after a button tap.
        var detail: String?
        /// While blocked: `permission` (Approve / Deny apply) or `choice` (a menu to answer in the app). Older bridges omit it.
        var kind: String?

        var isBlocked: Bool { status == "blocked" }
        var isChoice: Bool { kind == "choice" }
        var isWorking: Bool { status == "working" }
    }

    var pane: String
    var host: String
    var agent: String
    var displayAgent: String

    var displayName: String { displayAgent.isEmpty ? (agent.isEmpty ? "Agent" : agent) : displayAgent }
}

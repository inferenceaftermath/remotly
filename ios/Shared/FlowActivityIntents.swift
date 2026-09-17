// Approve / Deny from the Live Activity (Lock Screen, Dynamic Island). A `LiveActivityIntent` runs inside the
// app's process, so the app performs it exactly like a notification action (see NotificationActions); the
// FlowActivity widget extension only needs the type to build its buttons, hence the REMOTLY_APP guard.
import AppIntents

struct FlowApprovalIntent: LiveActivityIntent {
    static var title: LocalizedStringResource { "Answer an approval" }
    static var description: IntentDescription { IntentDescription("Approve or deny what a coding agent is asking to do.") }
    static var isDiscoverable: Bool { false }

    @Parameter(title: "Pane") var pane: String
    @Parameter(title: "Prompt") var promptId: String
    @Parameter(title: "Agent") var agent: String
    @Parameter(title: "Host") var host: String
    /// `approve` or `deny`.
    @Parameter(title: "Action") var action: String

    init() {}

    init(pane: String, promptId: String, agent: String, host: String, action: String) {
        self.pane = pane
        self.promptId = promptId
        self.agent = agent
        self.host = host
        self.action = action
    }

    func perform() async throws -> some IntentResult {
        #if REMOTLY_APP
        await NotificationActions.performFromActivity(action: action == "deny" ? .deny : .approve,
                                                      pane: pane, promptId: promptId, agent: agent, host: host)
        #endif
        return .result()
    }
}

// APNs `flow` payload decoding (shared/protocol/remotly-protocol.md §9), category identifiers, stale cleanup.
import FlowKit
import UserNotifications
import XCTest

final class PushPayloadTests: XCTestCase {
    private let userInfo: [AnyHashable: Any] = [
        "aps": [
            "alert": ["title": "Claude needs approval", "subtitle": "claude — bridge", "body": "Approval needed"],
            "sound": "default", "category": "REMOTLY_APPROVAL", "thread-id": "w1:p1", "interruption-level": "time-sensitive",
        ],
        "flow": ["v": 1, "host": "herdr-linux", "pane": "w1:p1", "prompt_id": "w1:p1@4212", "agent": "claude"],
    ]

    func testDecodesFlowDictionary() throws {
        let p = try XCTUnwrap(PushPayload(userInfo: userInfo))
        XCTAssertEqual(p.kind, .approval, "no type = approval (older bridges)")
        XCTAssertTrue(p.isApproval)
        XCTAssertNil(p.approval)
        XCTAssertEqual(p.version, 1)
        XCTAssertEqual(p.host, "herdr-linux")
        XCTAssertEqual(p.pane, "w1:p1")
        XCTAssertEqual(p.promptId, "w1:p1@4212")
        XCTAssertEqual(p.agent, "claude")
    }

    func testApprovalDetailsAndDoneKind() throws {
        let approval = try XCTUnwrap(PushPayload(flow: [
            "v": 1, "type": "approval", "host": "h", "pane": "w1:p1", "prompt_id": "w1:p1@4", "agent": "claude",
            "approval": ["tool": "Bash", "command": "npm test", "path": NSNull(), "description": "Run the tests",
                         "question": "Do you want to proceed?", "options": ["Yes", "No"]],
        ]))
        XCTAssertEqual(approval.approval?.tool, "Bash")
        XCTAssertEqual(approval.approval?.headline, "Bash: npm test")
        XCTAssertNil(approval.approval?.path)
        XCTAssertEqual(approval.approval?.options, ["Yes", "No"])

        let done = try XCTUnwrap(PushPayload(flow: ["v": 1, "type": "done", "host": "h", "pane": "w1:p1", "agent": "claude"]))
        XCTAssertEqual(done.kind, .done)
        XCTAssertTrue(done.isDone)
        XCTAssertEqual(done.promptId, "", "done pushes carry no prompt")
        XCTAssertNil(PushPayload(flow: ["type": "status", "pane": "p"]), "unknown kinds are ignored")
    }

    func testRejectsPayloadsWithoutPaneOrPrompt() {
        XCTAssertNil(PushPayload(userInfo: ["aps": ["alert": "x"]]))
        XCTAssertNil(PushPayload(flow: ["pane": "w1:p1"]))
        XCTAssertNil(PushPayload(flow: ["prompt_id": "w1:p1@1"]))
        XCTAssertNotNil(PushPayload(flow: ["pane": "w1:p1", "prompt_id": "w1:p1@1"]), "host/agent are optional")
    }

    func testCategoryAndActionIdentifiers() {
        XCTAssertEqual(FlowNotifications.approvalCategory, "REMOTLY_APPROVAL")
        XCTAssertEqual(FlowNotifications.doneCategory, "REMOTLY_DONE")
        XCTAssertEqual(FlowNotifications.approveAction, "APPROVE")
        XCTAssertEqual(FlowNotifications.denyAction, "DENY")
        XCTAssertEqual(FlowNotifications.denyFeedbackAction, "DENY_FEEDBACK")
        XCTAssertEqual(FlowNotifications.replyAction, "REPLY")
        let categories = FlowNotifications.categories()
        let approval = categories.first { $0.identifier == FlowNotifications.approvalCategory }
        XCTAssertEqual(approval?.actions.map(\.identifier), ["APPROVE", "DENY", "DENY_FEEDBACK"])
        for action in approval?.actions ?? [] {
            XCTAssertFalse(action.options.contains(.foreground), "\(action.identifier) must run in the background")
        }
        let byId = Dictionary(uniqueKeysWithValues: (approval?.actions ?? []).map { ($0.identifier, $0) })
        XCTAssertTrue(byId["APPROVE"]!.options.contains(.authenticationRequired), "approving needs an unlocked phone by default")
        XCTAssertTrue(byId["DENY_FEEDBACK"]!.options.contains(.authenticationRequired))
        XCTAssertFalse(byId["DENY"]!.options.contains(.authenticationRequired), "denying is the safe direction; stays on the lock screen")
        XCTAssertTrue(byId["DENY_FEEDBACK"] is UNTextInputNotificationAction)

        let done = categories.first { $0.identifier == FlowNotifications.doneCategory }
        XCTAssertEqual(done?.actions.map(\.identifier), ["REPLY"])
        XCTAssertTrue(done?.actions.first is UNTextInputNotificationAction)
        XCTAssertTrue(done?.actions.first?.options.contains(.authenticationRequired) == true)

        let relaxed = FlowNotifications.categories(requireUnlock: false)
        for category in relaxed where category.identifier != FlowNotifications.outcomeCategory {
            for action in category.actions {
                XCTAssertFalse(action.options.contains(.authenticationRequired), "\(action.identifier) with unlock off")
            }
        }
    }

    func testStaleIdentifiers() {
        let live: Set<String> = ["w1:p1@4212"]
        let delivered: [(identifier: String, userInfo: [AnyHashable: Any])] = [
            (identifier: "keep", userInfo: userInfo),
            (identifier: "stale", userInfo: ["flow": ["v": 1, "host": "h", "pane": "w1:p2", "prompt_id": "w1:p2@9", "agent": "codex"]]),
            (identifier: "not-flow", userInfo: ["aps": ["alert": "unrelated"]]),
            (identifier: "done", userInfo: ["flow": ["v": 1, "type": "done", "host": "h", "pane": "w1:p2", "agent": "codex"]]),
        ]
        XCTAssertEqual(FlowNotifications.staleIdentifiers(delivered: delivered, livePromptIds: live), ["stale"])
        XCTAssertEqual(FlowNotifications.staleIdentifiers(delivered: delivered, livePromptIds: []), ["keep", "stale"], "finished alerts are never stale")
    }

    func testOutcomeSummaries() {
        let sent = ApprovalResult(pane: "p", promptId: "p@1", outcome: .sent, statusAfter: .working)
        let s = ApprovalActionClient.summary(action: .approve, agent: "claude", result: sent)
        XCTAssertEqual(s.title, "Approve sent")
        XCTAssertTrue(s.body.contains("working"))
        XCTAssertEqual(sent.summaryText, "Sent · agent is working")

        let stale = ApprovalResult(pane: "p", promptId: "p@1", outcome: .stale)
        XCTAssertEqual(ApprovalActionClient.summary(action: .deny, agent: "", result: stale).title, "Already resolved")

        let mismatch = ApprovalResult(pane: "p", promptId: "p@1", outcome: .signatureMismatch, detail: "no match")
        XCTAssertEqual(mismatch.summaryText, "Screen does not look like an approval prompt")

        let failed = ApprovalResult(pane: "p", promptId: "p@1", outcome: .failed, detail: "send: boom")
        XCTAssertEqual(failed.summaryText, "Failed: send: boom")
        XCTAssertEqual(ApprovalAction.approveSession.title, "Approve for session")
    }
}

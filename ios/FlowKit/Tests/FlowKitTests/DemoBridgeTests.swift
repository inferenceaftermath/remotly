import Foundation
import XCTest
@testable import FlowKit

final class DemoBridgeTests: XCTestCase {
    private func replies(_ d: DemoBridge, _ m: ClientMessage) throws -> [ServerMessage] {
        try d.receive(m.encoded()).map { try ServerMessage.decode(Data($0.utf8)) }
    }
    private func snapshot(_ messages: [ServerMessage]) -> Snapshot? {
        messages.compactMap { if case .snapshot(let s) = $0 { return s }; return nil }.last
    }
    private func outcome(_ messages: [ServerMessage]) -> ApprovalOutcome? {
        messages.compactMap { if case .approvalResult(let r) = $0 { return r.outcome }; return nil }.last
    }

    func testApprovalsValidateCurrentDialogAndCompleteLocally() throws {
        let d = DemoBridge()
        guard case .welcome(let welcome) = try ServerMessage.decode(Data(d.welcome().utf8)) else { return XCTFail("No welcome") }
        XCTAssertEqual(welcome.snapshot?.panes.count, 3)
        XCTAssertEqual(outcome(try replies(d, .choose(id: "1", pane: "demo-choice", promptId: "demo-choice@1", option: 2, label: "Wrong label"))), .dialogChanged)
        let chosen = try replies(d, .choose(id: "2", pane: "demo-choice", promptId: "demo-choice@1", option: 2, label: "A small web app"))
        XCTAssertEqual(outcome(chosen), .sent)
        XCTAssertEqual(snapshot(chosen)?.panes.first { $0.id == "demo-choice" }?.agentStatus, .working)
        XCTAssertEqual(outcome(try replies(d, .choose(id: "3", pane: "demo-choice", promptId: "demo-choice@1", option: 2, label: "A small web app"))), .stale)
        for _ in 0..<4 { XCTAssertTrue(d.tick().isEmpty) }
        let done = snapshot(try d.tick().map { try ServerMessage.decode(Data($0.utf8)) })?.panes.first { $0.id == "demo-choice" }
        XCTAssertEqual(done?.agentStatus, .done)
        XCTAssertNil(done?.promptId)
        XCTAssertNil(done?.approval)
        let denied = try replies(d, .approve(id: "4", pane: "demo-review", promptId: "demo-review@1", action: .denyFeedback, feedback: "Use smaller steps", force: false))
        XCTAssertEqual(outcome(denied), .sent)
        XCTAssertEqual(snapshot(denied)?.panes.first { $0.id == "demo-review" }?.agentStatus, .idle)
        for _ in 0..<5 { XCTAssertTrue(d.tick().isEmpty) }
    }

    func testRawTextFitHistoryAndClosingPendingSample() throws {
        let d = DemoBridge()
        _ = d.welcome()
        _ = try replies(d, .watch(id: "1", pane: "demo-shell", zoom: false))
        _ = try replies(d, .text(id: "2", pane: "demo-shell", text: "echo sample"))
        _ = try replies(d, .keys(id: "3", pane: "demo-shell", keys: ["enter"]))
        let fit = try replies(d, .fit(id: "4", pane: "demo-shell", cols: 32, rows: 8, release: false))
        guard case .frame(let frame) = fit.last else { return XCTFail("No frame") }
        XCTAssertEqual(frame.cols, 32)
        XCTAssertTrue(frame.lines.allSatisfy { $0.runs.allSatisfy { $0.c + $0.w <= frame.cols } })
        guard case .history(let history) = try replies(d, .history(id: "5", pane: "demo-shell", lines: 999, unwrapped: false)).first else { return XCTFail("No history") }
        XCTAssertTrue(history.lines.flatMap(\.runs).contains { $0.t.contains("echo sample") })
        guard case .ok(let created) = try replies(d, .paneCreate(id: "6", label: "My sample", command: "rm -rf /tmp/never-executed")).first,
              let pane = created.pane else { return XCTFail("No pane") }
        _ = try replies(d, .paneClose(id: "7", pane: pane))
        for _ in 0..<5 {
            XCTAssertFalse(snapshot(try d.tick().map { try ServerMessage.decode(Data($0.utf8)) })?.panes.contains { $0.id == pane } ?? false)
        }
        guard case .error(let error) = try replies(d, .watch(id: "8", pane: pane, zoom: false)).first else { return XCTFail("Missing error") }
        XCTAssertEqual(error.code, .unknownPane)
        guard case .error(let notifyError) = try replies(d, .notify(id: "9", pane: "demo-shell", done: true)).first else { return XCTFail("Missing error") }
        XCTAssertEqual(notifyError.code, .unsupported)
    }

    func testBundledScenarioMatchesCanonicalAndroidScenario() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let canonical = try Data(contentsOf: root.appending(path: "shared/demo/demo.json"))
        let bundled = try Data(contentsOf: root.appending(path: "ios/FlowKit/Sources/FlowKit/Resources/demo.json"))
        XCTAssertEqual(canonical, bundled)
    }

    func testConnectionUsesLocalPeerAndRestoresAcrossSuspend() async throws {
        // An unsupported URL scheme makes any accidental real WebSocket attempt fail this test.
        let host = PairedHost(name: "Demo", url: URL(string: "demo://local")!, fingerprint: nil, token: "", deviceId: "demo")
        let c = FlowConnection(host: host, client: ClientInfo(appVersion: "test", deviceName: "test"), demo: true)
        await c.start()
        let state = await c.state
        XCTAssertEqual(state, .connected)
        _ = try await c.watch(pane: "demo-review", intent: 1)
        try await c.approve(pane: "demo-review", promptId: "demo-review@1", action: .approveSession)
        await c.suspend()
        let stopped = await c.state
        XCTAssertEqual(stopped, .stopped)
        do { try await c.sendPrompt(pane: "demo-review", text: "should not run"); XCTFail("Stopped request succeeded") }
        catch { XCTAssertEqual(error as? FlowError, .notConnected) }
        await c.resume()
        let resumed = await c.state
        XCTAssertEqual(resumed, .connected)
        _ = try await c.watch(pane: "demo-shell", intent: 2)
        await c.stop()
    }
}

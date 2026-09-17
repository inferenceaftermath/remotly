// Decoding of every server message type from the literal examples in shared/protocol/remotly-protocol.md §8.
import FlowKit
import XCTest

final class MessagesTests: XCTestCase {
    private func decode(_ json: String) throws -> ServerMessage {
        try ServerMessage.decode(Data(json.utf8))
    }

    func testWelcomeWithSnapshot() throws {
        let json = #"""
        {"t":"welcome","protocol":1,
         "host":{"name":"herdr-linux","herdr_version":"0.9.3","herdr_protocol":4,"flow_version":"0.1.0"},
         "device":{"id":"dev_2f8a","name":"Example iPhone"},
         "snapshot":{"workspaces":[{"id":"ws_1","name":"main"}],
                     "tabs":[{"id":"tab_3","workspace_id":"ws_1","name":"flow"}],
                     "panes":[{"id":"pane_7","tab_id":"tab_3","workspace_id":"ws_1","title":"claude — bridge","agent":"claude",
                               "display_agent":"Claude Code","agent_status":"blocked","state_label":"Waiting for approval",
                               "cwd":"/home/user/remotly/bridge","focused":true,"prompt_id":"pane_7@4182"}],
                     "focused_pane_id":"pane_7"}}
        """#
        guard case .welcome(let w) = try decode(json) else { return XCTFail("expected welcome") }
        XCTAssertEqual(w.`protocol`, 1)
        XCTAssertEqual(w.host.name, "herdr-linux")
        XCTAssertEqual(w.host.herdrVersion, "0.9.3")
        XCTAssertEqual(w.host.herdrProtocol, 4)
        XCTAssertEqual(w.host.flowVersion, "0.1.0")
        XCTAssertEqual(w.device.id, "dev_2f8a")
        XCTAssertEqual(w.notifyDone, [], "absent notify_done reads as none armed")
        let snapshot = try XCTUnwrap(w.snapshot)
        XCTAssertEqual(snapshot.workspaces, [Workspace(id: "ws_1", name: "main")])
        XCTAssertEqual(snapshot.tabs, [Tab(id: "tab_3", workspaceId: "ws_1", name: "flow")])
        XCTAssertEqual(snapshot.focusedPaneId, "pane_7")
        let pane = try XCTUnwrap(snapshot.panes.first)
        XCTAssertEqual(pane.id, "pane_7")
        XCTAssertEqual(pane.tabId, "tab_3")
        XCTAssertEqual(pane.workspaceId, "ws_1")
        XCTAssertEqual(pane.title, "claude — bridge")
        XCTAssertEqual(pane.agent, "claude")
        XCTAssertEqual(pane.displayAgent, "Claude Code")
        XCTAssertEqual(pane.agentStatus, .blocked)
        XCTAssertEqual(pane.stateLabel, "Waiting for approval")
        XCTAssertEqual(pane.cwd, "/home/user/remotly/bridge")
        XCTAssertTrue(pane.focused)
        XCTAssertEqual(pane.promptId, "pane_7@4182")
        XCTAssertEqual(snapshot.livePromptIds, ["pane_7@4182"])
    }

    func testWelcomeActionModeHasNoSnapshotAndTolerantNulls() throws {
        let json = #"{"t":"welcome","protocol":1,"host":{"name":"h","herdr_version":null,"herdr_protocol":null,"flow_version":"0.1.0"},"device":{"id":"d","name":"n"}}"#
        guard case .welcome(let w) = try decode(json) else { return XCTFail("expected welcome") }
        XCTAssertNil(w.snapshot)
        XCTAssertNil(w.host.herdrVersion)
        XCTAssertNil(w.host.herdrProtocol)
    }

    func testSnapshotWithNullFields() throws {
        let json = #"""
        {"t":"snapshot","workspaces":[{"id":"w1","name":"main"}],"tabs":[{"id":"t1","workspace_id":"w1","name":"shell"}],
         "panes":[{"id":"w1:p1","tab_id":"t1","workspace_id":"w1","title":"zsh","agent":null,"display_agent":null,
                   "agent_status":"unknown","state_label":null,"cwd":null,"focused":false}],"focused_pane_id":null}
        """#
        guard case .snapshot(let s) = try decode(json) else { return XCTFail("expected snapshot") }
        XCTAssertNil(s.focusedPaneId)
        let pane = try XCTUnwrap(s.panes.first)
        XCTAssertNil(pane.agent)
        XCTAssertFalse(pane.hasAgent)
        XCTAssertEqual(pane.agentStatus, .unknown)
        XCTAssertNil(pane.promptId)
        XCTAssertEqual(AgentStatus(rawValue: "future").sortRank, 4)
        XCTAssertLessThan(AgentStatus.blocked.sortRank, AgentStatus.working.sortRank)
    }

    func testPaneStatus() throws {
        let json = #"""
        {"t":"pane.status","pane":"pane_7","agent_status":"blocked","agent":"claude","display_agent":"Claude Code",
         "title":"claude — bridge","state_label":"Waiting for approval","prompt_id":"pane_7@4182"}
        """#
        guard case .paneStatus(let p) = try decode(json) else { return XCTFail("expected pane.status") }
        XCTAssertEqual(p.pane, "pane_7")
        XCTAssertEqual(p.agentStatus, .blocked)
        XCTAssertEqual(p.displayAgent, "Claude Code")
        XCTAssertEqual(p.stateLabel, "Waiting for approval")
        XCTAssertEqual(p.promptId, "pane_7@4182")
        XCTAssertNil(p.approval)
    }

    func testPaneStatusWithApprovalDetails() throws {
        let json = #"""
        {"t":"pane.status","pane":"pane_7","agent_status":"blocked","agent":"claude","prompt_id":"pane_7@4182",
         "approval":{"tool":"Bash","command":"npm test","path":null,"description":"Run the tests","question":"Do you want to proceed?","options":["Yes","Yes, and don't ask again","No"]}}
        """#
        guard case .paneStatus(let p) = try decode(json) else { return XCTFail("expected pane.status") }
        let a = try XCTUnwrap(p.approval)
        XCTAssertEqual(a.tool, "Bash")
        XCTAssertEqual(a.command, "npm test")
        XCTAssertNil(a.path)
        XCTAssertEqual(a.description, "Run the tests")
        XCTAssertEqual(a.question, "Do you want to proceed?")
        XCTAssertEqual(a.options.count, 3)
        XCTAssertEqual(a.headline, "Bash: npm test")
        XCTAssertEqual(ApprovalDetails(question: "Trust this folder?").headline, "Trust this folder?")
        XCTAssertEqual(ApprovalDetails(tool: "Edit", path: "src/a.ts").headline, "Edit: src/a.ts")

        let snap = #"{"t":"snapshot","panes":[{"id":"p","agent_status":"blocked","prompt_id":"p@1","approval":{"question":"Proceed?","options":["Yes","No"]}}]}"#
        guard case .snapshot(let s) = try decode(snap) else { return XCTFail("expected snapshot") }
        XCTAssertEqual(s.panes.first?.approval?.question, "Proceed?")
        XCTAssertEqual(s.panes.first?.approval?.options, ["Yes", "No"])
    }

    func testWelcomeNotifyDoneAndNotifyState() throws {
        let json = #"{"t":"welcome","protocol":1,"host":{"name":"h"},"device":{"id":"d","name":"n"},"notify_done":["w1:p1","w1:p3"]}"#
        guard case .welcome(let w) = try decode(json) else { return XCTFail("expected welcome") }
        XCTAssertEqual(w.notifyDone, ["w1:p1", "w1:p3"])
        guard case .notifyState(let ns) = try decode(#"{"t":"notify.state","pane":"w1:p1","done":false}"#) else { return XCTFail("expected notify.state") }
        XCTAssertEqual(ns.pane, "w1:p1")
        XCTAssertFalse(ns.done)
        guard case .ok(let ok) = try decode(#"{"t":"ok","id":"3","done":true}"#) else { return XCTFail("expected ok") }
        XCTAssertEqual(ok.done, true)
    }

    func testFrame() throws {
        let json = #"""
        {"t":"frame","pane":"pane_7","rev":1,"cols":120,"rows":40,"full":true,
         "lines":[{"y":0,"runs":[{"c":0,"w":1,"s":1,"t":"$"},{"c":2,"w":10,"s":0,"t":"ls --color"}]},
                  {"y":1,"runs":[{"c":0,"w":3,"s":2,"t":"src"},{"c":4,"w":4,"s":2,"t":"test"}]},
                  {"y":3,"runs":[{"c":0,"w":2,"s":0,"t":"日"},{"c":2,"w":6,"s":0,"t":"本語 ok"}]}],
         "styles":{"1":{"fg":"p2","bg":"d","a":1},"2":{"fg":"p4","bg":"d","a":1}}}
        """#
        guard case .frame(let f) = try decode(json) else { return XCTFail("expected frame") }
        XCTAssertEqual(f.pane, "pane_7")
        XCTAssertEqual(f.rev, 1)
        XCTAssertEqual(f.cols, 120)
        XCTAssertEqual(f.rows, 40)
        XCTAssertNil(f.alt, "alt is absent until the bridge has probed the pane")
        XCTAssertTrue(f.full)
        XCTAssertEqual(f.lines.count, 3)
        XCTAssertEqual(f.lines[0].runs[0], WireRun(c: 0, w: 1, s: 1, t: "$"))
        XCTAssertEqual(f.lines[2].y, 3)
        XCTAssertEqual(f.styles["1"], Style(fg: "p2", bg: "d", a: 1))
        XCTAssertEqual(f.styles["2"]?.attributes, .bold)
        XCTAssertNil(f.styles["0"])
    }

    func testFrameWithoutStylesDecodes() throws {
        let json = #"{"t":"frame","pane":"p","rev":2,"cols":10,"rows":2,"full":false,"lines":[{"y":1,"runs":[]}],"alt":true}"#
        guard case .frame(let f) = try decode(json) else { return XCTFail("expected frame") }
        XCTAssertFalse(f.full)
        XCTAssertEqual(f.styles, [:])
        XCTAssertEqual(f.lines, [WireLine(y: 1, runs: [])])
        XCTAssertEqual(f.alt, true)
    }

    func testHistory() throws {
        let json = #"""
        {"t":"history","id":"9","pane":"pane_7","lines":[{"runs":[{"c":0,"w":5,"s":3,"t":"hello"}]},{"runs":[]}],
         "styles":{"3":{"fg":"#0ac878","bg":"d","a":0}},"has_more":true}
        """#
        guard case .history(let h) = try decode(json) else { return XCTFail("expected history") }
        XCTAssertEqual(h.id, "9")
        XCTAssertEqual(h.pane, "pane_7")
        XCTAssertEqual(h.lines.count, 2)
        XCTAssertEqual(h.lines[0].runs.first?.t, "hello")
        XCTAssertTrue(h.hasMore)
        XCTAssertNil(h.scrollback, "older bridges do not send scrollback")
        XCTAssertEqual(h.styles["3"]?.foreground, .rgb(RGB(0x0A, 0xC8, 0x78)))
    }

    func testHistoryScrollbackCount() throws {
        let json = #"{"t":"history","id":"9","pane":"pane_7","lines":[],"styles":{},"has_more":false,"scrollback":0}"#
        guard case .history(let h) = try decode(json) else { return XCTFail("expected history") }
        XCTAssertEqual(h.scrollback, 0)
        XCTAssertFalse(h.hasMore)
    }

    func testApprovalResult() throws {
        let json = #"{"t":"approval.result","pane":"pane_7","prompt_id":"pane_7@4182","outcome":"sent","status_after":"working"}"#
        guard case .approvalResult(let r) = try decode(json) else { return XCTFail("expected approval.result") }
        XCTAssertEqual(r.pane, "pane_7")
        XCTAssertEqual(r.promptId, "pane_7@4182")
        XCTAssertEqual(r.outcome, .sent)
        XCTAssertEqual(r.statusAfter, .working)
        XCTAssertNil(r.detail)

        let mismatch = #"{"t":"approval.result","pane":"p","prompt_id":"p@1","outcome":"signature_mismatch","detail":"visible text does not match"}"#
        guard case .approvalResult(let m) = try decode(mismatch) else { return XCTFail("expected approval.result") }
        XCTAssertEqual(m.outcome, .signatureMismatch)
        XCTAssertEqual(m.detail, "visible text does not match")
    }

    func testHerdrState() throws {
        guard case .herdr(let down) = try decode(#"{"t":"herdr","state":"down"}"#) else { return XCTFail("expected herdr") }
        XCTAssertFalse(down.isUp)
        guard case .herdr(let up) = try decode(#"{"t":"herdr","state":"up"}"#) else { return XCTFail("expected herdr") }
        XCTAssertTrue(up.isUp)
    }

    func testOKVariants() throws {
        guard case .ok(let watch) = try decode(#"{"t":"ok","id":"1","cols":120,"rows":40}"#) else { return XCTFail("expected ok") }
        XCTAssertEqual(watch.id, "1")
        XCTAssertEqual(watch.cols, 120)
        XCTAssertEqual(watch.rows, 40)
        guard case .ok(let zoom) = try decode(#"{"t":"ok","id":"5","zoomed":true}"#) else { return XCTFail("expected ok") }
        XCTAssertEqual(zoom.zoomed, true)
        guard case .ok(let plain) = try decode(#"{"t":"ok","id":"2"}"#) else { return XCTFail("expected ok") }
        XCTAssertNil(plain.cols)
        guard case .ok(let numeric) = try decode(#"{"t":"ok","id":7}"#) else { return XCTFail("expected ok") }
        XCTAssertEqual(numeric.id, "7")
    }

    func testErrorWithAndWithoutId() throws {
        let json = #"{"t":"error","id":"3","code":"invalid_key","message":"unknown key name \"pgup\""}"#
        guard case .error(let e) = try decode(json) else { return XCTFail("expected error") }
        XCTAssertEqual(e.id, "3")
        XCTAssertEqual(e.code, .invalidKey)
        XCTAssertEqual(e.message, "unknown key name \"pgup\"")

        guard case .error(let auth) = try decode(#"{"t":"error","code":"auth","message":"invalid token"}"#) else { return XCTFail("expected error") }
        XCTAssertNil(auth.id)
        XCTAssertEqual(auth.code, .auth)
        XCTAssertEqual(ErrorCode(rawValue: "brand_new"), ErrorCode(rawValue: "brand_new"))
    }

    func testUnknownTypeDoesNotThrow() throws {
        guard case .unknown(let type) = try decode(#"{"t":"something.new","x":1}"#) else { return XCTFail("expected unknown") }
        XCTAssertEqual(type, "something.new")
    }
}

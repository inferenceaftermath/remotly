// Encoding of client → server messages (shared/protocol/remotly-protocol.md §4).
import FlowKit
import XCTest

final class ClientMessageTests: XCTestCase {
    private func object(_ message: ClientMessage) throws -> [String: Any] {
        let text = try message.encoded()
        let any = try JSONSerialization.jsonObject(with: Data(text.utf8))
        return try XCTUnwrap(any as? [String: Any])
    }

    func testHello() throws {
        let client = ClientInfo(appVersion: "1.0 (12)", deviceName: "Example iPhone")
        let o = try object(.hello(token: "fl_9Xk", client: client, mode: .full))
        XCTAssertEqual(o["t"] as? String, "hello")
        XCTAssertEqual(o["token"] as? String, "fl_9Xk")
        XCTAssertEqual(o["mode"] as? String, "full")
        XCTAssertNil(o["id"])
        let c = try XCTUnwrap(o["client"] as? [String: Any])
        XCTAssertEqual(c["platform"] as? String, "ios")
        XCTAssertEqual(c["app_version"] as? String, "1.0 (12)")
        XCTAssertEqual(c["device_name"] as? String, "Example iPhone")
    }

    func testWatchHistoryKeysTextPrompt() throws {
        let watch = try object(.watch(id: "1", pane: "pane_7"))
        XCTAssertEqual(watch["t"] as? String, "watch")
        XCTAssertEqual(watch["id"] as? String, "1")
        XCTAssertEqual(watch["pane"] as? String, "pane_7")
        XCTAssertNil(watch["zoom"], "zoom is only sent when on")
        let zoomed = try object(.watch(id: "1", pane: "pane_7", zoom: true))
        XCTAssertEqual(zoomed["zoom"] as? Bool, true)

        let history = try object(.history(id: "2", pane: "p", lines: 5000, unwrapped: true))
        XCTAssertEqual(history["lines"] as? Int, 999, "lines are clamped to herdr's cap")
        XCTAssertEqual(history["unwrapped"] as? Bool, true)
        let plainHistory = try object(.history(id: "2", pane: "p", lines: 500, unwrapped: false))
        XCTAssertNil(plainHistory["unwrapped"])

        let keys = try object(.keys(id: "3", pane: "p", keys: ["ctrl+c", "home"]))
        XCTAssertEqual(keys["keys"] as? [String], ["ctrl+c", "home"])

        let scroll = try object(.scroll(id: "3b", pane: "p", direction: "up", lines: 400, mode: "wheel", col: 12, row: 7))
        XCTAssertEqual(scroll["t"] as? String, "scroll")
        XCTAssertEqual(scroll["direction"] as? String, "up")
        XCTAssertEqual(scroll["lines"] as? Int, 50, "lines are clamped to the bridge's cap")
        XCTAssertEqual(scroll["mode"] as? String, "wheel")
        XCTAssertEqual(scroll["col"] as? Int, 12)
        XCTAssertEqual(scroll["row"] as? Int, 7)

        let create = try object(.paneCreate(id: "3c", label: "build", command: "npm test"))
        XCTAssertEqual(create["t"] as? String, "pane.create")
        XCTAssertEqual(create["label"] as? String, "build")
        XCTAssertEqual(create["command"] as? String, "npm test")
        let bare = try object(.paneCreate(id: "3d", label: nil, command: ""))
        XCTAssertEqual(Set(bare.keys), ["t", "id"], "blank label/command are omitted")

        let close = try object(.paneClose(id: "3e", pane: "w1:p9"))
        XCTAssertEqual(close["t"] as? String, "pane.close")
        XCTAssertEqual(close["pane"] as? String, "w1:p9")
        XCTAssertEqual(Set(close.keys), ["t", "id", "pane"])

        let text = try object(.text(id: "4", pane: "p", text: "line1\nline2"))
        XCTAssertEqual(text["t"] as? String, "text")
        XCTAssertEqual(text["text"] as? String, "line1\nline2")

        let prompt = try object(.prompt(id: "5", pane: "p", text: "hi", notify: false))
        XCTAssertEqual(prompt["t"] as? String, "prompt")
        XCTAssertEqual(Set(prompt.keys), ["t", "id", "pane", "text"], "notify is omitted unless armed")
        let armed = try object(.prompt(id: "5b", pane: "p", text: "hi", notify: true))
        XCTAssertEqual(armed["notify"] as? Bool, true)
    }

    func testNotifyAndActivityTokens() throws {
        let arm = try object(.notify(id: "9", pane: "w1:p1", done: true))
        XCTAssertEqual(arm["t"] as? String, "notify")
        XCTAssertEqual(arm["pane"] as? String, "w1:p1")
        XCTAssertEqual(arm["done"] as? Bool, true)
        XCTAssertEqual(Set(arm.keys), ["t", "id", "pane", "done"])

        let start = try object(.activityRegister(id: "10", token: "ab12", pane: nil))
        XCTAssertEqual(start["t"] as? String, "activity.register")
        XCTAssertEqual(start["token"] as? String, "ab12")
        XCTAssertNil(start["pane"], "no pane = push-to-start token")
        let update = try object(.activityRegister(id: "11", token: "cd34", pane: "w1:p1"))
        XCTAssertEqual(update["pane"] as? String, "w1:p1")

        let forgetOne = try object(.activityUnregister(id: "12", pane: "w1:p1"))
        XCTAssertEqual(forgetOne["t"] as? String, "activity.unregister")
        XCTAssertEqual(forgetOne["pane"] as? String, "w1:p1")
        XCTAssertEqual(Set(try object(.activityUnregister(id: "13", pane: nil)).keys), ["t", "id"])
    }

    func testApprove() throws {
        let plain = try object(.approve(id: "2", pane: "pane_7", promptId: "pane_7@4182", action: .approve, feedback: nil, force: false))
        XCTAssertEqual(plain["t"] as? String, "approve")
        XCTAssertEqual(plain["prompt_id"] as? String, "pane_7@4182")
        XCTAssertEqual(plain["action"] as? String, "approve")
        XCTAssertNil(plain["feedback"])
        XCTAssertNil(plain["force"])

        let forced = try object(.approve(id: "3", pane: "p", promptId: "p@1", action: .denyFeedback, feedback: "use rg", force: true))
        XCTAssertEqual(forced["action"] as? String, "deny_feedback")
        XCTAssertEqual(forced["feedback"] as? String, "use rg")
        XCTAssertEqual(forced["force"] as? Bool, true)
        XCTAssertEqual(ApprovalAction.approveSession.rawValue, "approve_session")
    }

    func testZoomViewingAndPush() throws {
        let zoom = try object(.zoom(id: "6", pane: "p", mode: .toggle))
        XCTAssertEqual(zoom["mode"] as? String, "toggle")

        let viewing = try object(.viewing(pane: "p", id: nil))
        XCTAssertEqual(viewing["pane"] as? String, "p")
        XCTAssertNil(viewing["id"])

        let text = try ClientMessage.viewing(pane: nil, id: nil).encoded()
        XCTAssertTrue(text.contains("\"pane\":null"), "viewing nothing must send an explicit null: \(text)")

        let register = try object(.pushRegister(id: "7", platform: "ios", token: "abcd", env: .sandbox))
        XCTAssertEqual(register["t"] as? String, "push.register")
        XCTAssertEqual(register["env"] as? String, "sandbox")
        XCTAssertEqual(register["token"] as? String, "abcd")

        let unregister = try object(.pushUnregister(id: "8"))
        XCTAssertEqual(unregister["t"] as? String, "push.unregister")
        XCTAssertEqual(unregister["id"] as? String, "8")
    }

    func testKeyNamesAreLowerCaseHerdrNames() {
        XCTAssertEqual(KeyName.ctrl("C"), "ctrl+c")
        XCTAssertEqual(KeyName.alt("x"), "alt+x")
        XCTAssertEqual(KeyName.pageUp, "pageup")
        XCTAssertEqual(KeyName.pageDown, "pagedown")
        XCTAssertEqual(KeyName.function(13), "f12")
        let all = [KeyName.esc, KeyName.tab, KeyName.enter, KeyName.backspace, KeyName.up, KeyName.down, KeyName.left, KeyName.right,
                   KeyName.home, KeyName.end, KeyName.pageUp, KeyName.pageDown, KeyName.delete, KeyName.shiftTab]
        for name in all { XCTAssertEqual(name, name.lowercased()) }
    }
}

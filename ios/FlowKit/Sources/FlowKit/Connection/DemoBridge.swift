// Local protocol peer for the public demo. No network, shell, uploads or persistent writes.
// Accessed only by its owning FlowConnection actor. The scenario is shared with Android.
import Foundation

final class DemoBridge {
    typealias Object = [String: Any]
    private let base: Object
    private var panes: [Object]
    private var output: [String: [String]]
    private var input: [String: String] = [:]
    private var finishing: [String: Int] = [:]
    private var watched: String?
    private var cols = 80
    private var rows = 24
    private var revision = 0
    private var sequence = 0
    private var ticks = 0

    init() {
        // Bundled build input, checked against shared/demo/demo.json by the test suite.
        let data = try! Data(contentsOf: Bundle.module.url(forResource: "demo", withExtension: "json")!)
        let seed = try! JSONSerialization.jsonObject(with: data) as! Object
        base = seed["snapshot"] as! Object
        panes = base["panes"] as! [Object]
        output = seed["lines"] as! [String: [String]]
    }

    func welcome() -> String {
        watched = nil
        return encode(["t": "welcome", "protocol": 1,
                       "host": ["name": "Demo host", "flow_version": "sample"],
                       "device": ["id": "demo-device", "name": "This device"],
                       "snapshot": snapshot(), "notify_done": [String]()])
    }

    func receive(_ text: String) throws -> [String] {
        let m = try JSONSerialization.jsonObject(with: Data(text.utf8)) as! Object
        func string(_ key: String) -> String { m[key] as? String ?? "" }
        let type = string("t"), id = string("id"), pane = string("pane")
        func ok(_ fields: Object = [:]) -> Object { ["t": "ok", "id": id].merging(fields) { _, new in new } }
        func error(_ code: String, _ message: String) -> [String] {
            [encode(["t": "error", "id": id, "code": code, "message": message])]
        }
        if type == "viewing" { return [] }
        if type == "pane.create" {
            guard panes.count < 12 else { return error("bad_request", "Demo supports up to 12 sample terminals. Exit and re-enter to reset.") }
            sequence += 1
            let newId = "demo-new-\(sequence)"
            let label = clean(string("label"))
            panes.append(["id": newId, "tab_id": "demo-tab", "workspace_id": "demo-workspace",
                          "title": label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "Sample terminal" : label,
                          "agent_status": "idle", "cwd": "/sample/project"])
            output[newId] = ["REMOTLY DEMO - SAMPLE DATA", "Commands are simulated, never executed."]
            if !string("command").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { submit(newId, string("command")) }
            return [ok(["pane": newId, "tab": "demo-tab"]), snapshot()].map(encode)
        }
        guard let index = panes.firstIndex(where: { $0["id"] as? String == pane }) else {
            return error("unknown_pane", "Sample session is no longer available.")
        }
        let p = panes[index]
        var events: [Object] = []
        switch type {
        case "watch":
            watched = pane
            events = [ok(["cols": cols, "rows": rows]), frame(pane)]
        case "unwatch":
            if watched == pane { watched = nil }
            events = [ok()]
        case "fit":
            let release = m["release"] as? Bool == true
            cols = release ? 80 : min(200, max(20, m["cols"] as? Int ?? 80))
            rows = release ? 24 : min(100, max(5, m["rows"] as? Int ?? 24))
            events = [ok(["cols": cols, "rows": rows])]
            if watched == pane { events.append(frame(pane)) }
        case "history":
            let all = wrapped(pane)
            let count = min(999, max(1, m["lines"] as? Int ?? 100))
            events = [["t": "history", "id": id, "pane": pane,
                       "lines": all.suffix(count).map { ["runs": runs($0)] }, "styles": styles(),
                       "has_more": all.count > count, "scrollback": max(0, all.count - rows)]]
        case "pane.close":
            panes.remove(at: index); output[pane] = nil; input[pane] = nil; finishing[pane] = nil
            if watched == pane { watched = nil }
            events = [ok(), snapshot()]
        case "approve", "choose":
            let prompt = string("prompt_id")
            let approval = p["approval"] as? Object
            var outcome = "sent"
            if p["prompt_id"] as? String != prompt { outcome = "stale" }
            else if type == "choose" {
                let options = approval?["options"] as? [String] ?? []
                let option = m["option"] as? Int ?? 0
                if option < 1 || option > options.count || options[option - 1] != string("label") { outcome = "dialog_changed" }
            } else if (approval?["kind"] as? String == "choice" && !["deny_feedback", "interrupt"].contains(string("action"))) || !["approve", "approve_session", "deny", "deny_feedback", "interrupt"].contains(string("action")) { outcome = "dialog_changed" }
            if outcome == "sent" {
                append(pane, "Sample response: \(type == "choose" ? string("label") : string("action"))")
                if !string("feedback").isEmpty { append(pane, "Sample feedback: \(string("feedback"))") }
                if (type == "approve" && ["deny", "deny_feedback", "interrupt"].contains(string("action"))) || (type == "choose" && approval?["kind"] as? String == "permission" && m["option"] as? Int == 3) {
                    append(pane, "Sample request denied. No command was run.")
                    setStatus(pane, "idle"); finishing[pane] = nil
                } else { setStatus(pane, "working"); finishing[pane] = ticks + 5 }
            }
            events = [ok(), ["t": "approval.result", "pane": pane, "prompt_id": prompt, "outcome": outcome], snapshot()]
            if watched == pane { events.append(frame(pane)) }
        case "prompt", "text", "keys":
            if type == "prompt" { submit(pane, string("text")) }
            if type == "text" { input[pane] = clean((input[pane] ?? "") + string("text")) }
            if type == "keys" {
                for key in m["keys"] as? [String] ?? [] {
                    switch key {
                    case "enter": submit(pane, input[pane] ?? ""); input[pane] = nil
                    case "backspace": input[pane] = String((input[pane] ?? "").dropLast())
                    case "ctrl+c", "esc":
                        finishing[pane] = nil; input[pane] = nil; setStatus(pane, "idle"); append(pane, "Sample input cancelled.")
                    default: append(pane, "Sample key: \(key)")
                    }
                }
            }
            events = [ok(), snapshot()]
            if watched == pane { events.append(frame(pane)) }
        case "zoom": events = [ok(["zoomed": string("mode") != "off"])]
        case "scroll": events = [ok()]
        default: return error("unsupported", "This feature needs a paired host and is unavailable in demo mode.")
        }
        return events.map(encode)
    }

    func tick() -> [String] {
        ticks += 1
        var events: [Object] = []
        for pane in finishing.filter({ $0.value <= ticks }).keys.sorted() {
            finishing[pane] = nil
            append(pane, "Simulated result: 3 tests passed. No commands were executed.")
            setStatus(pane, "done")
            events.append(snapshot())
            if watched == pane { events.append(frame(pane)) }
        }
        return events.map(encode)
    }

    private func submit(_ pane: String, _ text: String) {
        append(pane, "> \(clean(text))")
        append(pane, "Simulating a sample response...")
        input[pane] = nil
        setStatus(pane, "working")
        finishing[pane] = ticks + 5
    }
    private func setStatus(_ pane: String, _ status: String) {
        guard let i = panes.firstIndex(where: { $0["id"] as? String == pane }) else { return }
        panes[i]["agent_status"] = status; panes[i]["prompt_id"] = nil; panes[i]["approval"] = nil
    }
    private func append(_ pane: String, _ text: String) {
        output[pane] = Array(((output[pane] ?? []) + clean(text).components(separatedBy: "\n")).suffix(200))
    }
    private func wrapped(_ pane: String) -> [String] {
        let lines = (output[pane] ?? []) + (input[pane].map { ["> \($0)"] } ?? [])
        return lines.flatMap { $0.components(separatedBy: "\n") }.flatMap { line -> [String] in
            if line.isEmpty { return [""] }
            let chars = Array(line)
            return stride(from: 0, to: chars.count, by: cols).map { String(chars[$0..<min($0 + cols, chars.count)]) }
        }
    }
    private func frame(_ pane: String) -> Object {
        revision += 1
        return ["t": "frame", "pane": pane, "rev": revision, "cols": cols, "rows": rows, "full": true, "alt": false,
                "lines": wrapped(pane).suffix(rows).enumerated().map { ["y": $0.offset, "runs": runs($0.element)] }, "styles": styles()]
    }
    private func snapshot() -> Object { base.merging(["panes": panes]) { _, new in new } }
    private func styles() -> Object { ["0": ["fg": "d", "bg": "d", "a": 0]] }
    private func runs(_ text: String) -> [Object] { text.isEmpty ? [] : [["c": 0, "w": text.count, "s": 0, "t": text]] }
    // Keep samples bounded and ASCII so both grids have identical one-cell runs, including user input.
    private func clean(_ text: String) -> String {
        String(text.utf16.prefix(2000).map { $0 == 10 || (32...126).contains($0) ? Character(UnicodeScalar($0)!) : "?" })
    }
    private func encode(_ object: Object) -> String { String(data: try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]), encoding: .utf8)! }
}

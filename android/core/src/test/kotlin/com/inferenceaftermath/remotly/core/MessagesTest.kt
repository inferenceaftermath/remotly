package com.inferenceaftermath.remotly.core

import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Test
import com.inferenceaftermath.remotly.core.protocol.*
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

class MessagesTest {
    private fun obj(s: String): JsonObject = Codec.json.parseToJsonElement(s).jsonObject

    @Test
    fun `welcome with embedded snapshot (protocol doc example)`() {
        val m = Codec.decodeServer(
            """{"t":"welcome","protocol":1,
             "host":{"name":"herdr-linux","herdr_version":"0.9.3","herdr_protocol":4,"flow_version":"0.1.0"},
             "device":{"id":"dev_2f8a","name":"Example iPhone"},
             "snapshot":{"workspaces":[{"id":"ws_1","name":"main"}],
                         "tabs":[{"id":"tab_3","workspace_id":"ws_1","name":"flow"}],
                         "panes":[{"id":"pane_7","tab_id":"tab_3","workspace_id":"ws_1","title":"claude — bridge","agent":"claude",
                                   "display_agent":"Claude Code","agent_status":"blocked","state_label":"Waiting for approval",
                                   "cwd":"/home/user/remotly/bridge","focused":true,"prompt_id":"pane_7@4182"}],
                         "focused_pane_id":"pane_7"}}""",
        )
        val w = assertIs<Welcome>(m)
        assertEquals(1, w.protocol)
        assertEquals("herdr-linux", w.host.name)
        assertEquals(4, w.host.herdr_protocol)
        assertEquals("dev_2f8a", w.device.id)
        val snap = w.snapshot!!
        assertEquals("pane_7", snap.focused_pane_id)
        val pane = snap.panes.single()
        assertEquals("Claude Code", pane.display_agent)
        assertEquals("blocked", pane.agent_status)
        assertEquals("pane_7@4182", pane.prompt_id)
        assertTrue(pane.isBlocked && pane.focused)
    }

    @Test
    fun `welcome without snapshot and null host fields`() {
        val w = assertIs<Welcome>(Codec.decodeServer("""{"t":"welcome","protocol":1,"host":{"name":"h","herdr_version":null,"herdr_protocol":null,"flow_version":"0.1.0"},"device":{"id":"d","name":"n"}}"""))
        assertNull(w.snapshot)
        assertNull(w.host.herdr_version)
    }

    @Test
    fun `top-level snapshot with nullable pane fields`() {
        val s = assertIs<Snapshot>(Codec.decodeServer("""{"t":"snapshot","workspaces":[],"tabs":[],"panes":[{"id":"p1","tab_id":"t","workspace_id":"w","title":"zsh","agent":null,"display_agent":null,"agent_status":"unknown","state_label":null,"cwd":null,"focused":false}],"focused_pane_id":null}"""))
        assertNull(s.focused_pane_id)
        assertNull(s.panes[0].agent)
        assertNull(s.panes[0].prompt_id)
    }

    @Test
    fun `pane status and applyStatus`() {
        val st = assertIs<PaneStatus>(Codec.decodeServer("""{"t":"pane.status","pane":"pane_7","agent_status":"blocked","agent":"claude","display_agent":"Claude Code","title":"claude — bridge","state_label":"Waiting for approval","prompt_id":"pane_7@4182"}"""))
        assertEquals("pane_7@4182", st.prompt_id)
        val snap = Snapshot(panes = listOf(PaneInfo(id = "pane_7", agent_status = "working"), PaneInfo(id = "x")))
        val after = snap.applyStatus(st)
        assertEquals("blocked", after.pane("pane_7")!!.agent_status)
        assertEquals("pane_7@4182", after.pane("pane_7")!!.prompt_id)
        assertEquals("unknown", after.pane("x")!!.agent_status)
        val idle = after.applyStatus(st.copy(agent_status = "idle", prompt_id = null))
        assertNull(idle.pane("pane_7")!!.prompt_id)
        // An empty title (the bridge cleaned an all-glyph title) replaces the old one; a bridge that sends none keeps it.
        assertEquals("claude — bridge", after.pane("pane_7")!!.title)
        assertEquals("", after.applyStatus(st.copy(title = "")).pane("pane_7")!!.title)
        assertEquals("claude — bridge", after.applyStatus(st.copy(title = null)).pane("pane_7")!!.title)
        // A null agent means the pane is a plain shell now.
        val shell = after.applyStatus(st.copy(agent = null, display_agent = null, agent_status = "unknown", prompt_id = null))
        assertFalse(shell.pane("pane_7")!!.hasAgent)
    }

    @Test
    fun `approval details ride on pane status and snapshot panes, welcome lists armed panes, notify state decodes`() {
        val st = assertIs<PaneStatus>(Codec.decodeServer("""{"t":"pane.status","pane":"p","agent_status":"blocked","prompt_id":"p@4","approval":{"tool":"Bash","command":"npm test","path":null,"description":"Run the tests","question":"Do you want to proceed?","options":["Yes","No"]}}"""))
        assertEquals("Bash: npm test", st.approval!!.headline)
        val snap = Snapshot(panes = listOf(PaneInfo(id = "p"))).applyStatus(st)
        assertEquals("Do you want to proceed?", snap.pane("p")!!.approval!!.question)
        assertNull(snap.applyStatus(st.copy(agent_status = "working", approval = null)).pane("p")!!.approval)
        val w = assertIs<Welcome>(Codec.decodeServer("""{"t":"welcome","protocol":1,"host":{"name":"h"},"device":{"id":"d","name":"n"},"notify_done":["w1:p1"]}"""))
        assertEquals(listOf("w1:p1"), w.notify_done)
        val ns = assertIs<NotifyState>(Codec.decodeServer("""{"t":"notify.state","pane":"w1:p1","done":false}"""))
        assertFalse(ns.done)
        assertEquals(true, assertIs<OkMessage>(Codec.decodeServer("""{"t":"ok","id":"9","done":true}""")).done)
    }

    @Test
    fun `frame decodes runs, styles keyed by string ids and int s`() {
        val f = assertIs<Frame>(Codec.decodeServer(
            """{"t":"frame","pane":"pane_7","rev":1,"cols":120,"rows":40,"full":true,
             "lines":[{"y":0,"runs":[{"c":0,"w":1,"s":1,"t":"$"},{"c":2,"w":10,"s":0,"t":"ls --color"}]},
                      {"y":1,"runs":[{"c":0,"w":3,"s":2,"t":"src"},{"c":4,"w":4,"s":2,"t":"test"}]},
                      {"y":3,"runs":[{"c":0,"w":2,"s":0,"t":"日"},{"c":2,"w":6,"s":0,"t":"本語 ok"}]}],
             "styles":{"1":{"fg":"p2","bg":"d","a":1},"2":{"fg":"p4","bg":"d","a":1}}}""",
        ))
        assertEquals(120, f.cols)
        assertTrue(f.full)
        assertEquals(3, f.lines.size)
        assertEquals(1, f.lines[0].runs[0].s)
        assertEquals("日", f.lines[2].runs[0].t)
        assertEquals(Style("p2", "d", 1), f.styles["1"])
        assertTrue(f.styles["1"]!!.bold)
        assertNull(f.alt, "alt is absent until the bridge has probed the pane")
        val alt = assertIs<Frame>(Codec.decodeServer("""{"t":"frame","pane":"p","rev":2,"cols":10,"rows":2,"full":false,"lines":[],"alt":true}"""))
        assertEquals(true, alt.alt)
    }

    @Test
    fun `history, approval result, herdr, ok and error`() {
        val h = assertIs<HistoryMessage>(Codec.decodeServer("""{"t":"history","id":"7","pane":"p","lines":[{"runs":[{"c":0,"w":2,"s":0,"t":"hi"}]}],"styles":{},"has_more":true}"""))
        assertTrue(h.has_more)
        assertEquals("hi", h.lines[0].runs[0].t)
        assertNull(h.scrollback, "older bridges do not send scrollback")
        val none = assertIs<HistoryMessage>(Codec.decodeServer("""{"t":"history","id":"8","pane":"p","lines":[],"styles":{},"has_more":false,"scrollback":0}"""))
        assertEquals(0, none.scrollback)
        val a = assertIs<ApprovalResult>(Codec.decodeServer("""{"t":"approval.result","pane":"pane_7","prompt_id":"pane_7@4182","outcome":"sent","status_after":"working"}"""))
        assertEquals(Outcome.SENT, a.outcome)
        assertEquals("working", a.status_after)
        val mm = assertIs<ApprovalResult>(Codec.decodeServer("""{"t":"approval.result","pane":"p","prompt_id":"p@1","outcome":"signature_mismatch","detail":"no prompt text"}"""))
        assertEquals("no prompt text", mm.detail)
        assertFalse(assertIs<HerdrMessage>(Codec.decodeServer("""{"t":"herdr","state":"down"}""")).isUp)
        val ok = assertIs<OkMessage>(Codec.decodeServer("""{"t":"ok","id":"1","cols":120,"rows":40}"""))
        assertEquals(120, ok.cols)
        assertEquals(true, assertIs<OkMessage>(Codec.decodeServer("""{"t":"ok","id":"2","zoomed":true}""")).zoomed)
        assertNull(assertIs<OkMessage>(Codec.decodeServer("""{"t":"ok","id":"3"}""")).zoomed)
        val e = assertIs<ErrorMessage>(Codec.decodeServer("""{"t":"error","id":"3","code":"invalid_key","message":"unknown key name \"pgup\""}"""))
        assertEquals(ErrorCodes.INVALID_KEY, e.code)
        assertNull(assertIs<ErrorMessage>(Codec.decodeServer("""{"t":"error","code":"auth","message":"bad token"}""")).id)
    }

    @Test
    fun `unknown type, unknown fields and garbage are tolerated`() {
        assertNull(Codec.decodeServer("""{"t":"something.new","x":1}"""))
        assertNull(Codec.decodeServer("not json"))
        assertNull(Codec.decodeServer("""{"no":"type"}"""))
        assertIs<HerdrMessage>(Codec.decodeServer("""{"t":"herdr","state":"up","extra":{"a":1}}"""))
    }

    @Test
    fun `client messages encode with t first and optional fields omitted`() {
        val hello = obj(Codec.encode(Hello("fl_9Xk", ClientInfo("android", "1.0 (1)", "Pixel"), "full")))
        assertEquals("hello", hello["t"]!!.jsonPrimitive.content)
        assertEquals("android", hello["client"]!!.jsonObject["platform"]!!.jsonPrimitive.content)
        assertEquals("full", hello["mode"]!!.jsonPrimitive.content)
        assertTrue(Codec.encode(Watch("1", "pane_7")).startsWith("""{"t":"watch""""))
        assertFalse(Codec.encode(Watch("1", "pane_7")).contains("zoom"), "zoom is only sent when on")
        assertTrue(Codec.encode(Watch("1", "pane_7", zoom = true)).contains(""""zoom":true"""))

        val approve = obj(Codec.encode(Approve("2", "pane_7", "pane_7@4182", ApprovalAction.APPROVE)))
        assertEquals(setOf("t", "id", "pane", "prompt_id", "action"), approve.keys)
        val forced = obj(Codec.encode(Approve("2", "p", "p@1", ApprovalAction.DENY_FEEDBACK, feedback = "no", force = true)))
        assertEquals("no", forced["feedback"]!!.jsonPrimitive.content)
        assertEquals(true, forced["force"]!!.jsonPrimitive.content.toBoolean())

        val choose = obj(Codec.encode(Choose("4", "pane_7", "pane_7@4182", 2, "SQLite")))
        assertEquals(setOf("t", "id", "pane", "prompt_id", "option", "label"), choose.keys)
        assertEquals("choose", choose["t"]!!.jsonPrimitive.content)
        assertEquals("2", choose["option"]!!.jsonPrimitive.content)

        val history = obj(Codec.encode(History("3", "p", 500)))
        assertFalse("unwrapped" in history)
        assertEquals("""["esc","ctrl+c"]""", obj(Codec.encode(Keys("4", "p", listOf("esc", "ctrl+c"))))["keys"].toString())
        val scroll = obj(Codec.encode(Scroll("4b", "p", "down", lines = 3, mode = "arrows", col = 1, row = 9)))
        assertEquals("scroll", scroll["t"]!!.jsonPrimitive.content)
        assertEquals(setOf("t", "id", "pane", "direction", "lines", "mode", "col", "row"), scroll.keys)
        assertEquals("arrows", scroll["mode"]!!.jsonPrimitive.content)
        val create = obj(Codec.encode(PaneCreate("4c", label = "build", command = "npm test")))
        assertEquals("pane.create", create["t"]!!.jsonPrimitive.content)
        assertEquals(setOf("t", "id", "label", "command"), create.keys)
        assertEquals(setOf("t", "id"), obj(Codec.encode(PaneCreate("4d"))).keys)
        val created = Codec.decodeServer("""{"t":"ok","id":"4c","pane":"w1:p9","tab":"t9"}""") as OkMessage
        assertEquals("w1:p9", created.pane)
        val close = obj(Codec.encode(PaneClose("4e", "w1:p9")))
        assertEquals("pane.close", close["t"]!!.jsonPrimitive.content)
        assertEquals(setOf("t", "id", "pane"), close.keys)
        val prompt = obj(Codec.encode(Prompt("4f", "p", "fix it", notify = true)))
        assertEquals(setOf("t", "id", "pane", "text", "notify"), prompt.keys)
        assertEquals(setOf("t", "id", "pane", "text"), obj(Codec.encode(Prompt("4g", "p", "ls"))).keys)
        val notify = obj(Codec.encode(Notify("4h", "p", true)))
        assertEquals("notify", notify["t"]!!.jsonPrimitive.content)
        assertEquals(setOf("t", "id", "pane", "done"), notify.keys)
        assertEquals(setOf("t", "id"), obj(Codec.encode(ActivityRegister("4i"))).keys)
        assertEquals("activity.unregister", obj(Codec.encode(ActivityUnregister("4j")))["t"]!!.jsonPrimitive.content)
        assertEquals("push.register", obj(Codec.encode(PushRegister("5", "android", "tok")))["t"]!!.jsonPrimitive.content)
        assertFalse("env" in obj(Codec.encode(PushRegister("5", "android", "tok"))))
    }

    @Test
    fun `viewing encodes an explicit null pane`() {
        val v = obj(Codec.encode(Viewing.of(null)))
        assertTrue("pane" in v)
        assertEquals(JsonNull, v["pane"])
        assertFalse("id" in v)
        assertEquals(JsonPrimitive("pane_7"), obj(Codec.encode(Viewing.of("pane_7", "9")))["pane"])
    }

    @Test
    fun `style bitmask decodes every attribute`() {
        val all = Style(a = 1 or 2 or 4 or 8 or 16 or 32 or 64)
        assertTrue(all.bold && all.dim && all.italic && all.underline && all.inverse && all.strikethrough && all.blink)
        val s = Style("p208", "d", 16)
        assertTrue(s.inverse)
        assertFalse(s.bold || s.dim || s.italic || s.underline || s.strikethrough || s.blink)
        assertEquals(Style.DEFAULT, Style("d", "d", 0))
    }
}

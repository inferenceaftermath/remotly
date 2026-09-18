package com.inferenceaftermath.remotly.core.demo

import com.inferenceaftermath.remotly.core.connection.*
import com.inferenceaftermath.remotly.core.protocol.*
import kotlinx.coroutines.test.*
import kotlinx.serialization.json.*
import okhttp3.EventListener
import okhttp3.OkHttpClient
import okhttp3.Call
import org.junit.jupiter.api.Test
import kotlin.test.*

class DemoBridgeTest {
    private fun reply(d: DemoBridge, m: ClientMessage) = d.receive(Codec.encode(m)).map { assertNotNull(Codec.decodeServer(it)) }

    @Test fun `approvals validate current dialog and complete only locally`() {
        val d = DemoBridge()
        val w = assertIs<Welcome>(Codec.decodeServer(d.welcome()))
        assertEquals(3, w.snapshot!!.panes.size)
        val wrong = reply(d, Choose("1", "demo-choice", "demo-choice@1", 2, "Wrong label"))
        assertEquals("dialog_changed", wrong.filterIsInstance<ApprovalResult>().single().outcome)
        val chosen = reply(d, Choose("2", "demo-choice", "demo-choice@1", 2, "A small web app"))
        assertEquals("sent", chosen.filterIsInstance<ApprovalResult>().single().outcome)
        assertEquals("working", chosen.filterIsInstance<Snapshot>().single().pane("demo-choice")!!.agent_status)
        val stale = reply(d, Choose("3", "demo-choice", "demo-choice@1", 2, "A small web app"))
        assertEquals("stale", stale.filterIsInstance<ApprovalResult>().single().outcome)
        repeat(4) { assertTrue(d.tick().isEmpty()) }
        val done = d.tick().mapNotNull(Codec::decodeServer).filterIsInstance<Snapshot>().single().pane("demo-choice")!!
        assertEquals("done", done.agent_status)
        assertNull(done.prompt_id)
        assertNull(done.approval)
        val denied = reply(d, Approve("4", "demo-review", "demo-review@1", "deny_feedback", "Use smaller steps"))
        assertEquals("sent", denied.filterIsInstance<ApprovalResult>().single().outcome)
        assertEquals("idle", denied.filterIsInstance<Snapshot>().single().pane("demo-review")!!.agent_status)
        repeat(5) { assertTrue(d.tick().isEmpty()) }
    }

    @Test fun `raw text fit history and closing a pending sample are bounded`() {
        val d = DemoBridge()
        d.welcome()
        reply(d, Watch("1", "demo-shell"))
        reply(d, Text("2", "demo-shell", "echo sample"))
        reply(d, Keys("3", "demo-shell", listOf("enter")))
        val fitted = reply(d, Fit("4", "demo-shell", 32, 8)).filterIsInstance<Frame>().single()
        assertEquals(32, fitted.cols)
        assertTrue(fitted.lines.all { l -> l.runs.all { it.c + it.w <= fitted.cols } })
        val h = reply(d, History("5", "demo-shell", 999)).filterIsInstance<HistoryMessage>().single()
        assertTrue(h.lines.flatMap { it.runs }.any { it.t.contains("echo sample") })
        val created = reply(d, PaneCreate("6", "My sample", "rm -rf /tmp/never-executed")).filterIsInstance<OkMessage>().single().pane!!
        reply(d, PaneClose("7", created))
        repeat(5) {
            for (event in d.tick().mapNotNull(Codec::decodeServer).filterIsInstance<Snapshot>()) assertNull(event.pane(created))
        }
        assertEquals("unknown_pane", reply(d, Watch("8", created)).filterIsInstance<ErrorMessage>().single().code)
        assertEquals("unsupported", reply(d, Notify("9", "demo-shell", true)).filterIsInstance<ErrorMessage>().single().code)
        val fresh = assertIs<Welcome>(Codec.decodeServer(DemoBridge().welcome()))
        assertEquals("blocked", fresh.snapshot!!.pane("demo-review")!!.agent_status)
    }

    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    @Test fun `demo connection never opens a socket and can stop and resume`() = runTest {
        var calls = 0
        val http = OkHttpClient.Builder().eventListener(object : EventListener() {
            override fun callStart(call: Call) { calls++ }
        }).build()
        val c = FlowConnection(HostConfig("demo://local", ""), ClientInfo("android", "test", "test"), scope = backgroundScope, okHttp = http, isDemo = true)
        c.start()
        assertTrue(c.isConnected)
        c.watch("demo-review")
        assertNotNull(c.grid.value)
        c.approve("demo-review", "demo-review@1", "approve_session")
        advanceTimeBy(1200); runCurrent()
        assertEquals("done", c.snapshot.value!!.pane("demo-review")!!.agent_status)
        c.stop()
        assertFalse(c.isConnected)
        assertFailsWith<FlowException> { c.prompt("demo-review", "should not run") }
        c.start(); runCurrent()
        assertTrue(c.isConnected)
        assertEquals("done", c.snapshot.value!!.pane("demo-review")!!.agent_status)
        c.stop()
        assertEquals(0, calls)
    }
}

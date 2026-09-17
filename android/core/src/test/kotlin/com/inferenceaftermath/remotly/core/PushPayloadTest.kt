package com.inferenceaftermath.remotly.core

import org.junit.jupiter.api.Test
import com.inferenceaftermath.remotly.core.push.PushPayload
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class PushPayloadTest {
    @Test
    fun `parses the Appendix B data map`() {
        val p = PushPayload.parse(
            mapOf(
                "v" to "1", "type" to "approval", "host" to "herdr-linux", "pane" to "w1:p1", "prompt_id" to "w1:p1@4212",
                "agent" to "claude", "title" to "Claude needs approval", "subtitle" to "claude — bridge", "body" to "Bash(rm -rf build)",
            ),
        )
        assertNotNull(p)
        assertEquals(1, p.v)
        assertTrue(p.isApproval)
        assertEquals("w1:p1", p.pane)
        assertEquals("w1:p1@4212", p.promptId)
        assertEquals("Claude needs approval", p.title)
        assertEquals("Bash(rm -rf build)", p.body)
    }

    @Test
    fun `approval carries the parsed dialog as JSON and done and status kinds parse their own fields`() {
        val a = PushPayload.parse(
            mapOf(
                "type" to "approval", "pane" to "w1:p1", "prompt_id" to "w1:p1@1",
                "approval" to """{"tool":"Bash","command":"npm test","path":null,"description":"Run the tests","question":"Do you want to proceed?","options":["Yes","No"]}""",
            ),
        )!!
        assertEquals("Bash", a.approval?.tool)
        assertEquals("Bash: npm test", a.approval?.headline)
        assertEquals(listOf("Yes", "No"), a.approval?.options)
        assertNull(PushPayload.parse(mapOf("type" to "approval", "pane" to "p", "prompt_id" to "p@1", "approval" to "not json"))!!.approval, "bad JSON is ignored, not fatal")

        val d = PushPayload.parse(mapOf("type" to "done", "pane" to "w1:p1", "agent" to "claude", "title" to "Claude finished", "body" to "All green."))!!
        assertTrue(d.isDone)
        assertFalse(d.isApproval)
        assertEquals("All green.", d.body)
        assertEquals("Finished", PushPayload.parse(mapOf("type" to "done", "pane" to "p"))!!.body)

        val s = PushPayload.parse(mapOf("type" to "status", "pane" to "w1:p1", "agent" to "claude", "display_agent" to "Claude", "title" to "Remotly", "status" to "blocked", "since" to "1800000000123", "prompt_id" to "w1:p1@4", "detail" to "Bash: npm test"))!!
        assertTrue(s.isStatus)
        assertEquals("blocked", s.status)
        assertEquals("", s.kind, "kind is optional")
        assertEquals("choice", PushPayload.parse(mapOf("type" to "status", "pane" to "p", "status" to "blocked", "kind" to "choice"))!!.kind)
        assertEquals(1800000000123L, s.since)
        assertEquals("Claude", s.displayAgent)
        assertEquals("Bash: npm test", s.detail)
        assertFalse(PushPayload.parse(mapOf("type" to "status", "pane" to "p"))!!.isStatus, "a status message without a status is ignored")
    }

    @Test
    fun `missing pane or type is rejected, blanks get defaults`() {
        assertNull(PushPayload.parse(mapOf("type" to "approval")))
        assertNull(PushPayload.parse(mapOf("pane" to "p")))
        val p = PushPayload.parse(mapOf("type" to "approval", "pane" to "p", "title" to "", "body" to ""))!!
        assertEquals("Approval needed", p.title)
        assertEquals("Approval needed", p.body)
        assertFalse(p.isApproval, "approval without prompt_id cannot be acted on")
    }
}

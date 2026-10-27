// The pairing screen's answer to each camera read (ScanGate): a refused code is not sent again on the next frame.
package com.inferenceaftermath.remotly.core

import com.inferenceaftermath.remotly.core.pairing.ScanGate
import com.inferenceaftermath.remotly.core.pairing.ScanGate.Decision
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNull

class ScanGateTest {
    private val codeA = "remotly://pair?u=wss://host.tailnet-example.ts.net:7460&c=ABCD2345&n=host"
    private val codeB = "remotly://pair?u=wss://host.tailnet-example.ts.net:7460&c=KMNP6789&n=host"
    private val foreign = "https://example.com/menu"

    @Test
    fun `a valid code is sent once and every read while it is in flight is ignored`() {
        val g = ScanGate()
        val d = assertIs<Decision.Pair>(g.scanned(codeA, 0))
        assertEquals("ABCD2345", d.payload.code)
        assertEquals(codeA, g.inFlight)
        assertEquals(Decision.Ignore, g.scanned(codeA, 30))
        assertEquals(Decision.Ignore, g.scanned(codeB, 60), "one request at a time, whatever the code")
        assertEquals(Decision.Ignore, g.scanned(foreign, 90))
    }

    @Test
    fun `a refused code is not sent again while it stays in view`() {
        val g = ScanGate()
        g.scanned(codeA, 0)
        g.failed("Wrong or expired pairing code")
        assertEquals("Wrong or expired pairing code", g.paused)
        assertNull(g.inFlight)
        // The camera keeps reading the same QR several times a second; the old screens sent each read.
        for (t in listOf(300L, 600L, 900L, 1200L, 1500L, 5_000L, 60_000L)) assertEquals(Decision.Ignore, g.scanned(codeA, t), "at $t ms")
        assertEquals("Wrong or expired pairing code", g.paused)
    }

    @Test
    fun `a different code after a failure is sent at once and ends the pause`() {
        val g = ScanGate()
        g.scanned(codeA, 0)
        g.failed("Wrong or expired pairing code")
        val d = assertIs<Decision.Pair>(g.scanned(codeB, 500))
        assertEquals("KMNP6789", d.payload.code)
        assertNull(g.paused)
        assertEquals(codeB, g.inFlight)
    }

    @Test
    fun `resume lets the same code be scanned again`() {
        val g = ScanGate()
        g.scanned(codeA, 0)
        g.failed("Could not reach the host")
        assertEquals(Decision.Ignore, g.scanned(codeA, 400))
        g.resume()
        assertNull(g.paused)
        assertIs<Decision.Pair>(g.scanned(codeA, 800))
    }

    @Test
    fun `a foreign QR is noticed once per 2_4 s and never sent`() {
        val g = ScanGate()
        assertEquals(Decision.Notice, g.scanned(foreign, 0))
        assertEquals(Decision.Ignore, g.scanned(foreign, 1_000))
        assertEquals(Decision.Ignore, g.scanned(foreign, 2_399))
        assertEquals(Decision.Notice, g.scanned(foreign, 2_400))
        assertNull(g.inFlight)
        assertNull(g.paused)
    }

    @Test
    fun `a foreign QR while paused is quiet`() {
        val g = ScanGate()
        g.scanned(codeA, 0)
        g.failed("Wrong or expired pairing code")
        assertEquals(Decision.Ignore, g.scanned(foreign, 5_000))
        assertEquals("Wrong or expired pairing code", g.paused)
    }

    @Test
    fun `failed with nothing in flight changes nothing (the manual form has its own error line)`() {
        val g = ScanGate()
        g.failed("Enter the host as host:port")
        assertNull(g.paused)
        assertIs<Decision.Pair>(g.scanned(codeA, 0))
    }

    @Test
    fun `success leaves the gate idle`() {
        val g = ScanGate()
        g.scanned(codeA, 0)
        g.succeeded()
        assertNull(g.inFlight)
        assertNull(g.paused)
    }
}

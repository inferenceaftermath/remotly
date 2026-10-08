package com.inferenceaftermath.remotly.core

import com.inferenceaftermath.remotly.core.terminal.Contrast
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue

// Contrast of terminal colours and the Light theme's readability nudge (shared/design/DESIGN.md §1); the same cases as
// iOS ContrastTests.
class ContrastTest {
    private val white = 0xFFFFFFFF.toInt()
    private val black = 0xFF000000.toInt()

    private fun r(c: Int) = (c shr 16) and 0xFF
    private fun g(c: Int) = (c shr 8) and 0xFF
    private fun b(c: Int) = c and 0xFF

    @Test
    fun ratio() {
        assertEquals(21.0, Contrast.ratio(black, white), 0.01)
        assertEquals(21.0, Contrast.ratio(white, black), 0.01)
        assertEquals(1.0, Contrast.ratio(white, white), 0.0001)
        // #767676 is the classic lightest grey that reaches 4.5 : 1 on white.
        assertEquals(4.54, Contrast.ratio(0xFF767676.toInt(), white), 0.01)
    }

    @Test
    fun readableColoursAreKept() {
        val navy = 0xFF16181D.toInt()
        assertEquals(navy, Contrast.readable(navy, white, 4.5))
        assertEquals(white, Contrast.readable(white, white, 1.0), "1 turns the floor off")
    }

    @Test
    fun whiteTextOnALightBackgroundDarkens() {
        val out = Contrast.readable(white, white, 4.5)
        assertTrue(Contrast.ratio(out, white) >= 4.5)
        assertNotEquals(black, out, "stops at the first tenth that reads, not at black")
    }

    @Test
    fun paleTextKeepsItsHue() {
        // Claude Code's orange on the Light theme: darker, still orange (red above green above blue).
        val out = Contrast.readable(0xFFD77757.toInt(), white, 4.5)
        assertTrue(Contrast.ratio(out, white) >= 4.5)
        assertTrue(r(out) > g(out) && g(out) > b(out))
        assertEquals(0xFF, out ushr 24, "opaque")
    }

    @Test
    fun darkTextOnADarkBackgroundLightens() {
        val bg = 0xFF1E1E2E.toInt()
        val out = Contrast.readable(0xFF202030.toInt(), bg, 4.5)
        assertTrue(Contrast.ratio(out, bg) >= 4.5)
        assertTrue(Contrast.luminance(out) > Contrast.luminance(bg))
    }
}

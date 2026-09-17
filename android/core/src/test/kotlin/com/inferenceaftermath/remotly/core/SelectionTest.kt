package com.inferenceaftermath.remotly.core

import com.inferenceaftermath.remotly.core.protocol.WireRun
import com.inferenceaftermath.remotly.core.terminal.GridPosition
import com.inferenceaftermath.remotly.core.terminal.Row
import com.inferenceaftermath.remotly.core.terminal.Selection
import com.inferenceaftermath.remotly.core.terminal.selectionText
import com.inferenceaftermath.remotly.core.terminal.wordAt
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class SelectionTest {
    private val rows = listOf(
        Row.fromRuns(listOf(WireRun(0, 9, 0, "ls -la /x")), 10),
        Row.fromRuns(listOf(WireRun(0, 2, 0, "漢"), WireRun(2, 3, 0, "abc")), 10),
        Row.fromRuns(listOf(WireRun(4, 3, 0, "end")), 10),
    )

    @Test
    fun `selection text spans rows in either order and trims trailing spaces`() {
        assertEquals("-la /x\n漢abc\n    en", rows.selectionText(GridPosition(0, 3), GridPosition(2, 5)))
        assertEquals("-la /x\n漢abc\n    en", rows.selectionText(GridPosition(2, 5), GridPosition(0, 3)))
        assertEquals("ls", rows.selectionText(GridPosition(0, 0), GridPosition(0, 1)))
        // Starting on the right half of a wide character includes the character.
        assertEquals("漢a", rows.selectionText(GridPosition(1, 1), GridPosition(1, 2)))
        // Out-of-range positions are clamped rather than crashing.
        assertEquals("end", rows.selectionText(GridPosition(2, 4), GridPosition(9, 99)))
    }

    @Test
    fun `words are whitespace-delimited and wide cells count as ink`() {
        assertEquals(Selection(GridPosition(0, 3), GridPosition(0, 5)), rows.wordAt(GridPosition(0, 4)))
        assertEquals(Selection(GridPosition(0, 2), GridPosition(0, 2)), rows.wordAt(GridPosition(0, 2)))
        assertEquals(Selection(GridPosition(1, 0), GridPosition(1, 4)), rows.wordAt(GridPosition(1, 3)))
        assertNull(rows.wordAt(GridPosition(3, 0)))
        assertTrue(GridPosition(0, 9) < GridPosition(1, 0))
        val s = Selection(GridPosition(2, 1), GridPosition(0, 5))
        assertEquals(GridPosition(0, 5), s.start)
        assertEquals(GridPosition(2, 1), s.end)
    }
}

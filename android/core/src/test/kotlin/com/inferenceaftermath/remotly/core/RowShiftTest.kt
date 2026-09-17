// Row-shift detection: a frame that is the previous screen scrolled by whole rows, with or without fixed chrome.
package com.inferenceaftermath.remotly.core

import com.inferenceaftermath.remotly.core.protocol.Frame
import com.inferenceaftermath.remotly.core.protocol.WireLine
import com.inferenceaftermath.remotly.core.protocol.WireRun
import com.inferenceaftermath.remotly.core.terminal.RowShift
import com.inferenceaftermath.remotly.core.terminal.RowShiftDetector
import com.inferenceaftermath.remotly.core.terminal.TerminalGrid
import org.junit.jupiter.api.Assumptions.assumeTrue
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestFactory
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertSame
import kotlin.test.assertTrue

class RowShiftTest {
    private val chrome = listOf("────────────────────", "❯ type a message", "? for shortcuts")
    private fun transcript(from: Int, count: Int) = (from until from + count).map { "line $it of the transcript" }
    private fun edited(rows: List<String>, row: Int) = rows.toMutableList().also { it[row] = "something else entirely" }
    private fun sparse(texts: List<String>, rows: List<Int>, height: Int = 20) = MutableList(height) { "" }.also { r -> texts.zip(rows).forEach { (t, y) -> r[y] = t } }
    private fun grid(rows: List<String>, cols: Int = 24): TerminalGrid {
        val lines = rows.mapIndexedNotNull { y, text -> if (text.isEmpty()) null else WireLine(y, listOf(WireRun(0, text.length, 0, text))) }
        return TerminalGrid.empty(cols, rows.size).apply(Frame("p", 1, cols, rows.size, full = true, lines = lines))
    }

    @Test fun scrollUpKeepsChromeStill() {
        assertEquals(RowShift(2, 17), RowShiftDetector.detect(grid(transcript(0, 17) + chrome), grid(transcript(2, 17) + chrome)))
    }

    @Test fun scrollDownKeepsChromeStill() {
        assertEquals(RowShift(-2, 17), RowShiftDetector.detect(grid(transcript(2, 17) + chrome), grid(transcript(0, 17) + chrome)))
    }

    @Test fun fullScreenScrollMovesEveryRow() {
        assertEquals(RowShift(3, 20), RowShiftDetector.detect(grid(transcript(0, 20)), grid(transcript(3, 20))))
    }

    @Test fun editedRowIsNotAScroll() {
        assertNull(RowShiftDetector.detect(grid(transcript(0, 20)), grid(edited(transcript(0, 20), 5))))
    }

    @Test fun identicalScreensAreNotAScroll() {
        assertNull(RowShiftDetector.detect(grid(transcript(0, 20)), grid(transcript(0, 20))))
    }

    @Test fun repeatedRowsDoNotCount() {
        assertNull(RowShiftDetector.detect(grid(List(19) { "same" } + "a"), grid(List(19) { "same" } + "b")))
    }

    @Test fun twoInkedRowsAreNotEnough() {
        assertNull(RowShiftDetector.detect(grid(sparse(listOf("alpha", "beta"), listOf(3, 5))), grid(sparse(listOf("alpha", "beta"), listOf(2, 4)))))
    }

    @Test fun differentSizesNeverMatch() {
        assertNull(RowShiftDetector.detect(grid(transcript(0, 20)), grid(transcript(2, 19))))
        assertNull(RowShiftDetector.detect(grid(transcript(0, 20), cols = 30), grid(transcript(2, 20))))
    }

    @Test fun sparseScreenWithThreeInkedRows() {
        val shift = RowShiftDetector.detect(grid(sparse(listOf("alpha", "beta", "gamma"), listOf(3, 5, 7))), grid(sparse(listOf("alpha", "beta", "gamma"), listOf(2, 4, 6))))
        assertEquals(1, shift?.shift)
        assertTrue((shift?.movingRows ?: 0) >= 7)
    }
}

package com.inferenceaftermath.remotly.core

import org.junit.jupiter.api.Assumptions.assumeTrue
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestFactory
import com.inferenceaftermath.remotly.core.protocol.Codec
import com.inferenceaftermath.remotly.core.protocol.Frame
import com.inferenceaftermath.remotly.core.protocol.Style
import com.inferenceaftermath.remotly.core.protocol.WireLine
import com.inferenceaftermath.remotly.core.protocol.WireRun
import com.inferenceaftermath.remotly.core.terminal.Cell
import com.inferenceaftermath.remotly.core.terminal.Graphemes
import com.inferenceaftermath.remotly.core.terminal.StyleTable
import com.inferenceaftermath.remotly.core.terminal.TerminalGrid
import java.io.File
import kotlin.test.assertEquals
import kotlin.test.assertSame
import kotlin.test.assertTrue

class TerminalGridTest {

    private fun fixturesDir(): File? {
        val candidates = listOfNotNull(
            System.getProperty("flow.fixtures")?.let(::File),
            File("../../shared/fixtures/frames"),
            File("../shared/fixtures/frames"),
        )
        return candidates.firstOrNull { it.isDirectory }
    }

    /** Every golden `*.frame.json` must render exactly to its `*.txt` (README in the fixtures dir). */
    @TestFactory
    fun `golden frames render to their plain text`(): List<DynamicTest> {
        val dir = fixturesDir()
        assumeTrue(dir != null, "shared/fixtures/frames not found; skipping golden frame tests")
        val frames = dir!!.listFiles { f -> f.name.endsWith(".frame.json") }!!.sortedBy { it.name }
        assumeTrue(frames.isNotEmpty(), "no fixtures")
        return frames.map { file ->
            DynamicTest.dynamicTest(file.name) {
                val frame = Codec.decodeServer(file.readText()) as Frame
                assertTrue(frame.full)
                val expected = File(dir, file.name.removeSuffix(".frame.json") + ".txt").readText()
                val grid = TerminalGrid.empty(frame.cols, frame.rows).apply(frame)
                assertEquals(frame.rows, grid.rows)
                // herdr sometimes returns trailing blank rows (claude-permission-prompt) and sometimes trims
                // them; a frame cannot tell the two apart, so compare every row, padding with blank lines.
                val expectedLines = expected.removeSuffix("\n").split("\n")
                assertTrue(expectedLines.size <= frame.rows, "golden has more lines than rows")
                for (y in 0 until frame.rows) {
                    assertEquals(expectedLines.getOrElse(y) { "" }, grid.row(y).text(), "row $y of ${file.name}")
                }
                assertEquals(expected.trimEnd('\n'), grid.plainText())
                for (line in frame.lines) for (run in line.runs) {
                    assertTrue(run.c + run.w <= frame.cols, "run past cols at y=${line.y}: $run")
                    if (run.w == 2) {
                        val g = Graphemes.split(run.t)
                        assertTrue(g.size == 1 || g.size == 2, "w:2 run is neither one wide grapheme nor two narrow: ${run.t}")
                    }
                }
                // Style ids used by runs must all be known (0 or present in the frame's table).
                val table = StyleTable().also { it.merge(frame.styles) }
                for (line in frame.lines) for (run in line.runs) {
                    assertTrue(run.s == 0 || frame.styles.containsKey(run.s.toString()), "unknown style ${run.s}")
                    if (run.s != 0) assertEquals(frame.styles[run.s.toString()], table[run.s])
                }
            }
        }
    }

    private fun run(c: Int, w: Int, t: String, s: Int = 0) = WireRun(c, w, s, t)

    @Test
    fun `full frame replaces the grid and absent rows are blank`() {
        val g0 = TerminalGrid.empty(10, 3).apply(
            Frame("p", 1, 10, 3, full = true, lines = listOf(WireLine(0, listOf(run(0, 5, "hello"))), WireLine(2, listOf(run(2, 3, "bye"))))),
        )
        assertEquals("hello\n\n  bye", g0.plainText())
        val g1 = g0.apply(Frame("p", 2, 10, 3, full = true, lines = listOf(WireLine(1, listOf(run(0, 2, "ok"))))))
        assertEquals("\nok", g1.plainText())
        assertEquals(2, g1.rev)
    }

    @Test
    fun `partial frame replaces only listed rows and runs-empty row blanks it`() {
        val base = TerminalGrid.empty(10, 3).apply(
            Frame("p", 1, 10, 3, full = true, lines = listOf(WireLine(0, listOf(run(0, 1, "a"))), WireLine(1, listOf(run(0, 1, "b"))), WireLine(2, listOf(run(0, 1, "c"))))),
        )
        val next = base.apply(Frame("p", 2, 10, 3, full = false, lines = listOf(WireLine(1, listOf(run(0, 2, "BB"))), WireLine(2, emptyList()))))
        assertEquals("a\nBB", next.plainText())
        assertSame(base.row(0), next.row(0))
        assertEquals("a\nb\nc", base.plainText(), "grids are immutable")
    }

    @Test
    fun `wide grapheme occupies two cells with a continuation`() {
        val g = TerminalGrid.empty(6, 1).apply(Frame("p", 1, 6, 1, true, listOf(WireLine(0, listOf(run(0, 2, "日"), run(2, 2, "🇯🇵"), run(4, 2, "ok"))))))
        val row = g.row(0)
        assertEquals(2, row.cells[0].width)
        assertSame(Cell.CONTINUATION, row.cells[1])
        assertEquals("🇯🇵", row.cells[2].text)
        assertEquals(1, row.cells[4].width)
        assertEquals("o", row.cells[4].text)
        assertEquals("k", row.cells[5].text)
        assertEquals("日🇯🇵ok", g.plainText())
    }

    @Test
    fun `combining marks stay attached and styled blanks are kept`() {
        val g = TerminalGrid.empty(8, 2).apply(
            Frame("p", 1, 8, 2, true, listOf(WireLine(0, listOf(run(0, 3, "éäx", 1))), WireLine(1, listOf(run(0, 4, "    ", 2)))), mapOf("1" to Style("p1"), "2" to Style(bg = "p4"))),
        )
        assertEquals("é", g.row(0).cells[0].text)
        assertEquals("x", g.row(0).cells[2].text)
        assertEquals(2, g.row(1).cells[3].styleId)
        assertEquals("éäx\n", g.plainText(), "styled blank row is a present (empty) line")
    }

    @Test
    fun `runs are clipped to cols and resize crops or pads`() {
        val g = TerminalGrid.empty(4, 2).apply(Frame("p", 1, 4, 2, true, listOf(WireLine(0, listOf(run(2, 5, "abcde"))))))
        assertEquals("  ab", g.plainText())
        val wider = g.resize(8, 3)
        assertEquals(8, wider.cols)
        assertEquals("  ab", wider.plainText())
        val partialAfterResize = g.apply(Frame("p", 2, 6, 2, false, listOf(WireLine(1, listOf(run(0, 1, "z"))))))
        assertEquals(6, partialAfterResize.cols)
        assertEquals("  ab\nz", partialAfterResize.plainText())
    }

    @Test
    fun `style table caches across merges and resets`() {
        val t = StyleTable()
        t.merge(mapOf("1" to Style("p1", "d", 1)))
        t.merge(mapOf("2" to Style("#0ac878")))
        assertEquals(Style("p1", "d", 1), t[1])
        assertEquals("#0ac878", t[2].fg)
        assertEquals(Style.DEFAULT, t[0])
        assertEquals(Style.DEFAULT, t[99])
        t.reset()
        assertEquals(Style.DEFAULT, t[1])
    }

    @Test
    fun `grapheme segmentation`() {
        assertEquals(listOf("a", "b"), Graphemes.split("ab"))
        assertEquals(listOf("é"), Graphemes.split("é"))
        assertEquals(listOf("👨‍👩‍👧"), Graphemes.split("👨‍👩‍👧"))
        assertEquals(listOf("🇯🇵"), Graphemes.split("🇯🇵"))
        assertEquals(listOf("🇯🇵", "🇺🇸"), Graphemes.split("🇯🇵🇺🇸"))
        assertEquals(listOf("❤️"), Graphemes.split("❤️"))
        assertEquals(listOf("👍🏽"), Graphemes.split("👍🏽"))
        assertEquals(listOf(" ", "→", " "), Graphemes.split(" → "))
    }
}

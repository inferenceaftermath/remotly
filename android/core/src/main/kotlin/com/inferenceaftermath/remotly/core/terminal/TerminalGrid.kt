// Immutable rows × cols cell grid painted from `frame` messages (protocol §7). A run covers `w`
// cells from column `c`; a wide grapheme is one run with `w == 2` occupying two cells.
package com.inferenceaftermath.remotly.core.terminal

import com.inferenceaftermath.remotly.core.protocol.Frame
import com.inferenceaftermath.remotly.core.protocol.Style
import com.inferenceaftermath.remotly.core.protocol.WireRun
import java.util.concurrent.ConcurrentHashMap

class Cell(val text: String, val width: Int, val styleId: Int) {
    val isBlank: Boolean get() = width == 1 && styleId == 0 && text == " "

    companion object {
        val BLANK = Cell(" ", 1, 0)
        /** Right half of a wide cell; renders nothing. */
        val CONTINUATION = Cell("", 0, 0)
    }
}

class Row private constructor(val cells: Array<Cell>, val isEmpty: Boolean) {
    val cols: Int get() = cells.size

    /** Gaps as spaces, trailing spaces trimmed (matches the bridge's `plainText`). */
    fun text(): String {
        val sb = StringBuilder(cells.size)
        for (c in cells) sb.append(c.text)
        return sb.toString().trimEnd(' ')
    }

    fun resized(newCols: Int): Row {
        if (newCols == cols) return this
        if (isEmpty) return blank(newCols)
        val out = Array(newCols) { i -> cells.getOrNull(i) ?: Cell.BLANK }
        if (newCols > 0 && out[newCols - 1].width == 2) out[newCols - 1] = Cell.BLANK
        return Row(out, false)
    }

    companion object {
        fun blank(cols: Int) = Row(Array(cols) { Cell.BLANK }, true)

        fun fromRuns(runs: List<WireRun>, cols: Int): Row {
            if (runs.isEmpty() || cols <= 0) return blank(maxOf(cols, 0))
            val cells = Array(cols) { Cell.BLANK }
            for (run in runs) paint(cells, run)
            return Row(cells, false)
        }

        private fun paint(cells: Array<Cell>, run: WireRun) {
            val cols = cells.size
            if (run.w <= 0 || run.c >= cols || run.c + run.w <= 0) return
            val graphemes = Graphemes.split(run.t)
            if (run.w == 2 && graphemes.size == 1) {
                if (run.c >= 0) cells[run.c] = Cell(run.t, 2, run.s)
                if (run.c + 1 in 0 until cols) cells[run.c + 1] = Cell.CONTINUATION
                return
            }
            val parts = fit(graphemes, run.w)
            for (i in 0 until run.w) {
                val col = run.c + i
                if (col < 0) continue
                if (col >= cols) break
                val t = parts[i]
                cells[col] = if (run.s == 0 && t == " ") Cell.BLANK else Cell(t, 1, run.s)
            }
        }

        /** Exactly `w` one-cell strings: pad with blanks, or fold surplus graphemes into the last cell. */
        private fun fit(g: List<String>, w: Int): List<String> = when {
            g.size == w -> g
            g.size < w -> g + List(w - g.size) { " " }
            else -> g.subList(0, w - 1) + g.subList(w - 1, g.size).joinToString("")
        }
    }
}

/** Per-connection style cache: only new ids arrive in `styles`; id 0 is the implicit default. */
class StyleTable {
    private val styles = ConcurrentHashMap<Int, Style>()

    fun merge(newStyles: Map<String, Style>) {
        for ((k, v) in newStyles) k.toIntOrNull()?.let { styles[it] = v }
    }

    operator fun get(id: Int): Style = if (id == 0) Style.DEFAULT else styles[id] ?: Style.DEFAULT

    fun reset() = styles.clear()

    val size: Int get() = styles.size
}

class TerminalGrid private constructor(val cols: Int, val rows: Int, val lines: Array<Row>, val rev: Long) {

    fun row(y: Int): Row = lines[y]

    /** `full` frames replace everything (absent rows are blank); partial frames replace listed rows only. */
    fun apply(frame: Frame): TerminalGrid {
        val base = when {
            frame.full -> empty(frame.cols, frame.rows, frame.rev)
            frame.cols != cols || frame.rows != rows -> resize(frame.cols, frame.rows)
            else -> this
        }
        val next = base.lines.copyOf()
        for (line in frame.lines) {
            if (line.y in 0 until frame.rows) next[line.y] = Row.fromRuns(line.runs, frame.cols)
        }
        return TerminalGrid(frame.cols, frame.rows, next, frame.rev)
    }

    fun resize(newCols: Int, newRows: Int): TerminalGrid {
        if (newCols == cols && newRows == rows) return this
        val blank = Row.blank(newCols)
        val next = Array(newRows) { y -> lines.getOrNull(y)?.resized(newCols) ?: blank }
        return TerminalGrid(newCols, newRows, next, rev)
    }

    /** One line per row up to the last non-blank row, trailing spaces trimmed, no trailing newline. */
    fun plainText(): String {
        val last = lines.indexOfLast { !it.isEmpty }
        if (last < 0) return ""
        return (0..last).joinToString("\n") { lines[it].text() }
    }

    companion object {
        fun empty(cols: Int, rows: Int, rev: Long = 0): TerminalGrid {
            val blank = Row.blank(cols)
            return TerminalGrid(cols, rows, Array(rows) { blank }, rev)
        }
    }
}

/**
 * Minimal grapheme segmentation, enough to tell one wide grapheme from two narrow characters:
 * combining marks, variation selectors, ZWJ sequences, emoji modifiers/tags and regional-indicator
 * pairs stay attached to the preceding character.
 */
object Graphemes {
    private const val ZWJ = 0x200D

    fun split(t: String): List<String> {
        val out = ArrayList<String>(t.length)
        var start = 0
        var i = 0
        var prev = -1
        var riCount = 0
        while (i < t.length) {
            val cp = t.codePointAt(i)
            val attach = i > start && (isExtend(cp) || prev == ZWJ ||
                (isRegionalIndicator(prev) && isRegionalIndicator(cp) && riCount == 1))
            if (!attach && i > start) {
                out.add(t.substring(start, i))
                start = i
                riCount = 0
            }
            if (isRegionalIndicator(cp)) riCount++
            prev = cp
            i += Character.charCount(cp)
        }
        if (start < t.length) out.add(t.substring(start))
        return out
    }

    fun isSingle(t: String) = split(t).size == 1

    private fun isRegionalIndicator(cp: Int) = cp in 0x1F1E6..0x1F1FF

    private fun isExtend(cp: Int): Boolean {
        when (Character.getType(cp)) {
            Character.NON_SPACING_MARK.toInt(), Character.ENCLOSING_MARK.toInt(), Character.COMBINING_SPACING_MARK.toInt() -> return true
        }
        return cp == ZWJ || cp == 0x200C || cp in 0xFE00..0xFE0F || cp in 0xE0100..0xE01EF ||
            cp in 0x1F3FB..0x1F3FF || cp in 0xE0020..0xE007F
    }
}

// The phone's copy of a pane's history (protocol §4 / §6 `scrollback`): logical lines numbered within an epoch, kept
// per pane in memory, and the same lines wrapped to the width the terminal view shows. Lines that a terminal
// soft-wrapped arrive as one line; the phone wraps them itself, so a different width only means wrapping again.
package com.inferenceaftermath.remotly.core.terminal

import com.inferenceaftermath.remotly.core.protocol.Style
import com.inferenceaftermath.remotly.core.protocol.WireRun
import java.util.concurrent.atomic.AtomicLong
import kotlin.math.max
import kotlin.math.min

/**
 * One pane's history as it stood at one moment: lines numbered [base] until [next], oldest first, their style ids in
 * [styles]. Within a [generation] a number always names the same line and both ends only move forward (old lines
 * trimmed, new ones appended); a reset (or a legacy `history` read) starts a new generation. Later changes to the
 * store leave a snapshot as it is, so it can be read on another thread.
 */
class ScrollbackLines(
    val pane: String,
    val generation: Long,
    val base: Int,
    val lines: List<List<WireRun>>,
    val styles: StyleTable,
    /** An answer to a `scrollback` request is still arriving: lines added now are older output, not lines that just
     *  left the screen. */
    val answering: Boolean = false,
) {
    val next: Int get() = base + lines.size

    /** The same lines, the answer arriving or not. */
    fun answering(answering: Boolean) = ScrollbackLines(pane, generation, base, lines, styles, answering)

    companion object {
        private val generations = AtomicLong()
        fun newGeneration(): Long = generations.incrementAndGet()
    }
}

/** What [ScrollbackStore.apply] made of one `scrollback` message. */
sealed interface ScrollbackOutcome {
    /** [appended] lines added at the end and [dropped] taken from the front; on a [reset] every line held before is dropped. */
    data class Applied(val appended: Int, val dropped: Int, val reset: Boolean) : ScrollbackOutcome

    /** Lines were missed (another epoch, or `start` past the next number): ask again without `epoch` for the whole copy. */
    data object Resync : ScrollbackOutcome
}

/**
 * One pane's lines. Not thread-safe: the connection changes it under its lock and hands out [snapshot]s. Lines live in
 * an array that is only ever written past its last line, so a snapshot is a view, not a copy.
 */
class ScrollbackStore(val pane: String, maxLines: Int = DEFAULT_MAX_LINES) {
    var epoch: String? = null
        private set
    /** The number of the oldest line held. */
    var base = 0
        private set
    var maxLines = maxLines
        private set
    var size = 0
        private set
    var generation = ScrollbackLines.newGeneration()
        private set
    /** The number the next line will get. */
    val next: Int get() = base + size

    private var buf = arrayOfNulls<List<WireRun>>(16)
    private var head = 0

    /** Takes the lines of one message, numbered from [start] under [epoch]; [reset] replaces everything held. */
    fun apply(epoch: String, start: Int, lines: List<List<WireRun>>, reset: Boolean): ScrollbackOutcome {
        if (reset) {
            val dropped = size
            this.epoch = epoch
            base = start
            buf = arrayOfNulls(max(16, min(lines.size, maxLines)))
            head = 0
            size = 0
            generation = ScrollbackLines.newGeneration()
            for (i in max(0, lines.size - maxLines) until lines.size) add(lines[i])
            base = start + max(0, lines.size - maxLines)
            return ScrollbackOutcome.Applied(size, dropped, true)
        }
        if (epoch != this.epoch || start > next) return ScrollbackOutcome.Resync
        var appended = 0
        for (i in (next - start) until lines.size) {
            add(lines[i])
            appended++
        }
        return ScrollbackOutcome.Applied(appended, trim(), false)
    }

    /** Whether the `ok` that closed an answer describes this copy; if not, lines were missed. */
    fun agrees(epoch: String?, next: Int?): Boolean = epoch != null && epoch == this.epoch && next == this.next

    /** Before a request: hold up to [PROTOCOL_MAX_LINES] until the answer's `ok` says the bridge's own limit. */
    fun raiseForAnswer() {
        maxLines = max(maxLines, PROTOCOL_MAX_LINES)
    }

    /** The bridge's `max_lines`; returns the number of old lines dropped to meet it. */
    fun limit(maxLines: Int): Int {
        this.maxLines = max(0, maxLines)
        return trim()
    }

    fun snapshot(styles: StyleTable, answering: Boolean = false) =
        ScrollbackLines(pane, generation, base, LineView(buf, head, size), styles, answering)

    private fun add(line: List<WireRun>) {
        if (head + size == buf.size) relocate(size * 2) // full
        buf[head + size] = line
        size++
    }

    private fun trim(): Int {
        val over = size - maxLines
        if (over <= 0) return 0
        head += over
        size -= over
        base += over
        // trimmed lines stay in the array for the snapshots that may still read them; past a quarter of the lines held,
        // the lines held move to a new array, so the store never keeps many more lines than it holds
        if (head > max(16, size / 4)) relocate(size + size / 2)
        return over
    }

    /** The lines held, into a new array of [capacity] slots (old snapshots keep the old one). */
    private fun relocate(capacity: Int) {
        val moved = arrayOfNulls<List<WireRun>>(max(16, capacity))
        System.arraycopy(buf, head, moved, 0, size)
        buf = moved
        head = 0
    }

    private class LineView(private val buf: Array<List<WireRun>?>, private val head: Int, override val size: Int) : AbstractList<List<WireRun>>() {
        override fun get(index: Int): List<WireRun> {
            if (index !in 0 until size) throw IndexOutOfBoundsException("$index of $size")
            return buf[head + index]!!
        }
    }

    companion object {
        /** The most lines a bridge keeps per pane (`scrollback.max_lines` at its highest). */
        const val PROTOCOL_MAX_LINES = 100_000
        /** What a store holds until an `ok` says how many this bridge keeps. */
        const val DEFAULT_MAX_LINES = PROTOCOL_MAX_LINES
    }
}

/**
 * The stores of the panes looked at most recently on one connection (one host): the oldest are forgotten past
 * [capacity] panes, or while the lines they hold together pass [lineBudget] (the one used last always stays), so a
 * bridge keeping long histories costs the phone one pane's worth, not eight.
 */
class ScrollbackStores(private val capacity: Int = 8, private val lineBudget: Int = ScrollbackStore.PROTOCOL_MAX_LINES) {
    /** Used longest ago first: [of] moves a store to the end, [peek] leaves the order as it is. */
    private val stores = LinkedHashMap<String, ScrollbackStore>()
    /** The last `max_lines` a bridge sent, for stores made from now on. */
    var maxLines = ScrollbackStore.DEFAULT_MAX_LINES

    fun of(pane: String): ScrollbackStore {
        val store = stores.remove(pane) ?: ScrollbackStore(pane, maxLines)
        stores[pane] = store
        fit()
        return store
    }

    /** Forgets the stores used longest ago past [capacity], or while the lines held pass [lineBudget]. */
    fun fit() {
        var held = stores.values.sumOf { it.size }
        while (stores.size > 1 && (stores.size > capacity || held > lineBudget)) {
            held -= stores.remove(stores.keys.first())!!.size
        }
    }

    fun peek(pane: String): ScrollbackStore? = stores[pane]

    /** A request for [pane]'s history is going out: its store (made now if none) holds everything until the `ok`. */
    fun raiseForAnswer(pane: String) {
        of(pane).raiseForAnswer()
    }

    val panes: Set<String> get() = stores.keys
}

/**
 * Style ids for stored history. The bridge's ids are per connection and start over after every reconnect while the
 * stored lines outlive it, so each run's style is looked up when its line arrives and given an id here that lasts.
 */
class HistoryStyles {
    val table = StyleTable()
    private val ids = HashMap<Style, Int>()

    @Synchronized
    fun remap(runs: List<WireRun>, from: StyleTable): List<WireRun> {
        if (runs.all { it.s == 0 }) return runs
        return runs.map { if (it.s == 0) it else it.copy(s = idOf(from[it.s])) }
    }

    private fun idOf(style: Style): Int {
        if (style == Style.DEFAULT) return 0
        return ids.getOrPut(style) { (ids.size + 1).also { table.put(it, style) } }
    }
}

/** Shares one [Cell] per printable ASCII character and style: history holds a great many of them. */
class CellPool {
    private val ascii = HashMap<Int, Array<Cell?>>()

    fun narrow(t: String, style: Int): Cell = if (t.length == 1 && t[0] in ' '..'~') ascii(t[0], style) else Cell(t, 1, style)

    fun ascii(ch: Char, style: Int): Cell {
        if (ch == ' ' && style == 0) return Cell.BLANK
        val row = ascii.getOrPut(style) { arrayOfNulls(95) }
        return row[ch - ' '] ?: Cell(ch.toString(), 1, style).also { row[ch - ' '] = it }
    }
}

object HistoryWrap {
    /**
     * One logical line as rows of [cols] cells. A narrow run that crosses the right edge goes on in the next row, split
     * between graphemes (a combining mark stays with its letter); a wide character that would only half fit leaves the
     * last cell blank and starts the next row, moving the rest of the line one cell on. An empty line is one blank row.
     */
    fun rows(runs: List<WireRun>, cols: Int, pool: CellPool = CellPool()): List<Row> {
        if (cols <= 0) return emptyList()
        val out = ArrayList<Array<Cell>>(1)
        val inked = ArrayList<Boolean>(1)
        fun put(pos: Int, cell: Cell) {
            val r = pos / cols
            while (out.size <= r) {
                out.add(Array(cols) { Cell.BLANK })
                inked.add(false)
            }
            out[r][pos % cols] = cell
            if (cell !== Cell.BLANK) inked[r] = true
        }
        var shift = 0 // cells the line moved on for wide characters pushed to the next row
        for (run in runs) {
            if (run.w <= 0 || run.c < 0) continue
            val start = run.c + shift
            if (run.w == run.t.length && run.t.all { it in ' '..'~' }) {
                for (i in 0 until run.w) put(start + i, pool.ascii(run.t[i], run.s))
                continue
            }
            val g = Graphemes.split(run.t)
            if (run.w == 2 && g.size == 1) {
                var p = start
                if (cols >= 2 && p % cols == cols - 1) {
                    shift++
                    p++
                }
                put(p, Cell(run.t, 2, run.s))
                if (cols >= 2) put(p + 1, Cell.CONTINUATION)
                continue
            }
            val parts = Row.fit(g, run.w)
            for (i in 0 until run.w) put(start + i, pool.narrow(parts[i], run.s))
        }
        if (out.isEmpty()) return listOf(Row.blank(cols))
        return out.mapIndexed { i, cells -> Row.of(cells, !inked[i]) }
    }

    /** How many rows [rows] makes of the line at [cols], without making them (the same placement, cell by cell). */
    fun count(runs: List<WireRun>, cols: Int): Int {
        if (cols <= 0) return 0
        var end = 0 // one past the last cell placed
        var shift = 0
        for (run in runs) {
            if (run.w <= 0 || run.c < 0) continue
            val start = run.c + shift
            if (run.w == run.t.length && run.t.all { it in ' '..'~' }) {
                end = max(end, start + run.w)
                continue
            }
            if (run.w == 2 && Graphemes.split(run.t).size == 1) {
                var p = start
                if (cols >= 2 && p % cols == cols - 1) {
                    shift++
                    p++
                }
                end = max(end, if (cols >= 2) p + 2 else p + 1)
                continue
            }
            end = max(end, start + run.w)
        }
        return if (end == 0) 1 else (end - 1) / cols + 1
    }
}

/**
 * What one [WrappedHistory.sync] changed, in rows: [appended] at the end and [dropped] from the front, or everything
 * [rebuilt]; [rewrapped] when it was rebuilt from the same numbered lines (another width), so line numbers still match.
 */
data class HistoryChange(val appended: Int, val dropped: Int, val rebuilt: Boolean, val rewrapped: Boolean = false) {
    val any: Boolean get() = rebuilt || appended > 0 || dropped > 0

    companion object {
        val NONE = HistoryChange(0, 0, false)
    }
}

/**
 * History lines wrapped to [cols], kept in step with [ScrollbackLines]: a sync counts the rows of the lines that are
 * new and drops those of lines trimmed from the front; everything is counted again only for another width, pane or
 * generation. The rows themselves are made only for the lines drawn (the last [MADE_LINES] of them are kept): a long
 * history is mostly never looked at, and its rows would take far more memory than its lines. Single-threaded (the
 * terminal view's).
 */
class WrappedHistory {
    var cols = 0
        private set
    var styles: StyleTable? = null
        private set
    private var pane: String? = null
    private var generation = -1L
    private var lines: ScrollbackLines? = null
    /** Numbers of the first line held and the one after the last. */
    private var base = 0
    private var next = 0
    /** Per line held, its first row counted from the first row ever added in this generation. */
    private val firstRows = FrontTrimmed<Int>()
    /** That count for the first row held, and for the row after the last. */
    private var rowBase = 0
    private var rowEnd = 0
    private val pool = CellPool()
    private var blank: Row? = null
    /** The rows of the lines drawn lately, by line number; the line used longest ago goes first. */
    private val made = object : LinkedHashMap<Int, List<Row>>(64, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<Int, List<Row>>?): Boolean = size > MADE_LINES
    }

    val size: Int get() = rowEnd - rowBase

    operator fun get(row: Int): Row {
        if (row !in 0 until size) throw IndexOutOfBoundsException("$row of $size")
        val number = lineAt(row)
        val rows = made.getOrPut(number) {
            val s = lines!!
            val line = s.lines[number - s.base]
            if (line.isEmpty()) listOf(blankRow()) else HistoryWrap.rows(line, cols, pool)
        }
        return rows.getOrNull(row - firstRowOf(number)) ?: blankRow()
    }

    fun sync(s: ScrollbackLines?, cols: Int): HistoryChange {
        if (s == null || cols <= 0) {
            if (pane == null && size == 0) return HistoryChange.NONE
            reset(null, -1L, 0, cols)
            lines = null
            styles = null
            return HistoryChange(0, 0, true)
        }
        styles = s.styles
        val sameLines = s.pane == pane && s.generation == generation
        if (!sameLines || cols != this.cols || s.base < base) {
            reset(s.pane, s.generation, s.base, cols)
            lines = s
            for (line in s.lines) count(line)
            next = s.next
            return HistoryChange(size, 0, rebuilt = true, rewrapped = sameLines)
        }
        lines = s
        var dropped = 0
        if (s.base > base) {
            val gone = min(s.base, next) - base
            val keepFrom = if (gone < firstRows.size) firstRows[gone] - rowBase else size
            firstRows.dropFront(gone)
            rowBase += keepFrom
            dropped = keepFrom
            base = s.base
            if (next < base) next = base
        }
        val before = size
        for (n in next until s.next) count(s.lines[n - s.base])
        next = s.next
        return HistoryChange(size - before, dropped, false)
    }

    /** The number of the line [row] belongs to (rows past the end: the last line). */
    fun lineAt(row: Int): Int {
        if (firstRows.size == 0) return base
        val target = rowBase + row
        var lo = 0
        var hi = firstRows.size - 1
        while (lo < hi) {
            val mid = (lo + hi + 1) ushr 1
            if (firstRows[mid] <= target) lo = mid else hi = mid - 1
        }
        return base + lo
    }

    /** The row line [number] starts on (clamped to the lines held). */
    fun firstRowOf(number: Int): Int {
        if (firstRows.size == 0) return 0
        val i = (number - base).coerceIn(0, firstRows.size - 1)
        return firstRows[i] - rowBase
    }

    /** How many rows line [number] takes (clamped to the lines held; 0 with none). */
    fun rowsOf(number: Int): Int {
        if (firstRows.size == 0) return 0
        val i = (number - base).coerceIn(0, firstRows.size - 1)
        val end = if (i + 1 < firstRows.size) firstRows[i + 1] - rowBase else size
        return end - (firstRows[i] - rowBase)
    }

    private fun reset(pane: String?, generation: Long, base: Int, cols: Int) {
        if (cols != this.cols) blank = null
        this.pane = pane
        this.generation = generation
        this.cols = cols
        this.base = base
        next = base
        firstRows.clear()
        rowBase = 0
        rowEnd = 0
        made.clear()
    }

    private fun count(line: List<WireRun>) {
        firstRows.add(rowEnd)
        rowEnd += if (line.isEmpty()) 1 else HistoryWrap.count(line, cols)
    }

    private fun blankRow(): Row = blank ?: Row.blank(cols).also { blank = it }

    /** A list that grows at the end and is trimmed at the front, without moving everything for each trim. */
    private class FrontTrimmed<T> {
        private val items = ArrayList<T>()
        private var head = 0
        val size: Int get() = items.size - head
        operator fun get(i: Int): T = items[head + i]
        fun add(item: T) { items.add(item) }
        fun dropFront(n: Int) {
            head += n
            if (head > 1024 && head * 2 > items.size) {
                items.subList(0, head).clear()
                head = 0
            }
        }
        fun clear() {
            items.clear()
            head = 0
        }
    }

    companion object {
        /** Lines whose rows are kept made: several screens' worth, so scrolling back and forth makes none again. */
        const val MADE_LINES = 512
    }
}

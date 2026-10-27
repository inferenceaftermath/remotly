package com.inferenceaftermath.remotly.core

import com.inferenceaftermath.remotly.core.connection.FlowConnection
import com.inferenceaftermath.remotly.core.connection.HostConfig
import com.inferenceaftermath.remotly.core.protocol.ClientInfo
import com.inferenceaftermath.remotly.core.protocol.Codec
import com.inferenceaftermath.remotly.core.protocol.OkMessage
import com.inferenceaftermath.remotly.core.protocol.Scrollback
import com.inferenceaftermath.remotly.core.protocol.ScrollbackMessage
import com.inferenceaftermath.remotly.core.protocol.Style
import com.inferenceaftermath.remotly.core.protocol.WireRun
import com.inferenceaftermath.remotly.core.terminal.Cell
import com.inferenceaftermath.remotly.core.terminal.HistoryWrap
import com.inferenceaftermath.remotly.core.terminal.ScrollbackOutcome
import com.inferenceaftermath.remotly.core.terminal.ScrollbackStore
import com.inferenceaftermath.remotly.core.terminal.ScrollbackStores
import com.inferenceaftermath.remotly.core.terminal.StyleTable
import com.inferenceaftermath.remotly.core.terminal.WrappedHistory
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNotEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertSame
import kotlin.test.assertTrue

class ScrollbackTest {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    @AfterEach
    fun tearDown() = scope.cancel()

    private fun line(t: String, s: Int = 0): List<WireRun> = if (t.isEmpty()) emptyList() else listOf(WireRun(0, t.length, s, t))
    private fun numbered(from: Int, count: Int) = (from until from + count).map { line("L$it") }
    private fun texts(lines: List<List<WireRun>>) = lines.map { l -> l.joinToString("") { it.t } }

    // ------------------------------------------------------------ store

    @Test
    fun `a reset replaces everything under a new generation`() {
        val store = ScrollbackStore("p")
        assertEquals(ScrollbackOutcome.Applied(3, 0, true), store.apply("e1", 0, numbered(0, 3), reset = true))
        val first = store.generation
        assertEquals("e1", store.epoch)
        assertEquals(3, store.next)
        assertEquals(ScrollbackOutcome.Applied(2, 3, true), store.apply("e2", 40, numbered(40, 2), reset = true))
        assertEquals("e2", store.epoch)
        assertEquals(40, store.base)
        assertEquals(42, store.next)
        assertNotEquals(first, store.generation)
        assertEquals(listOf("L40", "L41"), texts(store.snapshot(StyleTable()).lines))
    }

    @Test
    fun `lines already held are skipped and the rest appended`() {
        val store = ScrollbackStore("p")
        store.apply("e", 0, numbered(0, 5), reset = true)
        val generation = store.generation
        assertEquals(ScrollbackOutcome.Applied(3, 0, false), store.apply("e", 3, numbered(3, 5), reset = false))
        assertEquals(8, store.next)
        assertEquals(numbered(0, 8).map { it[0].t }, texts(store.snapshot(StyleTable()).lines))
        assertEquals(ScrollbackOutcome.Applied(0, 0, false), store.apply("e", 2, numbered(2, 4), reset = false), "all of them held already")
        assertEquals(ScrollbackOutcome.Applied(1, 0, false), store.apply("e", 8, numbered(8, 1), reset = false))
        assertEquals(generation, store.generation, "appending keeps the generation")
    }

    @Test
    fun `another epoch, a gap or a store without a copy asks for the whole copy`() {
        val fresh = ScrollbackStore("p")
        assertEquals(ScrollbackOutcome.Resync, fresh.apply("e", 0, numbered(0, 1), reset = false))
        val store = ScrollbackStore("p")
        store.apply("e", 0, numbered(0, 5), reset = true)
        assertEquals(ScrollbackOutcome.Resync, store.apply("other", 5, numbered(5, 1), reset = false))
        assertEquals(ScrollbackOutcome.Resync, store.apply("e", 6, numbered(6, 1), reset = false))
        assertEquals(5, store.next, "nothing taken from either")
        assertIs<ScrollbackOutcome.Applied>(store.apply("e", 5, numbered(5, 1), reset = false))
    }

    @Test
    fun `the store keeps maxLines lines, oldest dropped first, numbers going on`() {
        val store = ScrollbackStore("p", maxLines = 5)
        assertEquals(ScrollbackOutcome.Applied(5, 0, true), store.apply("e", 0, numbered(0, 8), reset = true))
        assertEquals(3, store.base)
        assertEquals(listOf("L3", "L4", "L5", "L6", "L7"), texts(store.snapshot(StyleTable()).lines))
        assertEquals(ScrollbackOutcome.Applied(2, 2, false), store.apply("e", 8, numbered(8, 2), reset = false))
        assertEquals(5, store.base)
        assertEquals(10, store.next)
        assertEquals(2, store.limit(3), "a smaller max_lines from the ok")
        assertEquals(listOf("L7", "L8", "L9"), texts(store.snapshot(StyleTable()).lines))
    }

    @Test
    fun `an answer larger than the last limit is kept until its ok`() {
        val stores = ScrollbackStores()
        stores.maxLines = 5
        val store = stores.of("p")
        store.apply("e", 0, numbered(0, 5), reset = true)
        stores.raiseForAnswer("p")
        assertEquals(ScrollbackStore.PROTOCOL_MAX_LINES, store.maxLines)
        assertEquals(ScrollbackOutcome.Applied(8, 5, true), store.apply("f", 0, numbered(0, 8), reset = true))
        assertEquals(ScrollbackOutcome.Applied(4, 0, false), store.apply("f", 8, numbered(8, 4), reset = false))
        assertEquals(12, store.size, "nothing dropped before the ok")
        assertEquals(2, store.limit(10), "the ok's max_lines")
        assertEquals(2, store.base)
        assertEquals(12, store.next)
    }

    @Test
    fun `the ok must match the copy`() {
        val store = ScrollbackStore("p")
        assertFalse(store.agrees(null, 0), "nothing held yet")
        store.apply("e", 10, numbered(10, 4), reset = true)
        assertTrue(store.agrees("e", 14))
        assertFalse(store.agrees("e", 15), "a line was missed")
        assertFalse(store.agrees("f", 14), "another copy")
    }

    @Test
    fun `a snapshot stays as it was while the store moves on`() {
        val store = ScrollbackStore("p", maxLines = 4)
        store.apply("e", 0, numbered(0, 4), reset = true)
        val before = store.snapshot(StyleTable())
        repeat(20) { store.apply("e", 4 + it, numbered(4 + it, 1), reset = false) }
        assertEquals(listOf("L0", "L1", "L2", "L3"), texts(before.lines))
        assertEquals(0, before.base)
        assertEquals(listOf("L20", "L21", "L22", "L23"), texts(store.snapshot(StyleTable()).lines))
    }

    @Test
    fun `stores are kept for the eight panes looked at last`() {
        val stores = ScrollbackStores()
        val first = stores.of("p0")
        for (i in 1..7) stores.of("p$i")
        assertSame(first, stores.of("p0"), "used again: now the newest")
        stores.of("p8")
        assertNotNull(stores.peek("p0"))
        assertNull(stores.peek("p1"), "the one not looked at longest is forgotten")
        assertEquals(8, stores.panes.size)
    }

    @Test
    fun `a store at its limit keeps the snapshots it gave out readable while it moves on`() {
        val store = ScrollbackStore("p", maxLines = 100)
        store.apply("e", 0, List(100) { line("l$it") }, reset = true)
        val old = store.snapshot(StyleTable())
        for (n in 100 until 1000) store.apply("e", n, listOf(line("l$n")), reset = false)
        assertEquals(100, store.size)
        assertEquals(900, store.base)
        assertEquals("l0", old.lines[0][0].t, "an earlier snapshot still reads its own lines")
        assertEquals("l99", old.lines[99][0].t)
        val now = store.snapshot(StyleTable())
        assertEquals((900 until 1000).map { "l$it" }, now.lines.map { it[0].t })
    }

    @Test
    fun `past the line budget the panes used longest ago give way, the one used last stays`() {
        val stores = ScrollbackStores(capacity = 8, lineBudget = 10)
        stores.of("a").apply("e", 0, List(6) { line("a$it") }, reset = true)
        stores.fit()
        stores.of("b").apply("e", 0, List(3) { line("b$it") }, reset = true)
        stores.fit()
        assertNotNull(stores.peek("a"), "9 lines together: within the budget")
        stores.of("c").apply("e", 0, List(4) { line("c$it") }, reset = true)
        stores.fit()
        assertNull(stores.peek("a"), "13 lines: the pane used longest ago goes")
        assertNotNull(stores.peek("b"))
        stores.of("c").apply("e", 4, List(20) { line("c${it + 4}") }, reset = false)
        stores.fit()
        assertEquals(setOf("c"), stores.panes, "the pane in use stays, even past the budget alone")
        assertEquals(24, stores.peek("c")!!.size)
    }

    // ------------------------------------------------------------ wrapping

    @Test
    fun `a narrow run goes on in the next row at the edge`() {
        val rows = HistoryWrap.rows(listOf(WireRun(0, 10, 0, "abcdefghij")), 4)
        assertEquals(listOf("abcd", "efgh", "ij"), rows.map { it.text() })
        assertTrue(rows.all { it.cols == 4 })
        // a gap between runs is blank cells, wherever it falls
        assertEquals(listOf("ab", "  cd"), HistoryWrap.rows(listOf(WireRun(0, 2, 0, "ab"), WireRun(6, 2, 0, "cd")), 4).map { it.text() })
    }

    @Test
    fun `a wide character that would only half fit starts the next row`() {
        val rows = HistoryWrap.rows(listOf(WireRun(0, 3, 0, "abc"), WireRun(3, 2, 0, "日"), WireRun(5, 1, 0, "x")), 4)
        assertEquals(2, rows.size)
        assertEquals("abc", rows[0].text())
        assertTrue(rows[0].cells[3].isBlank)
        assertEquals("日", rows[1].cells[0].text)
        assertEquals(2, rows[1].cells[0].width)
        assertSame(Cell.CONTINUATION, rows[1].cells[1])
        assertEquals("x", rows[1].cells[2].text, "the rest of the line moves one cell on")
    }

    @Test
    fun `an empty line is one blank row and a combining mark stays with its letter`() {
        val empty = HistoryWrap.rows(emptyList(), 6)
        assertEquals(1, empty.size)
        assertTrue(empty[0].isEmpty)
        val rows = HistoryWrap.rows(listOf(WireRun(0, 5, 2, "abcéd")), 3)
        assertEquals(listOf("abc", "éd"), rows.map { it.text() })
        assertEquals("é", rows[1].cells[0].text)
        assertEquals(2, rows[1].cells[0].styleId)
    }

    @Test
    fun `the rows counted for a line are the rows made of it`() {
        val lines = listOf(
            emptyList(),
            listOf(WireRun(0, 10, 0, "abcdefghij")),
            listOf(WireRun(0, 2, 0, "ab"), WireRun(6, 2, 0, "cd")),
            listOf(WireRun(0, 3, 0, "abc"), WireRun(3, 2, 0, "日"), WireRun(5, 1, 0, "x")),
            listOf(WireRun(0, 2, 0, "日"), WireRun(2, 2, 0, "本"), WireRun(4, 2, 0, "語"), WireRun(6, 2, 0, "日"), WireRun(8, 2, 0, "本")),
            listOf(WireRun(0, 5, 2, "abcéd")),
            listOf(WireRun(0, 0, 0, ""), WireRun(-1, 3, 0, "zzz")),
            listOf(WireRun(7, 1, 0, " ")),
        )
        for (line in lines) for (cols in 1..9) {
            assertEquals(HistoryWrap.rows(line, cols).size, HistoryWrap.count(line, cols), "$line at $cols columns")
        }
    }

    @Test
    fun `wrapped history wraps only new lines, drops trimmed ones and wraps again for another width`() {
        val store = ScrollbackStore("p", maxLines = 4)
        store.apply("e", 0, listOf(line("aaaaaa"), line(""), line("bb")), reset = true)
        val wrapped = WrappedHistory()
        val first = wrapped.sync(store.snapshot(StyleTable()), 4)
        assertTrue(first.rebuilt)
        assertEquals(listOf("aaaa", "aa", "", "bb"), (0 until wrapped.size).map { wrapped[it].text() })
        store.apply("e", 3, listOf(line("cccccc"), line("d")), reset = false) // 5 lines → the first is trimmed
        val step = wrapped.sync(store.snapshot(StyleTable()), 4)
        assertEquals(3, step.appended)
        assertEquals(2, step.dropped)
        assertFalse(step.rebuilt)
        assertEquals(listOf("", "bb", "cccc", "cc", "d"), (0 until wrapped.size).map { wrapped[it].text() })
        assertEquals(3, wrapped.lineAt(3), "row 3 is the second row of line 3")
        assertEquals(2, wrapped.firstRowOf(3))
        assertEquals(2, wrapped.rowsOf(3))
        // another width: everything again, the same numbered lines
        val rewrap = wrapped.sync(store.snapshot(StyleTable()), 3)
        assertTrue(rewrap.rebuilt)
        assertTrue(rewrap.rewrapped)
        assertEquals(listOf("", "bb", "ccc", "ccc", "d"), (0 until wrapped.size).map { wrapped[it].text() })
        assertFalse(wrapped.sync(store.snapshot(StyleTable()), 3).any, "nothing new")
        // a reset is a new copy, not a re-wrap
        store.apply("f", 0, listOf(line("z")), reset = true)
        val reset = wrapped.sync(store.snapshot(StyleTable()), 3)
        assertTrue(reset.rebuilt)
        assertFalse(reset.rewrapped)
        assertEquals(1, wrapped.size)
    }

    // ------------------------------------------------------------ messages and connection

    @Test
    fun `scrollback messages, the ok fields and the request`() {
        val m = assertIs<ScrollbackMessage>(Codec.decodeServer(
            """{"t":"scrollback","pane":"pane_7","epoch":"9c1e","start":0,"reset":true,
              "lines":[{"runs":[{"c":0,"w":2,"s":1,"t":"ok"}]},{"runs":[]}],"styles":{"1":{"fg":"p2","bg":"d","a":0}}}""",
        ))
        assertEquals("9c1e", m.epoch)
        assertEquals(true, m.reset)
        assertEquals(2, m.lines.size)
        assertEquals(Style("p2"), m.styles["1"])
        assertNull(assertIs<ScrollbackMessage>(Codec.decodeServer("""{"t":"scrollback","pane":"p","epoch":"e","start":3,"lines":[],"styles":{}}""")).reset)
        val ok = assertIs<OkMessage>(Codec.decodeServer("""{"t":"ok","id":"4","epoch":"9c1e","next":3,"max_lines":10000}"""))
        assertEquals("9c1e", ok.epoch)
        assertEquals(3, ok.next)
        assertEquals(10_000, ok.max_lines)
        assertEquals("""{"t":"scrollback","id":"4","pane":"pane_7"}""", Codec.encode(Scrollback("4", "pane_7")))
        assertEquals("""{"t":"scrollback","id":"9","pane":"pane_7","epoch":"9c1e","from":4}""", Codec.encode(Scrollback("9", "pane_7", "9c1e", 4)))
    }

    @Test
    fun `the watched pane's lines reach the scrollback flow with styles that outlive the connection's ids`() {
        val conn = FlowConnection(HostConfig("wss://h:1", "tok", null), ClientInfo("android", "t", "d"), scope = scope)
        conn.watchedPane = "p"
        conn.handle("""{"t":"scrollback","pane":"other","epoch":"e","start":0,"reset":true,"lines":[{"runs":[{"c":0,"w":1,"t":"x"}]}],"styles":{}}""")
        assertNull(conn.scrollback.value, "another pane's lines are not taken")
        conn.handle("""{"t":"scrollback","pane":"p","epoch":"e","start":0,"reset":true,"lines":[{"runs":[{"c":0,"w":3,"s":3,"t":"red"}]},{"runs":[]}],"styles":{"3":{"fg":"p1","bg":"d","a":0}}}""")
        val first = assertNotNull(conn.scrollback.value)
        assertEquals("p", first.pane)
        assertEquals(2, first.next)
        val red = first.lines[0][0].s
        assertEquals("p1", first.styles[red].fg)
        // after a reconnect the bridge's id 3 means something else; the stored line keeps its colour
        conn.handle("""{"t":"welcome","protocol":1,"host":{"name":"h"},"device":{"id":"d","name":"n"}}""")
        conn.handle("""{"t":"scrollback","pane":"p","epoch":"e","start":2,"lines":[{"runs":[{"c":0,"w":4,"s":3,"t":"blue"}]}],"styles":{"3":{"fg":"p4","bg":"d","a":0}}}""")
        val after = assertNotNull(conn.scrollback.value)
        assertEquals(3, after.next)
        assertEquals(first.generation, after.generation)
        assertEquals("p1", after.styles[after.lines[0][0].s].fg)
        assertEquals("p4", after.styles[after.lines[2][0].s].fg)
        // a gap is not taken (the whole copy is asked for again)
        conn.handle("""{"t":"scrollback","pane":"p","epoch":"e","start":9,"lines":[{"runs":[]}],"styles":{}}""")
        assertEquals(3, conn.scrollback.value!!.next)
    }
}

// Canvas-drawn terminal: cell grid with JetBrains Mono, horizontal pan when cols exceed the width,
// vertical pan into history (pull past the top to enter scrollback / fetch more). herdr's live screen is
// usually taller than this view (a fit keeps herdr's row count), so the view is a window over it that
// follows the last row with content; in forwarding mode a swipe moves that window first and only what it
// cannot spend at the top or bottom edge goes to the program as wheel/arrow steps. The font size is the
// phone's text size by default and is changed with the A− / A+ buttons (no pinch: it was fiddly).
package com.inferenceaftermath.remotly.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Typeface
import android.util.TypedValue
import android.view.GestureDetector
import android.view.MotionEvent
import android.view.View
import android.widget.OverScroller
import android.graphics.PointF
import android.graphics.Rect
import android.os.Build
import android.os.SystemClock
import android.view.ActionMode
import android.view.HapticFeedbackConstants
import android.view.Menu
import android.view.MenuItem
import com.inferenceaftermath.remotly.core.terminal.GridPosition
import com.inferenceaftermath.remotly.core.terminal.Selection
import com.inferenceaftermath.remotly.core.terminal.selectionText
import com.inferenceaftermath.remotly.core.terminal.wordAt
import com.inferenceaftermath.remotly.R
import com.inferenceaftermath.remotly.core.protocol.Style
import com.inferenceaftermath.remotly.core.terminal.Cell
import com.inferenceaftermath.remotly.core.terminal.Row
import com.inferenceaftermath.remotly.core.terminal.RowShift
import com.inferenceaftermath.remotly.core.terminal.RowShiftDetector
import com.inferenceaftermath.remotly.core.terminal.StyleTable
import com.inferenceaftermath.remotly.core.terminal.TerminalGrid
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sign

class TerminalView(context: Context) : View(context) {
    var styles: StyleTable? = null
    /** Live mode: the user pulled past the top → the screen should fetch history. */
    var onScrollback: (() -> Unit)? = null
    /** History mode: near the top → fetch more (the caller throttles). */
    var onReachTop: (() -> Unit)? = null
    /** History mode: the user pulled past the bottom → the screen should return to live. */
    var onPullBottom: (() -> Unit)? = null
    /** A plain tap on the terminal (the screen uses it to put the keyboard away). */
    var onTap: (() -> Unit)? = null
    /** Forwarding mode: the swipe so far is worth `lines` wheel/arrow steps in `direction` at the touched cell (1-based). */
    var onScrollLines: ((direction: String, lines: Int, col: Int, row: Int) -> Unit)? = null
    /**
     * false → vertical swipes scroll this view (scrollback); true → they move the window over the live screen and, at its
     * edges, are coalesced and reported via [onScrollLines].
     */
    var forwardScroll = false
        set(value) {
            if (field == value) return
            field = value
            scrollAcc = 0f
            pendingLines = 0
            scroller.forceFinished(true)
            cancelInertia()
            if (!value) endSlide()
            offsetY = liveBottomY()
            invalidate()
        }
    /** Columns × rows this view can show at the current font; reported whenever it changes (used for `fit`). */
    var onDeviceGrid: ((cols: Int, rows: Int) -> Unit)? = null
    /** A selection was copied on a phone that shows no system clipboard confirmation (Android 12 and older). */
    var onCopied: (() -> Unit)? = null
    /** Fit mode: the pane follows this device, so a "fit to width" font (scale 0) means the default size instead. */
    var fitMode = false
        set(value) {
            if (field == value) return
            field = value
            keepingPlace { updateMetrics() }
            invalidate()
        }
    private var lastDeviceGrid = 0 to 0

    private var grid: TerminalGrid? = null
    private var history: List<Row>? = null
    private var fontScale = 0f // 0 = fit to width
    private val regular: Typeface = resources.getFont(R.font.jetbrains_mono_regular)
    private val bold: Typeface = resources.getFont(R.font.jetbrains_mono_bold)
    private val textPaint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.SUBPIXEL_TEXT_FLAG).apply { typeface = regular }
    private val bgPaint = Paint()
    private var cellW = 1f
    private var cellH = 1f
    private var baseline = 0f
    private var offsetX = 0f
    private var offsetY = 0f
    private var pullUp = 0f
    private var pullDown = 0f
    private var scrollAcc = 0f
    private var pendingLines = 0 // forwarded scroll not yet sent: > 0 down, < 0 up
    private var pendingCol = 1
    private var pendingRow = 1
    private var flushPosted = false
    private val scroller = OverScroller(context)
    /** The running fling moves Y (false: horizontal only, Y is pinned). */
    private var flingMovesY = false
    /** Forwarding: hand what is left of the fling to the program when the window reaches the edge it is heading for. */
    private var flingHandoff = false
    private var flingDown = true
    private var flingX = 0f
    private var flingY = 0f

    // Emulated inertia after a fling in forwarding mode (the desktop program has none): lines/s left, fraction carried, lines sent.
    private var inertiaSpeed = 0f
    private var inertiaDir = 1
    private var inertiaCarry = 0f
    private var inertiaSent = 0
    private var inertiaX = 0f
    private var inertiaY = 0f
    /** When a swipe or inertia step last went to the program; a frame within [SLIDE_WINDOW_MS] of it may slide. */
    private var lastForwardedAt = 0L
    private var lastShiftAt = 0L

    // Slide: a frame that is the previous screen scrolled by whole rows glides into place instead of jumping.
    /** Pixels the moving region is displaced from its final place (positive = drawn lower). */
    private var slideOffset = 0f
    private var slideMovingRows = 0
    /** Rows that scrolled out of the moving region, drawn next to it while it slides (above row 0, or below the region). */
    private var leaving: List<Row> = emptyList()
    private var leavingAbove = true
    private var slideVelocity = 0f // px per second toward 0
    private var lastSlideFrame = 0L

    // Long-press selection: anchor/focus cells over the rows being shown (live or scrollback).
    private var selection: Selection? = null
    /** 0 = not dragging, 1 = moving the anchor, 2 = moving the focus. */
    private var draggingEnd = 0
    private var detectorSawDown = false
    private var actionMode: ActionMode? = null
    private val selectionPaint = Paint().apply { color = SELECTION_COLOR }

    private val rows: List<Row> get() = history ?: grid?.lines?.asList() ?: emptyList()
    private val cols: Int get() = max(grid?.cols ?: 0, history?.maxOfOrNull { it.cols } ?: 0)

    val isLive: Boolean get() = history == null

    fun setGrid(g: TerminalGrid?) {
        val wasBottom = atBottom()
        val old = grid
        val colsChanged = g?.cols != old?.cols
        if (g != null && old != null && forwardScroll && history == null && SystemClock.uptimeMillis() - lastForwardedAt < SLIDE_WINDOW_MS) {
            RowShiftDetector.detect(old, g)?.let { beginSlide(it, old) }
        } else if (g == null || old == null || g.rows != old.rows || colsChanged) {
            endSlide()
        }
        grid = g
        if (colsChanged) updateMetrics()
        if (history == null) {
            clampScroll()
            if (wasBottom) offsetY = liveBottomY()
        }
        invalidate()
    }

    fun setHistory(h: List<Row>?) {
        val old = history
        if (old === h) return
        endSlide()
        if ((h == null) != (old == null)) clearSelection() // different rows underneath
        history = h
        updateMetrics()
        when {
            h == null -> offsetY = liveBottomY() // back to live: the prompt
            old == null -> offsetY = maxOffsetY() // into history: the newest lines
            h.size > old.size -> offsetY += (h.size - old.size) * cellH // keep the visible lines in place
        }
        clampScroll()
        invalidate()
    }

    fun setFontScale(scale: Float) {
        if (scale == fontScale) return
        fontScale = scale
        keepingPlace { updateMetrics() }
        invalidate()
    }

    /** The font size actually drawn, in sp (the A− / A+ buttons step from here). */
    val effectiveSp: Float get() = if (cellH > 1f) textPaint.textSize / sp(1f) else DEFAULT_SP

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        // `height` is already the new one here. Judge "at the bottom" by the height the offset was set for: when the
        // keyboard opens the view gets shorter, the bottom moves further down, and the old offset would otherwise read
        // as "scrolled up" and the last rows would stay hidden. A first layout (nothing shown yet) starts at the bottom.
        val wasBottom = oldh <= 0 || atBottom(oldh)
        updateMetrics()
        if (wasBottom) offsetY = liveBottomY()
    }

    // ------------------------------------------------------------ metrics

    private fun sp(v: Float) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, v, resources.displayMetrics)

    private fun updateMetrics() {
        val basePx = sp(BASE_SP)
        textPaint.textSize = when {
            fontScale > 0f -> basePx * fontScale
            fitMode -> basePx * FIT_DEFAULT_SCALE
            else -> autoFitPx(basePx)
        }
        textPaint.typeface = regular
        cellW = textPaint.measureText("M")
        val fm = textPaint.fontMetrics
        cellH = ceil(fm.descent - fm.ascent)
        baseline = -fm.ascent
        clampScroll()
        reportDeviceGrid()
    }

    private fun reportDeviceGrid() {
        if (width <= 0 || height <= 0 || cellW <= 0f || cellH <= 0f) return
        val g = (width / cellW).toInt() to (height / cellH).toInt()
        if (g.first <= 0 || g.second <= 0 || g == lastDeviceGrid) return
        lastDeviceGrid = g
        onDeviceGrid?.invoke(g.first, g.second)
    }

    private fun autoFitPx(basePx: Float): Float {
        val c = cols
        if (c <= 0 || width <= 0) return basePx
        textPaint.textSize = 100f
        val advance = textPaint.measureText("M") / 100f
        return (width / (c * advance)).coerceIn(sp(MIN_SP), sp(MAX_AUTO_SP))
    }

    private fun contentWidth() = cols * cellW
    private fun contentHeight() = rows.size * cellH
    private fun maxOffsetX() = max(0f, contentWidth() - width)
    private fun maxOffsetY(viewHeight: Int = height) = max(0f, contentHeight() - viewHeight)

    /**
     * Where "the bottom" is: in history the last line; live, the last row with anything on it. herdr's
     * grid is taller than this view (a fit keeps herdr's row count), so a fresh shell (prompt on row 1,
     * 60 blank rows below) must show its top, while Claude Code (status bar on the last row) shows its bottom.
     */
    private fun liveBottomY(viewHeight: Int = height): Float {
        val g = grid
        if (history != null || g == null) return maxOffsetY(viewHeight)
        val last = g.lines.indexOfLast { !it.isEmpty }
        return min(maxOffsetY(viewHeight), max(0f, (last + 1) * cellH - viewHeight))
    }

    private fun atBottom(viewHeight: Int = height) = offsetY >= liveBottomY(viewHeight) - 1f

    /** Runs [change] (which may alter the cell height) keeping the same rows in view: the bottom stays the bottom. */
    private inline fun keepingPlace(change: () -> Unit) {
        val wasBottom = atBottom()
        val row = if (cellH > 0f) offsetY / cellH else 0f
        change()
        offsetY = if (wasBottom) liveBottomY() else row * cellH
        clampScroll()
    }

    /** Vertical range: down to the last row with content (live) or the last line (history); blank rows below are not scrollable. */
    private fun clampScroll() {
        offsetX = offsetX.coerceIn(0f, maxOffsetX())
        offsetY = offsetY.coerceIn(0f, liveBottomY())
    }

    /** Whether the window cannot move further that way, so a swipe there is for the program. */
    private fun atEdge(towardBottom: Boolean) = if (towardBottom) offsetY >= liveBottomY() - 0.5f else offsetY <= 0.5f

    // ------------------------------------------------------------ slide

    /**
     * Call before the grid is replaced by the frame [shift] describes: the new rows start [shift] rows away
     * from their final place and glide there. A slide already running is extended, so frames arriving every
     * 60–80 ms during a scroll become one continuous motion; the duration follows the gap between such frames.
     */
    private fun beginSlide(shift: RowShift, old: TerminalGrid) {
        val m = min(shift.movingRows, old.rows)
        if (cellH <= 0f || m <= 0 || shift.shift == 0) return
        val k = min(abs(shift.shift), m)
        if (shift.shift > 0) {
            val gone = old.lines.copyOfRange(0, k).toList()
            leaving = (if (leavingAbove && slideOffset > 0f) leaving else emptyList()) + gone
            leavingAbove = true
            slideOffset = max(0f, slideOffset) + k * cellH
        } else {
            val gone = old.lines.copyOfRange(m - k, m).toList()
            leaving = gone + (if (!leavingAbove && slideOffset < 0f) leaving else emptyList())
            leavingAbove = false
            slideOffset = min(0f, slideOffset) - k * cellH
        }
        if (leaving.size > m) leaving = if (leavingAbove) leaving.takeLast(m) else leaving.take(m)
        slideMovingRows = m
        val now = SystemClock.uptimeMillis()
        val since = if (lastShiftAt == 0L) 150L else (now - lastShiftAt).coerceIn(50L, 150L)
        lastShiftAt = now
        slideVelocity = abs(slideOffset) * 1000f / since
        if (lastSlideFrame == 0L) {
            lastSlideFrame = now
            postOnAnimation(slideTick)
        }
        invalidate()
    }

    private val slideTick = object : Runnable {
        override fun run() {
            val now = SystemClock.uptimeMillis()
            val dt = (now - lastSlideFrame).coerceIn(1L, 100L)
            lastSlideFrame = now
            val step = slideVelocity * dt / 1000f
            if (abs(slideOffset) <= step) {
                endSlide()
            } else {
                slideOffset -= step * sign(slideOffset)
                postOnAnimation(this)
            }
            invalidate()
        }
    }

    private fun endSlide() {
        removeCallbacks(slideTick)
        lastSlideFrame = 0L
        if (slideOffset == 0f && leaving.isEmpty()) return
        slideOffset = 0f
        leaving = emptyList()
        invalidate()
    }

    // ------------------------------------------------------------ drawing

    override fun onDraw(canvas: Canvas) {
        canvas.drawColor(TerminalColors.DEFAULT_BG)
        val rs = rows
        if (rs.isEmpty() || cellH <= 0f) return
        val first = (offsetY / cellH).toInt().coerceIn(0, rs.size - 1)
        val last = ((offsetY + height) / cellH).toInt().coerceIn(first, rs.size - 1)
        val firstCol = (offsetX / cellW).toInt().coerceAtLeast(0)
        val lastCol = ((offsetX + width) / cellW).toInt() + 1
        val table = styles
        if (slideOffset != 0f && slideMovingRows > 0 && history == null) {
            // The moving region (rows 0 until m) is drawn displaced by slideOffset and clipped to its own box, with
            // the rows that scrolled out still showing next to it; the rows below it stay put.
            val m = min(slideMovingRows, rs.size)
            for (y in max(first, m)..last) drawRow(canvas, rs[y], y * cellH - offsetY, firstCol, lastCol, table)
            canvas.save()
            canvas.clipRect(0f, -offsetY, width.toFloat(), m * cellH - offsetY)
            for (y in 0 until m) {
                val top = y * cellH - offsetY + slideOffset
                if (top + cellH >= 0f && top <= height) drawRow(canvas, rs[y], top, firstCol, lastCol, table)
            }
            for ((i, row) in leaving.withIndex()) {
                val top = (if (leavingAbove) (i - leaving.size) * cellH else (m + i) * cellH) - offsetY + slideOffset
                if (top + cellH >= 0f && top <= height) drawRow(canvas, row, top, firstCol, lastCol, table)
            }
            canvas.restore()
            return
        }
        for (y in first..last) drawRow(canvas, rs[y], y * cellH - offsetY, firstCol, lastCol, table)
        selection?.let { drawSelection(canvas, it, first, last) }
    }

    private fun drawSelection(canvas: Canvas, s: Selection, first: Int, last: Int) {
        val start = s.start
        val end = s.end
        val lo = max(first, start.row)
        val hi = min(last, end.row)
        if (lo > hi) return
        val rs = rows
        for (y in lo..hi) {
            val c0 = if (y == start.row) start.col else 0
            val c1 = if (y == end.row) end.col else rs[y].cols - 1
            canvas.drawRect(c0 * cellW - offsetX, y * cellH - offsetY, (c1 + 1) * cellW - offsetX, (y + 1) * cellH - offsetY, selectionPaint)
        }
    }

    private fun drawRow(canvas: Canvas, row: Row, top: Float, firstCol: Int, lastCol: Int, table: StyleTable?) {
        val cells = row.cells
        if (cells.isEmpty()) return
        var x = firstCol.coerceAtMost(cells.size - 1)
        if (x > 0 && cells[x] === Cell.CONTINUATION) x--
        val end = min(lastCol, cells.size - 1)
        while (x <= end) {
            val cell = cells[x]
            if (cell.width == 0) { x++; continue }
            val styleId = cell.styleId
            val style = if (styleId == 0) Style.DEFAULT else table?.get(styleId) ?: Style.DEFAULT
            var runEnd = x
            if (cell.width == 1) {
                while (runEnd + 1 <= end && cells[runEnd + 1].width == 1 && cells[runEnd + 1].styleId == styleId) runEnd++
            }
            val widthCells = if (cell.width == 2) 2 else runEnd - x + 1
            val left = x * cellW - offsetX
            val fg0 = TerminalColors.resolve(style.fg, TerminalColors.DEFAULT_FG)
            val bg0 = TerminalColors.resolve(style.bg, TerminalColors.DEFAULT_BG)
            val fg = if (style.inverse) bg0 else fg0
            val bg = if (style.inverse) fg0 else bg0
            if (bg != TerminalColors.DEFAULT_BG) {
                bgPaint.color = bg
                canvas.drawRect(left, top, left + widthCells * cellW, top + cellH, bgPaint)
            }
            if (styleId != 0 || cell.width == 2 || hasInk(cells, x, runEnd)) {
                textPaint.color = fg
                textPaint.alpha = if (style.dim) 150 else 255
                textPaint.typeface = if (style.bold) bold else regular
                textPaint.textSkewX = if (style.italic) -0.2f else 0f
                textPaint.isUnderlineText = style.underline
                textPaint.isStrikeThruText = style.strikethrough
                drawText(canvas, cells, x, runEnd, cell.width == 2, left, top + baseline)
            }
            x = runEnd + 1
        }
    }

    private fun hasInk(cells: Array<Cell>, from: Int, to: Int): Boolean {
        for (i in from..to) if (cells[i].text != " ") return true
        return false
    }

    /** ASCII runs draw in one call; anything else cell by cell so fallback-font glyphs stay on the grid. */
    private fun drawText(canvas: Canvas, cells: Array<Cell>, from: Int, to: Int, wide: Boolean, left: Float, y: Float) {
        if (wide) {
            val t = cells[from].text
            val w = textPaint.measureText(t)
            canvas.drawText(t, left + (2 * cellW - w) / 2f, y, textPaint)
            return
        }
        var ascii = true
        for (i in from..to) {
            val t = cells[i].text
            if (t.length != 1 || t[0] < ' ' || t[0] > '~') { ascii = false; break }
        }
        if (ascii) {
            val sb = StringBuilder(to - from + 1)
            for (i in from..to) sb.append(cells[i].text)
            canvas.drawText(sb.toString(), left, y, textPaint)
        } else {
            for (i in from..to) {
                val t = cells[i].text
                if (t == " " || t.isEmpty()) continue
                val w = textPaint.measureText(t)
                canvas.drawText(t, left + (i - from) * cellW + (cellW - w) / 2f, y, textPaint)
            }
        }
    }

    // ------------------------------------------------------------ gestures

    private val gestures = GestureDetector(context, object : GestureDetector.SimpleOnGestureListener() {
        override fun onDown(e: MotionEvent): Boolean {
            scroller.forceFinished(true)
            flingHandoff = false
            cancelInertia() // the finger grabbed the content
            pullUp = 0f
            pullDown = 0f
            clearSelection()
            return true
        }

        override fun onSingleTapUp(e: MotionEvent): Boolean {
            onTap?.invoke()
            return true
        }

        override fun onScroll(e1: MotionEvent?, e2: MotionEvent, distanceX: Float, distanceY: Float): Boolean {
            offsetX += distanceX
            val before = offsetY
            offsetY += distanceY
            clampScroll()
            if (forwardScroll) {
                // The window over the live screen moves first; what it could not take at its edge goes to the program.
                // Finger up (distanceY > 0) = content should move up = wheel down, one step per cell height.
                val spare = distanceY - (offsetY - before)
                if (spare == 0f) {
                    scrollAcc = 0f
                } else {
                    scrollAcc += spare
                    val steps = (scrollAcc / cellH).toInt()
                    if (steps != 0) {
                        scrollAcc -= steps * cellH
                        queueScroll(steps, e2)
                    }
                }
                invalidate()
                return true
            }
            when {
                distanceY < 0 && before <= 0f -> {
                    pullUp -= distanceY
                    if (pullUp > cellH * 2) {
                        pullUp = 0f
                        if (history == null) onScrollback?.invoke() else onReachTop?.invoke()
                    }
                }
                history != null && distanceY < 0 && offsetY < cellH * 6 -> onReachTop?.invoke()
                history != null && distanceY > 0 && before >= maxOffsetY() -> {
                    pullDown += distanceY
                    if (pullDown > cellH * 3) {
                        pullDown = 0f
                        onPullBottom?.invoke()
                    }
                }
            }
            invalidate()
            return true
        }

        override fun onFling(e1: MotionEvent?, e2: MotionEvent, velocityX: Float, velocityY: Float): Boolean {
            val towardBottom = velocityY < 0 // finger up → content moves up
            if (forwardScroll && atEdge(towardBottom)) {
                // Released against an edge: the whole fling is for the program (finger up → wheel down, positive steps).
                flingMovesY = false
                scroller.fling(offsetX.toInt(), 0, -velocityX.toInt(), 0, 0, maxOffsetX().toInt(), 0, 0)
                startInertia(-velocityY / cellH, e2.x, e2.y)
            } else {
                // The window flings; in forwarding mode what is left when it reaches the edge continues as wheel steps.
                flingMovesY = true
                flingHandoff = forwardScroll && history == null
                flingDown = towardBottom
                flingX = e2.x
                flingY = e2.y
                scroller.fling(offsetX.toInt(), offsetY.toInt(), -velocityX.toInt(), -velocityY.toInt(), 0, maxOffsetX().toInt(), 0, liveBottomY().toInt())
            }
            postInvalidateOnAnimation()
            return true
        }

        override fun onLongPress(e: MotionEvent) {
            // Select the word under the finger; keeping the finger down and moving extends the selection.
            val p = cellAt(e.x, e.y) ?: return
            val word = rows.wordAt(p) ?: return
            actionMode?.finish()
            selection = word
            draggingEnd = 2
            performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
            invalidate()
        }
    })

    // ------------------------------------------------------------ selection

    private fun cellAt(x: Float, y: Float): GridPosition? {
        val rs = rows
        if (rs.isEmpty() || cellW <= 0f || cellH <= 0f) return null
        val row = ((y + offsetY) / cellH).toInt()
        if (row < 0 || row >= rs.size) return null
        val cols = rs[row].cols
        if (cols == 0) return null
        return GridPosition(row, ((x + offsetX) / cellW).toInt().coerceIn(0, cols - 1))
    }

    private fun cellCenter(p: GridPosition) = PointF((p.col + 0.5f) * cellW - offsetX, (p.row + 0.5f) * cellH - offsetY)

    /** 2 / 1 when (x, y) is within a finger of the selection's focus / anchor cell, else 0. */
    private fun handleNear(x: Float, y: Float, s: Selection): Int {
        val radius = max(cellH * 1.5f, sp(20f))
        fun near(p: GridPosition): Boolean {
            val c = cellCenter(p)
            return abs(c.x - x) <= radius && abs(c.y - y) <= radius
        }
        return when {
            near(s.focus) -> 2
            near(s.anchor) -> 1
            else -> 0
        }
    }

    private fun moveSelectionEnd(p: GridPosition) {
        val s = selection ?: return
        val next = if (draggingEnd == 1) s.copy(anchor = p) else s.copy(focus = p)
        if (next != s) {
            selection = next
            invalidate()
        }
    }

    private fun clearSelection() {
        if (selection == null) return
        selection = null
        actionMode?.finish()
        invalidate()
    }

    private fun selectionRect(s: Selection): Rect {
        val start = s.start
        val end = s.end
        val single = start.row == end.row
        val left = if (single) start.col * cellW - offsetX else -offsetX
        val right = if (single) (end.col + 1) * cellW - offsetX else cols * cellW - offsetX
        return Rect(left.toInt(), (start.row * cellH - offsetY).toInt(), right.toInt(), ((end.row + 1) * cellH - offsetY).toInt())
    }

    private fun copySelection() {
        val s = selection ?: return
        val text = rows.selectionText(s.anchor, s.focus)
        context.getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("terminal", text))
        // Android 13+ shows its own clipboard confirmation; below that the screen's toast says "copied".
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) onCopied?.invoke()
        clearSelection()
    }

    private fun selectAll() {
        val rs = rows
        if (rs.isEmpty()) return
        selection = Selection(GridPosition(0, 0), GridPosition(rs.size - 1, (rs.last().cols - 1).coerceAtLeast(0)))
        invalidate()
    }

    /** Floating Copy / Select all toolbar next to the selection (the platform's text-selection toolbar). */
    private fun showSelectionMenu() {
        actionMode?.finish()
        actionMode = startActionMode(object : ActionMode.Callback2() {
            override fun onCreateActionMode(mode: ActionMode, menu: Menu): Boolean {
                menu.add(Menu.NONE, MENU_COPY, 0, android.R.string.copy)
                menu.add(Menu.NONE, MENU_SELECT_ALL, 1, android.R.string.selectAll)
                return true
            }

            override fun onPrepareActionMode(mode: ActionMode, menu: Menu) = false

            override fun onActionItemClicked(mode: ActionMode, item: MenuItem): Boolean {
                when (item.itemId) {
                    MENU_COPY -> copySelection()
                    MENU_SELECT_ALL -> {
                        selectAll()
                        mode.invalidateContentRect()
                    }
                }
                return true
            }

            override fun onDestroyActionMode(mode: ActionMode) {
                if (actionMode === mode) actionMode = null
            }

            override fun onGetContentRect(mode: ActionMode, view: View, outRect: Rect) {
                val s = selection
                if (s != null) outRect.set(selectionRect(s)) else outRect.set(0, 0, width, height)
            }
        }, ActionMode.TYPE_FLOATING)
    }

    /**
     * The desktop program has no inertia of its own, so a fling keeps sending wheel steps at a decaying rate
     * (about 0.6 s, at most a screenful) instead of dumping one burst at the finger's release.
     */
    private fun startInertia(linesPerSecond: Float, x: Float, y: Float) {
        cancelInertia()
        val speed = min(abs(linesPerSecond), 120f)
        if (speed < 8f) return
        inertiaSpeed = speed
        inertiaDir = if (linesPerSecond < 0f) -1 else 1
        inertiaCarry = 0f
        inertiaSent = 0
        inertiaX = x
        inertiaY = y
        lastForwardedAt = SystemClock.uptimeMillis()
        postDelayed(inertiaTick, 40)
    }

    private val inertiaTick = object : Runnable {
        override fun run() {
            if (!forwardScroll || inertiaSpeed < 6f || inertiaSent >= 40) return
            inertiaCarry += inertiaSpeed * 0.04f
            val n = inertiaCarry.toInt()
            if (n > 0) {
                inertiaCarry -= n
                inertiaSent += n
                queueScroll(inertiaDir * n, inertiaX, inertiaY)
            }
            inertiaSpeed *= 0.82f
            postDelayed(this, 40)
        }
    }

    private fun cancelInertia() {
        removeCallbacks(inertiaTick)
        inertiaSpeed = 0f
    }

    /** Coalesce forwarded steps so a fast swipe is a few `scroll` requests, not one per touch sample. */
    private fun queueScroll(steps: Int, at: MotionEvent) = queueScroll(steps, at.x, at.y)

    private fun queueScroll(steps: Int, x: Float, y: Float) {
        pendingLines += steps
        pendingCol = ((x + offsetX) / cellW).toInt().coerceAtLeast(0) + 1
        pendingRow = ((y + offsetY) / cellH).toInt().coerceAtLeast(0) + 1
        if (!flushPosted) {
            flushPosted = true
            postDelayed(flushScroll, 40)
        }
    }

    private val flushScroll = Runnable {
        flushPosted = false
        val n = pendingLines
        pendingLines = 0
        if (n != 0) {
            lastForwardedAt = SystemClock.uptimeMillis()
            onScrollLines?.invoke(if (n > 0) "down" else "up", abs(n).coerceAtMost(50), pendingCol, pendingRow)
        }
    }

    override fun onDetachedFromWindow() {
        removeCallbacks(flushScroll)
        flushPosted = false
        cancelInertia()
        removeCallbacks(slideTick)
        lastSlideFrame = 0L
        super.onDetachedFromWindow()
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                // Touching a selection end grabs it (no scroll); anything else is an ordinary gesture.
                val grab = selection?.let { handleNear(event.x, event.y, it) } ?: 0
                detectorSawDown = grab == 0
                if (grab != 0) {
                    draggingEnd = grab
                    actionMode?.finish()
                    return true
                }
            }
            MotionEvent.ACTION_MOVE -> if (draggingEnd != 0) {
                cellAt(event.x, event.y)?.let { moveSelectionEnd(it) }
                return true
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> if (draggingEnd != 0) {
                draggingEnd = 0
                if (detectorSawDown) gestures.onTouchEvent(event) // let the long-press gesture finish cleanly
                if (selection != null && event.actionMasked == MotionEvent.ACTION_UP) showSelectionMenu()
                return true
            }
        }
        gestures.onTouchEvent(event)
        if (event.actionMasked == MotionEvent.ACTION_UP) performClick()
        return true
    }

    override fun performClick(): Boolean {
        super.performClick()
        return true
    }

    override fun computeScroll() {
        if (!scroller.computeScrollOffset()) return
        offsetX = scroller.currX.toFloat()
        // A fling released against an edge in forwarding mode only moves X (Y was started at 0..0); taking Y from the
        // scroller then showed the top of herdr's taller grid and hid the last rows until re-watch.
        if (flingMovesY) offsetY = scroller.currY.toFloat()
        clampScroll()
        if (flingHandoff && atEdge(flingDown)) {
            // The window reached the edge of the live screen with speed left: the rest of the fling goes to the program.
            val linesPerSecond = scroller.currVelocity / cellH
            scroller.forceFinished(true)
            flingHandoff = false
            startInertia(if (flingDown) linesPerSecond else -linesPerSecond, flingX, flingY)
        }
        postInvalidateOnAnimation()
    }

    companion object {
        private const val MENU_COPY = 1
        private const val MENU_SELECT_ALL = 2
        private const val SELECTION_COLOR = 0x597AA2F7.toInt() // DESIGN.md `selection`: interactive at 35 %
        /** Persisted sizes are multipliers of this (kept so saved values from earlier builds still mean the same). */
        const val BASE_SP = 14f
        /** Default in fit mode: the phone's body text size (sp already follows the system font-size setting). */
        const val DEFAULT_SP = 16f
        const val MIN_FONT_SP = 5f
        const val MAX_FONT_SP = 32f
        const val MIN_SP = 7f
        const val MAX_AUTO_SP = 16f
        const val FIT_DEFAULT_SCALE = DEFAULT_SP / BASE_SP
        const val MIN_SCALE = MIN_FONT_SP / BASE_SP
        const val MAX_SCALE = MAX_FONT_SP / BASE_SP
        /** A frame this soon after a forwarded scroll step may slide into place. */
        private const val SLIDE_WINDOW_MS = 1200L
    }
}

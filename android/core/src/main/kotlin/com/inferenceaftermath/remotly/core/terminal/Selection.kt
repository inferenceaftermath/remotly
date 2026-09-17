// Cell-range selection over rendered rows (live grid or scrollback): text extraction in reading
// order and word lookup. Pure functions so the app's touch handling stays thin and this is testable.
package com.inferenceaftermath.remotly.core.terminal

/** A cell address; ordered by row, then column (reading order). */
data class GridPosition(val row: Int, val col: Int) : Comparable<GridPosition> {
    override fun compareTo(other: GridPosition): Int =
        if (row != other.row) row.compareTo(other.row) else col.compareTo(other.col)
}

/** Inclusive, unordered pair of cells; [start] / [end] are in reading order. */
data class Selection(val anchor: GridPosition, val focus: GridPosition) {
    val start: GridPosition get() = if (anchor <= focus) anchor else focus
    val end: GridPosition get() = if (anchor <= focus) focus else anchor
}

private fun Cell.isInk() = width == 0 || (text != " " && text.isNotEmpty())

/**
 * Text of the cells from [a] to [b] inclusive (either order): full rows in between, trailing spaces
 * trimmed per row, rows joined by newlines. A position on the right half of a wide character selects
 * the whole character.
 */
fun List<Row>.selectionText(a: GridPosition, b: GridPosition): String {
    if (isEmpty()) return ""
    val (start, end) = if (a <= b) clamp(a) to clamp(b) else clamp(b) to clamp(a)
    return (start.row..end.row).joinToString("\n") { y ->
        val cells = this[y].cells
        if (cells.isEmpty()) return@joinToString ""
        var from = (if (y == start.row) start.col else 0).coerceIn(0, cells.size - 1)
        val to = (if (y == end.row) end.col else cells.size - 1).coerceIn(from, cells.size - 1)
        if (from > 0 && cells[from].width == 0) from--
        val sb = StringBuilder()
        for (x in from..to) if (cells[x].width > 0) sb.append(cells[x].text)
        sb.toString().trimEnd(' ')
    }
}

/** The whitespace-delimited word around [p] (a blank cell selects just itself); null off the grid. */
fun List<Row>.wordAt(p: GridPosition): Selection? {
    val cells = getOrNull(p.row)?.cells ?: return null
    if (p.col < 0 || p.col >= cells.size) return null
    if (!cells[p.col].isInk()) return Selection(p, p)
    var from = p.col
    while (from > 0 && cells[from - 1].isInk()) from--
    var to = p.col
    while (to + 1 < cells.size && cells[to + 1].isInk()) to++
    return Selection(GridPosition(p.row, from), GridPosition(p.row, to))
}

private fun List<Row>.clamp(p: GridPosition): GridPosition {
    val row = p.row.coerceIn(0, size - 1)
    val cols = this[row].cells.size
    return GridPosition(row, if (cols == 0) 0 else p.col.coerceIn(0, cols - 1))
}

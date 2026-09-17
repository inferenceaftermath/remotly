// Recognises a frame that is the previous screen scrolled by whole rows: an alternate-screen program
// (Claude Code, less, vim) redrawing after a wheel report. The terminal view then slides the picture
// into place instead of jumping. Only the rows above the program's fixed chrome (input box, status
// line) move, so the match reports where it stops (`movingRows`).
package com.inferenceaftermath.remotly.core.terminal

/**
 * @property shift rows the content moved: positive = up (new row r shows what old row r+shift showed), negative = down.
 * @property movingRows the top `movingRows` rows took part; the rows below stayed where they were.
 */
data class RowShift(val shift: Int, val movingRows: Int)

object RowShiftDetector {
    /**
     * The shift that explains most of the change from [old] to [new], or null when the frame is not a scroll
     * (same size required; at least three inked rows must line up, of at least two different kinds, and the
     * moving region must have changed at all).
     */
    fun detect(old: TerminalGrid, new: TerminalGrid): RowShift? {
        val rows = new.rows
        if (rows < 4 || old.rows != rows || old.cols != new.cols) return null
        val oldHash = IntArray(rows) { old.lines[it].contentHash() }
        val newHash = IntArray(rows) { new.lines[it].contentHash() }
        if (oldHash.contentEquals(newHash)) return null
        val blank = BooleanArray(rows) { new.lines[it].isEmpty || new.lines[it].cells.all { c -> c.isBlank } }
        var bestShift = 0
        var bestMoving = 0
        var bestInked = -1
        for (k in 1..(rows - 3)) {
            for (sign in intArrayOf(1, -1)) {
                // Content moved up by k: new[r] == old[r + k]; down: new[r] == old[r - k].
                val range = if (sign > 0) 0 until (rows - k) else k until rows
                var matched = 0
                var inked = 0
                var last = -1
                val kinds = HashSet<Int>()
                for (r in range) {
                    if (newHash[r] != oldHash[r + k * sign]) continue
                    matched++
                    last = r
                    if (!blank[r]) {
                        inked++
                        kinds.add(newHash[r])
                    }
                }
                var moving = last + 1
                val overlap = if (sign > 0) moving else moving - k
                if (inked < 3 || kinds.size < 2 || overlap < 3 || matched * 5 < overlap * 3) continue
                if (sign > 0) {
                    // The (changed) rows right below the matched run scrolled in from under the region's bottom edge.
                    var extra = 0
                    while (extra < k && moving < rows && newHash[moving] != oldHash[moving]) {
                        moving++
                        extra++
                    }
                }
                if ((0 until moving).none { newHash[it] != oldHash[it] }) continue // nothing scrolled
                if (inked > bestInked) { // ties: the smaller shift (k ascends)
                    bestInked = inked
                    bestShift = k * sign
                    bestMoving = moving
                }
            }
        }
        return if (bestInked < 0) null else RowShift(bestShift, bestMoving)
    }

    private fun Row.contentHash(): Int {
        var h = cells.size
        for (c in cells) h = h * 31 + (c.text.hashCode() * 31 + c.width) * 31 + c.styleId
        return h
    }
}

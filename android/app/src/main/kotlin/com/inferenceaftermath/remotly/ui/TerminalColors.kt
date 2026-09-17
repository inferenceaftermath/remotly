package com.inferenceaftermath.remotly.ui

/** Resolves protocol colour specs ("d", "p<n>", "#rrggbb") to ARGB ints. */
object TerminalColors {
    // DESIGN.md §1: default foreground `fg`, background `bg` (the terminal is flush with the screen).
    val DEFAULT_FG: Int = 0xFFE0E2E5.toInt()
    val DEFAULT_BG: Int = 0xFF0B0C0E.toInt()

    /** ANSI 0–15 from DESIGN.md §1 (shared with iOS and the site). */
    private val ansi16 = intArrayOf(
        0xFF1B2230.toInt(), 0xFFF7768E.toInt(), 0xFF9ECE6A.toInt(), 0xFFE0AF68.toInt(),
        0xFF7AA2F7.toInt(), 0xFFBB9AF7.toInt(), 0xFF7DCFFF.toInt(), 0xFFA9B1D6.toInt(),
        0xFF414868.toInt(), 0xFFF7768E.toInt(), 0xFF9ECE6A.toInt(), 0xFFE0AF68.toInt(),
        0xFF7AA2F7.toInt(), 0xFFBB9AF7.toInt(), 0xFF7DCFFF.toInt(), 0xFFC0CAF5.toInt(),
    )
    private val cache = HashMap<String, Int>()

    fun resolve(spec: String, default: Int): Int {
        if (spec.isEmpty() || spec == "d") return default
        cache[spec]?.let { return it }
        val c = when (spec[0]) {
            '#' -> parseHex(spec) ?: default
            'p' -> spec.substring(1).toIntOrNull()?.let(::palette) ?: default
            else -> default
        }
        cache[spec] = c
        return c
    }

    fun palette(n: Int): Int = when {
        n < 0 -> DEFAULT_FG
        n < 16 -> ansi16[n]
        n < 232 -> {
            val i = n - 16
            rgb(level(i / 36), level((i / 6) % 6), level(i % 6))
        }
        n < 256 -> {
            val v = 8 + (n - 232) * 10
            rgb(v, v, v)
        }
        else -> DEFAULT_FG
    }

    private fun level(x: Int) = if (x == 0) 0 else 55 + x * 40

    private fun rgb(r: Int, g: Int, b: Int): Int = (0xFF shl 24) or (r shl 16) or (g shl 8) or b

    private fun parseHex(s: String): Int? {
        if (s.length != 7) return null
        val v = s.substring(1).toLongOrNull(16) ?: return null
        return (0xFF000000L or v).toInt()
    }
}

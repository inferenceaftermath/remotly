package com.inferenceaftermath.remotly.ui

import androidx.compose.ui.graphics.toArgb
import com.inferenceaftermath.remotly.core.terminal.Contrast

/**
 * Resolves protocol colour specs ("d", "p<n>", "#rrggbb") to ARGB ints under one theme (DESIGN.md §1): the terminal is
 * flush on the theme's `bg` with text in `fg`, ANSI 0–15 come from the theme, and text is lifted to the theme's contrast
 * floor. One instance per [Palette] ([Palette.terminal]); main thread only.
 */
class TerminalColors(palette: Palette) {
    val defaultFg: Int = palette.fg.toArgb()
    val defaultBg: Int = palette.bg.toArgb()
    /** Text selection: `interactive` at 35 %. */
    val selection: Int = palette.interactive.copy(alpha = 0.35f).toArgb()

    private val ansi16 = IntArray(16) { 0xFF000000.toInt() or palette.ansi[it] }
    private val minimumContrast = palette.minimumContrast
    private val cache = HashMap<String, Int>()
    /** Text colour after the contrast floor, per (foreground, background) pair. */
    private val readableCache = HashMap<Long, Int>()

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
        n < 0 -> defaultFg
        n < 16 -> ansi16[n]
        n < 232 -> {
            val i = n - 16
            rgb(level(i / 36), level((i / 6) % 6), level(i % 6))
        }
        n < 256 -> {
            val v = 8 + (n - 232) * 10
            rgb(v, v, v)
        }
        else -> defaultFg
    }

    /** [fg] lifted to the theme's contrast floor against [bg] (unchanged when the theme has none). */
    fun readable(fg: Int, bg: Int): Int {
        if (minimumContrast <= 1.0) return fg
        val key = (fg.toLong() shl 32) or (bg.toLong() and 0xFFFFFFFFL)
        readableCache[key]?.let { return it }
        if (readableCache.size > 4096) readableCache.clear()
        val out = Contrast.readable(fg, bg, minimumContrast)
        readableCache[key] = out
        return out
    }

    private fun level(x: Int) = if (x == 0) 0 else 55 + x * 40

    private fun rgb(r: Int, g: Int, b: Int): Int = (0xFF shl 24) or (r shl 16) or (g shl 8) or b

    private fun parseHex(s: String): Int? {
        if (s.length != 7) return null
        val v = s.substring(1).toLongOrNull(16) ?: return null
        return (0xFF000000L or v).toInt()
    }
}

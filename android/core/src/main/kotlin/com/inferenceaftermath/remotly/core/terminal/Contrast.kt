// WCAG 2 contrast between terminal colours, and the nudge that keeps text readable on a theme it was not written for:
// a program on the desktop picks its colours for a dark background, so its white or pale text on the Light theme is
// darkened until it reads (shared/design/DESIGN.md §1). The iOS twin is FlowKit `Contrast`.
package com.inferenceaftermath.remotly.core.terminal

import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.roundToInt

object Contrast {
    /** Relative luminance of an (A)RGB int, 0 for black to 1 for white; alpha is ignored. */
    fun luminance(rgb: Int): Double {
        fun channel(v: Int): Double {
            val s = v / 255.0
            return if (s <= 0.04045) s / 12.92 else ((s + 0.055) / 1.055).pow(2.4)
        }
        return 0.2126 * channel((rgb shr 16) and 0xFF) + 0.7152 * channel((rgb shr 8) and 0xFF) + 0.0722 * channel(rgb and 0xFF)
    }

    /** Contrast ratio of two colours, 1 (the same) to 21 (black on white). */
    fun ratio(a: Int, b: Int): Double {
        val la = luminance(a)
        val lb = luminance(b)
        return (max(la, lb) + 0.05) / (min(la, lb) + 0.05)
    }

    /**
     * [fg] itself when it reaches [minimum] against [bg]; otherwise [fg] mixed toward black (on a background lighter than
     * the middle grey) or white (on a darker one) in tenths until it does, black or white at most. The result is opaque
     * with [fg]'s colour channels; a [minimum] of 1 or less returns [fg].
     */
    fun readable(fg: Int, bg: Int, minimum: Double): Int {
        if (minimum <= 1.0 || ratio(fg, bg) >= minimum) return fg
        // 0.179 is the luminance at which black and white contrast equally with the background.
        val target = if (luminance(bg) > 0.179) 0.0 else 255.0
        fun mix(v: Int, t: Double): Int = (v * (1 - t) + target * t).roundToInt()
        var candidate = fg
        for (step in 1..10) {
            val t = step / 10.0
            candidate = (0xFF shl 24) or (mix((fg shr 16) and 0xFF, t) shl 16) or (mix((fg shr 8) and 0xFF, t) shl 8) or mix(fg and 0xFF, t)
            if (ratio(candidate, bg) >= minimum) return candidate
        }
        return candidate
    }
}

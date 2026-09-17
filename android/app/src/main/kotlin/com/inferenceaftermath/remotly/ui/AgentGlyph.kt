// The tool glyph of a list row (shared/design/DESIGN.md §4.3, §4.12): which tool runs in the pane, in the tool's own
// colour — Claude's spark, Codex's knot, Gemini's sparkle, pi's π, and the `>_` prompt for a plain shell or a tool
// without a glyph. Geometry on a 24-unit grid, the same numbers as the iOS `AgentGlyph`.
package com.inferenceaftermath.remotly.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

enum class AgentGlyphKind {
    SPARK, KNOT, SPARKLE, PI, TERMINAL;

    /** The tool's colour (§4.12): Claude's terracotta, OpenAI's white (`fg`), Google's blue; `fg2` for π, `fg3` for the prompt. */
    val tint: Color
        get() = when (this) {
            SPARK -> Color(0xFFD97757)
            KNOT -> Tokens.fg
            SPARKLE -> Color(0xFF4285F4)
            PI -> Tokens.fg2
            TERMINAL -> Tokens.fg3
        }

    companion object {
        /** herdr's agent id → glyph; null or empty (a plain shell) and tools without a glyph take the terminal prompt. */
        fun forAgent(agent: String?): AgentGlyphKind = when (agent?.lowercase()) {
            "claude" -> SPARK
            "codex" -> KNOT
            "gemini" -> SPARKLE
            "pi" -> PI
            else -> TERMINAL
        }
    }
}

/** The glyph in its tool's [AgentGlyphKind.tint], [size] square (16 dp in list rows). Filled spark, knot and sparkle; π and the prompt are 2.6-unit strokes with round caps and joins. */
@Composable
fun AgentGlyph(kind: AgentGlyphKind, size: Dp = 16.dp, modifier: Modifier = Modifier) {
    val color = kind.tint
    Canvas(modifier.size(size)) {
        val s = this.size.minDimension / 24f
        fun pt(x: Float, y: Float) = Offset(x * s, y * s)
        val centre = pt(12f, 12f)
        val width = 2.6f * s
        when (kind) {
            // Eight round-ended spokes, 3.4 wide, from 0.8 to 11.6 units out (they meet in a solid centre).
            AgentGlyphKind.SPARK -> repeat(8) { k ->
                rotate(k * 45f, pivot = centre) {
                    drawRoundRect(color, topLeft = pt(12f - 1.7f, 12f - 11.6f), size = Size(3.4f * s, 10.8f * s), cornerRadius = CornerRadius(1.7f * s))
                }
            }
            // Six round-ended bars, 3 wide and 11 long, each lying across a radius 5 units out: the hexagonal knot.
            AgentGlyphKind.KNOT -> repeat(6) { k ->
                rotate(k * 60f, pivot = centre) {
                    drawRoundRect(color, topLeft = pt(12f - 5.5f, 12f - 6.5f), size = Size(11f * s, 3f * s), cornerRadius = CornerRadius(1.5f * s))
                }
            }
            // Four points with sides pulled in toward the centre.
            AgentGlyphKind.SPARKLE -> drawPath(
                Path().apply {
                    moveTo(12f * s, 0.8f * s)
                    quadraticTo(13.4f * s, 10.6f * s, 23.2f * s, 12f * s)
                    quadraticTo(13.4f * s, 13.4f * s, 12f * s, 23.2f * s)
                    quadraticTo(10.6f * s, 13.4f * s, 0.8f * s, 12f * s)
                    quadraticTo(10.6f * s, 10.6f * s, 12f * s, 0.8f * s)
                    close()
                },
                color,
            )
            AgentGlyphKind.PI -> {
                drawLine(color, pt(4.5f, 6.5f), pt(19.5f, 6.5f), strokeWidth = width, cap = StrokeCap.Round)
                drawLine(color, pt(8.5f, 6.5f), pt(8.5f, 19.5f), strokeWidth = width, cap = StrokeCap.Round)
                drawLine(color, pt(15.5f, 6.5f), pt(15.5f, 19.5f), strokeWidth = width, cap = StrokeCap.Round)
            }
            AgentGlyphKind.TERMINAL -> {
                drawPath(
                    Path().apply { moveTo(5f * s, 6.5f * s); lineTo(10.5f * s, 12f * s); lineTo(5f * s, 17.5f * s) },
                    color,
                    style = Stroke(width = width, cap = StrokeCap.Round, join = StrokeJoin.Round),
                )
                drawLine(color, pt(12.5f, 17.5f), pt(19.5f, 17.5f), strokeWidth = width, cap = StrokeCap.Round)
            }
        }
    }
}

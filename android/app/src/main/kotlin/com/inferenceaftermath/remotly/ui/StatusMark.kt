// The Remotly mark as a status glyph (shared/design/DESIGN.md §4.12): the icon's chevron in the status colour and the
// teal phone, on the icon's 64-unit grid cropped to x 10–52, y 14–50 (42 × 36 units), scaled to `height`. Same geometry
// and motion as the iOS `StatusMark` / `PaneMark`.
package com.inferenceaftermath.remotly.ui

import android.database.ContentObserver
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.clipRect
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.inferenceaftermath.remotly.core.protocol.AgentStatus
import com.inferenceaftermath.remotly.core.protocol.PaneInfo
import kotlin.math.pow

/**
 * The mark: phone always `accent` with the `bg` island; the chevron in [chevron] (the status colour), shifted by
 * [chevronOffset] grid units toward the phone, at [chevronOpacity]; [trail] draws a second chevron 6 units behind at
 * 35 % (the notification / drawn-motion variant).
 */
@Composable
fun StatusMark(
    chevron: Color,
    height: Dp = 14.dp,
    chevronOffset: Float = 0f,
    chevronOpacity: Float = 1f,
    trail: Boolean = false,
    modifier: Modifier = Modifier,
) {
    Canvas(modifier.size(height * 42f / 36f, height)) {
        val s = size.height / 36f
        fun x(u: Float) = (u - 10f) * s
        fun y(u: Float) = (u - 14f) * s
        drawRoundRect(Tokens.accent, topLeft = Offset(x(35f), y(14f)), size = Size(17f * s, 36f * s), cornerRadius = CornerRadius(5.4f * s))
        drawRoundRect(Tokens.bg, topLeft = Offset(x(40.5f), y(16.6f)), size = Size(6f * s, 2.2f * s), cornerRadius = CornerRadius(1.1f * s))
        fun chevronPath(dx: Float) = Path().apply {
            moveTo(x(15.6f + dx), y(19.5f)); lineTo(x(27.4f + dx), y(32f)); lineTo(x(15.6f + dx), y(44.5f))
            lineTo(x(10.2f + dx), y(44.5f)); lineTo(x(22f + dx), y(32f)); lineTo(x(10.2f + dx), y(19.5f)); close()
        }
        clipRect {
            if (trail) drawPath(chevronPath(chevronOffset - 6f), chevron.copy(alpha = chevron.alpha * 0.35f * chevronOpacity))
            drawPath(chevronPath(chevronOffset), chevron.copy(alpha = chevron.alpha * chevronOpacity))
        }
    }
}

/**
 * A pane's mark: the chevron in the pane's status colour; while the pane is working and [animated] is on it glides
 * toward the phone in the 1.4 s loop of §4.12 (rows stay still, the pane header animates). Still when the system
 * removes animations. Labelled with the status word ("Terminal" for a plain shell).
 */
@Composable
fun PaneMark(p: PaneInfo, height: Dp = 14.dp, animated: Boolean = false, modifier: Modifier = Modifier) {
    val color = Status.color(p)
    // The status word; an agent whose status has no word (unknown) is named; "Terminal" only for a plain shell.
    val label = Status.word(p) ?: if (p.hasAgent) (agentName(p) ?: "Agent") else "Terminal"
    val reduceMotion = if (animated) rememberReduceMotion() else false
    val moving = animated && !reduceMotion && p.hasAgent && p.agent_status == AgentStatus.WORKING
    val labelled = modifier.semantics { contentDescription = label }
    if (moving) {
        val phase by rememberInfiniteTransition(label = "mark").animateFloat(
            initialValue = 0f, targetValue = 1f,
            animationSpec = infiniteRepeatable(tween(durationMillis = 1400, easing = LinearEasing)),
            label = "phase",
        )
        StatusMark(color, height, chevronOffset = markOffset(phase), chevronOpacity = markOpacity(phase), modifier = labelled)
    } else {
        StatusMark(color, height, modifier = labelled)
    }
}

/**
 * Whether the system removes animations (Settings › Accessibility › "Remove animations" sets the animator scale to 0),
 * observed live so a mark on screen goes still the moment the setting changes.
 */
@Composable
private fun rememberReduceMotion(): Boolean {
    val resolver = LocalContext.current.contentResolver
    fun read() = Settings.Global.getFloat(resolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f
    var reduced by remember(resolver) { mutableStateOf(read()) }
    DisposableEffect(resolver) {
        val observer = object : ContentObserver(Handler(Looper.getMainLooper())) {
            override fun onChange(selfChange: Boolean) { reduced = read() }
        }
        resolver.registerContentObserver(Settings.Global.getUriFor(Settings.Global.ANIMATOR_DURATION_SCALE), false, observer)
        onDispose { resolver.unregisterContentObserver(observer) }
    }
    return reduced
}

/** Ease-in-out from x −3 to +7 grid units over the loop (`phase` 0…1). */
fun markOffset(phase: Float): Float {
    val eased = if (phase < 0.5f) 2f * phase * phase else 1f - (-2f * phase + 2f).pow(2) / 2f
    return -3f + 10f * eased
}

/** Opaque for two thirds of the loop, then fading to 0. */
fun markOpacity(phase: Float): Float = if (phase < 2f / 3f) 1f else (1f - (phase - 2f / 3f) * 3f).coerceAtLeast(0f)

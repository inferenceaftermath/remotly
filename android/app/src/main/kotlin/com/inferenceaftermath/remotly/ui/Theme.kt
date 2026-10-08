// Design tokens, type styles and the small shared components of shared/design/DESIGN.md. Everything the screens
// draw comes from here so that iOS and Android stay identical; no Material system colours are used directly.
package com.inferenceaftermath.remotly.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.State
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import com.inferenceaftermath.remotly.R
import com.inferenceaftermath.remotly.core.connection.ConnectionState
import com.inferenceaftermath.remotly.core.protocol.AgentStatus
import com.inferenceaftermath.remotly.core.protocol.PaneInfo
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.inferenceaftermath.remotly.session.Notice
import com.inferenceaftermath.remotly.session.Session
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive

/** DESIGN.md §1: the selected theme's colours. */
object Tokens {
    /**
     * The selected theme's palette. Snapshot state: everything composed or drawn from a token follows a theme change at
     * once. Set from the stored choice by [MainActivity][com.inferenceaftermath.remotly.MainActivity].
     */
    var palette: Palette by mutableStateOf(Palette.DARK)
        private set

    fun use(choice: ThemeChoice) {
        palette = choice.palette
    }

    val bg: Color get() = palette.bg
    val panel: Color get() = palette.panel
    val panel2: Color get() = palette.panel2
    val line: Color get() = palette.line
    val separator: Color get() = palette.separator
    val pillBg: Color get() = palette.pillBg
    val raised: Color get() = palette.raised
    val fg: Color get() = palette.fg
    val fg2: Color get() = palette.fg2
    val fg3: Color get() = palette.fg3
    val titleFg: Color get() = palette.titleFg
    val accent: Color get() = palette.accent
    val accentWash: Color get() = palette.accent.copy(alpha = 0.08f)
    val interactive: Color get() = palette.interactive
    val onInteractive: Color get() = palette.onInteractive
    val blocked: Color get() = palette.blocked
    val working: Color get() = palette.working
    val idle: Color get() = palette.idle
    val done: Color get() = palette.done
    /** Toast fill; the ok variant fills with [done]. [toastFg] is the text on both. */
    val toastBg: Color get() = palette.toastBg
    val toastFg: Color get() = palette.toastFg
    val selection: Color get() = palette.interactive.copy(alpha = 0.35f)
    val whiteWash = Color(0x24FFFFFF)
}

/** The themes Settings › Appearance offers (DESIGN.md §1). Dark is the default; Light reads best in sunlight. */
enum class ThemeChoice(val key: String, val title: String) {
    DARK("dark", "Dark"),
    LIGHT("light", "Light"),
    CATPPUCCIN_MOCHA("catppuccin-mocha", "Catppuccin Mocha");

    val palette: Palette get() = when (this) {
        DARK -> Palette.DARK
        LIGHT -> Palette.LIGHT
        CATPPUCCIN_MOCHA -> Palette.CATPPUCCIN_MOCHA
    }

    companion object {
        /** The stored key's theme; Dark for none or an unknown one. */
        fun of(key: String?): ThemeChoice = entries.firstOrNull { it.key == key } ?: DARK
    }
}

/**
 * One theme's colours: every token of DESIGN.md §1, the terminal's ANSI 0–15 (0xRRGGBB) and the contrast floor terminal
 * text is lifted to (1 = colours as the program sent them). The same values as iOS `Palette`.
 */
class Palette(
    val isLight: Boolean,
    val bg: Color, val panel: Color, val panel2: Color, val line: Color, val separator: Color, val pillBg: Color,
    val raised: Color, val fg: Color, val fg2: Color, val fg3: Color, val titleFg: Color, val accent: Color,
    val interactive: Color, val onInteractive: Color, val blocked: Color, val working: Color, val idle: Color,
    val done: Color, val toastBg: Color, val toastFg: Color,
    val ansi: IntArray,
    val minimumContrast: Double,
) {
    /** The terminal's colour resolver for this theme (one per palette, so the view can tell a change by identity). */
    val terminal: TerminalColors by lazy { TerminalColors(this) }

    companion object {
        /** The original look (Tokyo Night-derived, matched to the status colours). */
        val DARK = Palette(
            isLight = false,
            bg = Color(0xFF0B0C0E), panel = Color(0xFF141618), panel2 = Color(0xFF1B1E22), line = Color(0xFF262A2F),
            separator = Color(0xFF20242A), pillBg = Color(0xFF191C20), raised = Color(0xFF2E3238), fg = Color(0xFFE0E2E5),
            fg2 = Color(0xFFB4B9C0), fg3 = Color(0xFF6E737B), titleFg = Color(0xFFD5D8DD), accent = Color(0xFF2DD4BF),
            interactive = Color(0xFF7AA2F7), onInteractive = Color(0xFF0B0C0E), blocked = Color(0xFFF7768E),
            working = Color(0xFFE0AF68), idle = Color(0xFF7AA2F7), done = Color(0xFF9ECE6A), toastBg = Color(0xFFE0E2E5),
            toastFg = Color(0xFF0B0C0E),
            ansi = intArrayOf(
                0x1B2230, 0xF7768E, 0x9ECE6A, 0xE0AF68, 0x7AA2F7, 0xBB9AF7, 0x7DCFFF, 0xA9B1D6,
                0x414868, 0xF7768E, 0x9ECE6A, 0xE0AF68, 0x7AA2F7, 0xBB9AF7, 0x7DCFFF, 0xC0CAF5,
            ),
            minimumContrast = 1.0,
        )

        /**
         * White screen, near-black text, every colour at least 4.2 : 1 on its surface, for reading in sunlight. Programs on
         * the desktop usually pick their colours for a dark background, so terminal text is lifted to 4.5 : 1.
         */
        val LIGHT = Palette(
            isLight = true,
            bg = Color(0xFFFFFFFF), panel = Color(0xFFF3F4F6), panel2 = Color(0xFFE9EBEF), line = Color(0xFFD0D5DC),
            separator = Color(0xFFE4E7EB), pillBg = Color(0xFFF3F4F6), raised = Color(0xFFC3C9D1), fg = Color(0xFF16181D),
            fg2 = Color(0xFF424852), fg3 = Color(0xFF676E79), titleFg = Color(0xFF1F2329), accent = Color(0xFF0F766E),
            interactive = Color(0xFF2563EB), onInteractive = Color(0xFFFFFFFF), blocked = Color(0xFFC7254E),
            working = Color(0xFFB45309), idle = Color(0xFF2563EB), done = Color(0xFF1A7F37), toastBg = Color(0xFF16181D),
            toastFg = Color(0xFFFFFFFF),
            ansi = intArrayOf(
                0x24292F, 0xC7254E, 0x1A7F37, 0x9A6700, 0x2563EB, 0x8250DF, 0x0E7490, 0x6E7781,
                0x57606A, 0xA40E26, 0x116329, 0x7D4E00, 0x1D4ED8, 0x6639BA, 0x155E75, 0x8C959F,
            ),
            minimumContrast = 4.5,
        )

        /**
         * Catppuccin Mocha (catppuccin.com/palette): Base screen, Mantle cards, Surface 0–2 for caps and borders, Text and
         * Subtext for words; the terminal uses Catppuccin's own Mocha ANSI colours.
         */
        val CATPPUCCIN_MOCHA = Palette(
            isLight = false,
            bg = Color(0xFF1E1E2E), panel = Color(0xFF181825), panel2 = Color(0xFF313244), line = Color(0xFF45475A),
            separator = Color(0xFF313244), pillBg = Color(0xFF181825), raised = Color(0xFF585B70), fg = Color(0xFFCDD6F4),
            fg2 = Color(0xFFA6ADC8), fg3 = Color(0xFF7F849C), titleFg = Color(0xFFBAC2DE), accent = Color(0xFF94E2D5),
            interactive = Color(0xFF89B4FA), onInteractive = Color(0xFF11111B), blocked = Color(0xFFF38BA8),
            working = Color(0xFFFAB387), idle = Color(0xFF89B4FA), done = Color(0xFFA6E3A1), toastBg = Color(0xFFCDD6F4),
            toastFg = Color(0xFF1E1E2E),
            ansi = intArrayOf(
                0x45475A, 0xF38BA8, 0xA6E3A1, 0xF9E2AF, 0x89B4FA, 0xF5C2E7, 0x94E2D5, 0xBAC2DE,
                0x585B70, 0xF38BA8, 0xA6E3A1, 0xF9E2AF, 0x89B4FA, 0xF5C2E7, 0x94E2D5, 0xA6ADC8,
            ),
            minimumContrast = 1.0,
        )
    }
}

/** JetBrains Mono, bundled (res/font). Only Regular and Bold exist, so "semibold" mono is Bold. */
val Mono = FontFamily(
    Font(R.font.jetbrains_mono_regular, FontWeight.Normal),
    Font(R.font.jetbrains_mono_bold, FontWeight.Bold),
)

/** DESIGN.md §2. Styles that carry a token colour are getters, so they follow the theme. */
object Type {
    val sectionLabel: TextStyle get() = TextStyle(fontFamily = Mono, fontSize = 12.sp, letterSpacing = 0.12.em, color = Tokens.fg3)
    val pill = TextStyle(fontFamily = Mono, fontSize = 12.sp)
    /** Key cap (§4.6): mono 15; a single glyph is set at 18 by the cap itself. */
    val keyCap: TextStyle get() = TextStyle(fontFamily = Mono, fontSize = 15.sp, color = Tokens.titleFg)
    /** The New terminal sheet's command chips. */
    val chip: TextStyle get() = TextStyle(fontFamily = Mono, fontSize = 13.sp, color = Tokens.titleFg)
    val rowName: TextStyle get() = TextStyle(fontFamily = Mono, fontSize = 15.sp, fontWeight = FontWeight.Bold, color = Tokens.fg)
    /** Row line 2 (§4.3): folder and status word, each in its own colour via spans. */
    val rowLine2: TextStyle get() = TextStyle(fontFamily = Mono, fontSize = 13.sp, color = Tokens.fg2)
    val chrono: TextStyle get() = TextStyle(fontFamily = Mono, fontSize = 14.sp, color = Tokens.fg2, fontFeatureSettings = "tnum")
    val paneTitle: TextStyle get() = TextStyle(fontFamily = Mono, fontSize = 15.sp, color = Tokens.titleFg)
    val cardHead = TextStyle(fontFamily = Mono, fontSize = 13.sp)
    val command: TextStyle get() = TextStyle(fontFamily = Mono, fontSize = 12.5.sp, color = Tokens.fg)
    val question: TextStyle get() = TextStyle(fontSize = 15.sp, fontWeight = FontWeight.SemiBold, color = Tokens.fg)
    val description: TextStyle get() = TextStyle(fontSize = 14.sp, color = Tokens.fg2)
    val option: TextStyle get() = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Medium, color = Tokens.fg)
    val composer: TextStyle get() = TextStyle(fontSize = 15.sp, color = Tokens.fg)
    val toast = TextStyle(fontFamily = Mono, fontSize = 12.5.sp)
    val banner = TextStyle(fontFamily = Mono, fontSize = 12.5.sp)
    val hint: TextStyle get() = TextStyle(fontSize = 15.sp, color = Tokens.fg2)
    val listTitle: TextStyle get() = TextStyle(fontFamily = Mono, fontSize = 16.sp, color = Tokens.fg)
    val navTitle: TextStyle get() = TextStyle(fontSize = 17.sp, fontWeight = FontWeight.SemiBold, color = Tokens.fg)
    val body: TextStyle get() = TextStyle(fontSize = 15.sp, color = Tokens.fg)
    val small: TextStyle get() = TextStyle(fontSize = 14.sp, color = Tokens.fg)
    val monoSmall: TextStyle get() = TextStyle(fontFamily = Mono, fontSize = 12.5.sp, color = Tokens.fg3)
    val eyebrow: TextStyle get() = TextStyle(fontFamily = Mono, fontSize = 11.sp, letterSpacing = 0.08.em, color = Tokens.fg3)
}

/**
 * Material's scheme remapped onto the selected theme's tokens (its light or dark base by the theme), so any stock
 * component that slips through still matches.
 */
@Composable
fun FlowTheme(content: @Composable () -> Unit) {
    val base = if (Tokens.palette.isLight) lightColorScheme() else darkColorScheme()
    val scheme = base.copy(
        primary = Tokens.interactive,
        onPrimary = Tokens.onInteractive,
        primaryContainer = Tokens.panel2,
        onPrimaryContainer = Tokens.fg,
        secondary = Tokens.fg2,
        onSecondary = Tokens.bg,
        tertiary = Tokens.accent,
        onTertiary = Tokens.onInteractive,
        tertiaryContainer = Tokens.accentWash,
        onTertiaryContainer = Tokens.accent,
        error = Tokens.blocked,
        onError = Tokens.bg,
        errorContainer = Tokens.panel,
        onErrorContainer = Tokens.blocked,
        background = Tokens.bg,
        onBackground = Tokens.fg,
        surface = Tokens.bg,
        onSurface = Tokens.fg,
        surfaceVariant = Tokens.panel,
        onSurfaceVariant = Tokens.fg2,
        surfaceContainer = Tokens.panel,
        surfaceContainerLow = Tokens.panel,
        surfaceContainerLowest = Tokens.bg,
        surfaceContainerHigh = Tokens.panel2,
        surfaceContainerHighest = Tokens.panel2,
        surfaceTint = Color.Transparent,
        outline = Tokens.line,
        outlineVariant = Tokens.separator,
        scrim = Tokens.bg.copy(alpha = 0.7f),
    )
    val typography = Typography().let { t ->
        t.copy(
            bodyLarge = t.bodyLarge.copy(color = Tokens.fg),
            bodyMedium = t.bodyMedium.copy(color = Tokens.fg),
            bodySmall = t.bodySmall.copy(color = Tokens.fg2),
            titleMedium = t.titleMedium.copy(color = Tokens.fg),
            titleSmall = t.titleSmall.copy(color = Tokens.fg),
            labelMedium = t.labelMedium.copy(color = Tokens.fg2),
            labelLarge = t.labelLarge.copy(color = Tokens.fg),
        )
    }
    MaterialTheme(colorScheme = scheme, typography = typography, content = content)
}

// ---------------------------------------------------------------- status vocabulary (§3)

object Status {
    fun color(status: String?): Color = when (status) {
        AgentStatus.BLOCKED -> Tokens.blocked
        AgentStatus.WORKING -> Tokens.working
        AgentStatus.IDLE -> Tokens.idle
        AgentStatus.DONE -> Tokens.done
        else -> Tokens.fg3
    }

    fun color(p: PaneInfo): Color = if (!p.hasAgent) Tokens.fg3 else color(p.agent_status)

    /** Fixed words; null for an unknown status or a pane without an agent (no pill). */
    fun word(status: String, question: Boolean): String? = when (status) {
        AgentStatus.BLOCKED -> if (question) "Has a question" else "Waiting for approval"
        AgentStatus.WORKING -> "Working"
        AgentStatus.IDLE -> "Idle"
        AgentStatus.DONE -> "Done"
        else -> null
    }

    fun word(p: PaneInfo): String? = if (!p.hasAgent) null else word(p.agent_status, p.approval?.isChoice == true)

    /** Elapsed time shows for these. */
    fun timed(p: PaneInfo): Boolean = p.hasAgent && (p.agent_status == AgentStatus.WORKING || p.agent_status == AgentStatus.BLOCKED)

    /** The connection pill of the list header (and of the pane header while not connected). */
    fun connection(state: ConnectionState): Pair<String, Color> = when (state) {
        is ConnectionState.Connected -> "Connected" to Tokens.done
        ConnectionState.Connecting -> "Connecting…" to Tokens.working
        is ConnectionState.Reconnecting -> "Reconnecting…" to Tokens.working
        is ConnectionState.Unpaired -> "Not paired" to Tokens.blocked
        ConnectionState.Idle -> "Offline" to Tokens.blocked
    }
}

/** `mm:ss`, `h:mm:ss` past an hour. */
/** Line 1 of a list row and of the pane header (DESIGN.md §4.3, §4.4): the pane title (the bridge has removed the agent's status glyph), else the cwd basename, else the pane id. */
fun sessionTitle(p: PaneInfo): String = p.title.ifEmpty { cwdName(p.cwd) ?: p.id }

/** The agent as herdr names it (`claude`, `codex`, `pi`), else its display name; null for a plain shell. */
fun agentName(p: PaneInfo): String? = p.agent?.takeIf { it.isNotEmpty() } ?: p.display_agent?.takeIf { it.isNotEmpty() }

/** What the row's tool glyph stands for (§4.3): the agent's display name ("Claude Code"), else its id, else "Terminal" for a plain shell. */
fun toolName(p: PaneInfo): String = p.display_agent?.takeIf { it.isNotEmpty() } ?: p.agent?.takeIf { it.isNotEmpty() } ?: "Terminal"

fun elapsedLabel(sinceMs: Long, nowMs: Long): String {
    val total = ((nowMs - sinceMs) / 1000).coerceAtLeast(0)
    val h = total / 3600
    val m = (total % 3600) / 60
    val s = total % 60
    return if (h > 0) "%d:%02d:%02d".format(h, m, s) else "%02d:%02d".format(m, s)
}

/** The current time, updated every second while [active]. */
@Composable
fun rememberNow(active: Boolean): State<Long> = produceState(System.currentTimeMillis(), active) {
    while (active && isActive) {
        value = System.currentTimeMillis()
        delay(1000)
    }
}

/** The basename of a path, for "agent · project". */
fun cwdName(cwd: String?): String? = cwd?.trimEnd('/')?.substringAfterLast('/')?.takeIf { it.isNotEmpty() } ?: cwd?.takeIf { it == "/" }

// ---------------------------------------------------------------- components (§4)

@Composable
fun StatusDot(color: Color, size: androidx.compose.ui.unit.Dp = 8.dp) {
    Box(Modifier.size(size).clip(CircleShape).background(color))
}

/** §4.1 */
@Composable
fun StatusPill(word: String, color: Color, modifier: Modifier = Modifier) {
    Row(
        modifier.clip(CircleShape).background(Tokens.pillBg).border(1.dp, Tokens.line, CircleShape).padding(horizontal = 8.dp, vertical = 3.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        StatusDot(color)
        Text(word, style = Type.pill, color = color, maxLines = 1, softWrap = false)
    }
}

/** §4.2: one toast for every transient notice; the screen hosts it at the top of its content area. */
@Composable
fun BoxScope.FlowToast(notice: Notice?, onDismiss: () -> Unit) {
    LaunchedEffect(notice?.id) {
        if (notice != null) {
            delay(2400)
            onDismiss()
        }
    }
    val slide = with(LocalDensity.current) { 8.dp.roundToPx() }
    AnimatedVisibility(
        visible = notice != null,
        modifier = Modifier.align(Alignment.TopCenter).padding(top = 8.dp),
        enter = slideInVertically(tween(250)) { -slide } + fadeIn(tween(250)),
        exit = slideOutVertically(tween(200)) { -slide } + fadeOut(tween(200)),
    ) {
        val n = notice ?: return@AnimatedVisibility
        Box(Modifier.fillMaxWidth(0.88f), contentAlignment = Alignment.Center) {
            Text(
                n.text,
                style = Type.toast,
                color = Tokens.toastFg,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier
                    .clip(CircleShape)
                    .background(if (n.ok) Tokens.done else Tokens.toastBg)
                    .padding(horizontal = 11.dp, vertical = 6.dp),
                textAlign = TextAlign.Center,
            )
        }
    }
}

/** The screen's toast, fed by [Session.notice]; place inside the Box that holds the content under the header. */
@Composable
fun BoxScope.ToastHost(session: Session) {
    val notice by session.notice.collectAsStateWithLifecycle()
    FlowToast(notice, onDismiss = { session.consumeNotice() })
}

/** Text field as a `panel` card: `line` border, radius 12, padding 12, sans 15 (mono for codes and commands). */
@Composable
fun FlowField(
    value: String,
    onValueChange: (String) -> Unit,
    placeholder: String,
    modifier: Modifier = Modifier,
    mono: Boolean = false,
    singleLine: Boolean = true,
    minLines: Int = 1,
    maxLines: Int = if (singleLine) 1 else 6,
    enabled: Boolean = true,
    background: Color = Tokens.panel,
    keyboardOptions: KeyboardOptions = KeyboardOptions.Default,
    keyboardActions: KeyboardActions = KeyboardActions.Default,
) {
    val style = if (mono) Type.body.copy(fontFamily = Mono) else Type.body
    val shape = RoundedCornerShape(12.dp)
    BasicTextField(
        value = value,
        onValueChange = onValueChange,
        // The placeholder is the field's only label; keep it for TalkBack once a value hides it.
        modifier = modifier.fillMaxWidth().semantics { contentDescription = placeholder },
        enabled = enabled,
        textStyle = style,
        keyboardOptions = keyboardOptions,
        keyboardActions = keyboardActions,
        singleLine = singleLine,
        minLines = minLines,
        maxLines = maxLines,
        cursorBrush = SolidColor(Tokens.interactive),
        decorationBox = { inner ->
            Box(Modifier.clip(shape).background(background).border(1.dp, Tokens.line, shape).padding(12.dp)) {
                if (value.isEmpty()) Text(placeholder, style = style, color = Tokens.fg3, maxLines = 1, overflow = TextOverflow.Ellipsis)
                inner()
            }
        },
    )
}

@Composable
fun SectionLabel(text: String, modifier: Modifier = Modifier) {
    Text(text.uppercase(), style = Type.sectionLabel, modifier = modifier.padding(top = 18.dp, bottom = 6.dp))
}

@Composable
fun Hairline(modifier: Modifier = Modifier, color: Color = Tokens.line) {
    HorizontalDivider(modifier, thickness = 1.dp, color = color)
}

/** A `panel` card with a `line` border (host banner, pairing overlay, hints). */
@Composable
fun PanelCard(modifier: Modifier = Modifier, radius: androidx.compose.ui.unit.Dp = 14.dp, onClick: (() -> Unit)? = null, content: @Composable ColumnScope.() -> Unit) {
    val shape = RoundedCornerShape(radius)
    Column(
        modifier
            .clip(shape)
            .background(Tokens.panel)
            .border(1.dp, Tokens.line, shape)
            .let { if (onClick != null) it.clickable(onClick = onClick) else it },
        content = content,
    )
}

/** §4.5 option button; also the stacked fallback actions. */
@Composable
fun OptionButton(text: String, marked: Boolean, enabled: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier, description: String? = null) {
    val shape = RoundedCornerShape(10.dp)
    Box(
        modifier
            .fillMaxWidth()
            .alpha(if (enabled) 1f else 0.6f)
            .clip(shape)
            .background(if (marked) Tokens.accentWash else Tokens.panel2)
            .border(1.dp, if (marked) Tokens.accent else Tokens.raised, shape)
            .clickable(enabled = enabled, onClick = onClick)
            .let { if (description != null) it.semantics { contentDescription = description } else it }
            .padding(horizontal = 12.dp, vertical = 9.dp),
    ) {
        Text(text, style = Type.option, maxLines = 3, overflow = TextOverflow.Ellipsis)
    }
}

/** Round icon-ish button: the composer's "+" and "↑". */
@Composable
fun RoundButton(size: androidx.compose.ui.unit.Dp, background: Color, enabled: Boolean = true, onClick: () -> Unit, content: @Composable BoxScope.() -> Unit) {
    Box(
        Modifier.size(size).alpha(if (enabled) 1f else 0.4f).clip(CircleShape).background(background).clickable(enabled = enabled, onClick = onClick),
        contentAlignment = Alignment.Center,
        content = content,
    )
}

/** Full-width primary action (Pair, Create): `interactive` fill, radius 14, 48 dp. */
@Composable
fun PrimaryButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true) {
    Button(
        onClick = onClick,
        enabled = enabled,
        modifier = modifier.fillMaxWidth().height(48.dp).alpha(if (enabled) 1f else 0.4f),
        shape = RoundedCornerShape(14.dp),
        colors = ButtonDefaults.buttonColors(
            containerColor = Tokens.interactive, contentColor = Tokens.onInteractive,
            disabledContainerColor = Tokens.interactive, disabledContentColor = Tokens.onInteractive,
        ),
    ) {
        // Explicit: FlowTheme's `labelLarge` carries `fg`, which would win over the button's content colour.
        Text(text, color = Tokens.onInteractive, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
    }
}

/** Small filled pill in `interactive` (the "Live ↓" button). */
@Composable
fun PillButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, background: Color = Tokens.interactive, contentColor: Color = Tokens.onInteractive) {
    Text(
        text,
        style = Type.small.copy(fontWeight = FontWeight.SemiBold),
        color = contentColor,
        modifier = modifier.clip(CircleShape).background(background).clickable(onClick = onClick).padding(horizontal = 14.dp, vertical = 8.dp),
    )
}

/** Plain text action in `interactive` (links, "Retry now", "Use mouse wheel"). */
@Composable
fun LinkText(text: String, modifier: Modifier = Modifier, color: Color = Tokens.interactive, style: TextStyle = Type.body, onClick: () -> Unit) {
    Text(text, style = style, color = color, modifier = modifier.clip(RoundedCornerShape(6.dp)).clickable(onClick = onClick).padding(horizontal = 8.dp, vertical = 6.dp))
}

@Composable
fun FlowSwitch(checked: Boolean, onCheckedChange: (Boolean) -> Unit) {
    Switch(
        checked = checked,
        onCheckedChange = onCheckedChange,
        colors = SwitchDefaults.colors(
            checkedThumbColor = Tokens.onInteractive, checkedTrackColor = Tokens.interactive, checkedBorderColor = Tokens.interactive,
            uncheckedThumbColor = Tokens.fg2, uncheckedTrackColor = Tokens.panel2, uncheckedBorderColor = Tokens.raised,
        ),
    )
}

/** Segmented control (§4.8). */
@Composable
fun Segmented(options: List<String>, selected: Int, modifier: Modifier = Modifier, onSelect: (Int) -> Unit) {
    Row(modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(Tokens.panel2).padding(3.dp)) {
        options.forEachIndexed { i, label ->
            val on = i == selected
            val fill by animateColorAsState(if (on) Tokens.raised else Color.Transparent, tween(150), label = "segment")
            Text(
                label,
                style = Type.small.copy(fontWeight = if (on) FontWeight.SemiBold else FontWeight.Normal),
                color = if (on) Tokens.fg else Tokens.fg2,
                textAlign = TextAlign.Center,
                modifier = Modifier
                    .weight(1f)
                    .clip(RoundedCornerShape(8.dp))
                    .background(fill)
                    .clickable { onSelect(i) }
                    .padding(vertical = 7.dp),
            )
        }
    }
}

/** A settings-style row: title, one-sentence supporting text, optional trailing control. */
@Composable
fun SettingRow(
    title: String,
    supporting: String? = null,
    mono: Boolean = false,
    titleColor: Color = Tokens.fg,
    onClick: (() -> Unit)? = null,
    trailing: (@Composable RowScope.() -> Unit)? = null,
) {
    Row(
        Modifier
            .fillMaxWidth()
            .let { if (onClick != null) it.clickable(onClick = onClick) else it }
            .padding(horizontal = 16.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(title, style = Type.body, color = titleColor)
            if (supporting != null) {
                Spacer(Modifier.height(2.dp))
                Text(supporting, style = if (mono) Type.monoSmall.copy(color = Tokens.fg2) else Type.description)
            }
        }
        if (trailing != null) {
            Spacer(Modifier.width(12.dp))
            trailing()
        }
    }
}

// Terminal view of one pane (DESIGN.md §4.4): frames via `watch`, scrollback via `history`, key row, composer,
// approval card while blocked, zoom-on-desktop, copy screen.
package com.inferenceaftermath.remotly.ui

import android.content.ClipData
import android.content.ClipboardManager
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowLeft
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MenuDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.inferenceaftermath.remotly.core.connection.ConnectionState
import com.inferenceaftermath.remotly.core.connection.FlowConnection
import com.inferenceaftermath.remotly.core.connection.FlowException
import com.inferenceaftermath.remotly.core.protocol.ApprovalResult
import com.inferenceaftermath.remotly.core.protocol.ErrorCodes
import com.inferenceaftermath.remotly.core.protocol.Outcome
import com.inferenceaftermath.remotly.core.terminal.Row as TermRow
import com.inferenceaftermath.remotly.push.Notifications
import com.inferenceaftermath.remotly.session.ScrollMode
import com.inferenceaftermath.remotly.session.Session
import kotlin.math.max
import kotlin.math.min
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

private const val HISTORY_FIRST_PAGE = 300
private const val HISTORY_MAX = 999

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PaneScreen(session: Session, paneId: String, onBack: () -> Unit) {
    val conn by session.connection.collectAsStateWithLifecycle()
    val connState by session.connState.collectAsStateWithLifecycle()
    val snapshot by session.snapshot.collectAsStateWithLifecycle()
    val grid by session.grid.collectAsStateWithLifecycle()
    val fontScale by session.fontScale.collectAsStateWithLifecycle()
    val fitToDevice by session.fitToDevice.collectAsStateWithLifecycle()
    val zoomOnDesktop by session.zoomOnDesktop.collectAsStateWithLifecycle()
    val scrollModes by session.scrollModes.collectAsStateWithLifecycle()
    val paneAlt by session.paneAlt.collectAsStateWithLifecycle()
    val notifyDone by session.notifyDone.collectAsStateWithLifecycle()
    /** The user's choice for this pane (shown in the menu) and what it resolves to right now. */
    val scrollMode = scrollModes[paneId] ?: ScrollMode.AUTO
    val effectiveMode = when {
        scrollMode != ScrollMode.AUTO -> scrollMode
        paneAlt == true -> ScrollMode.WHEEL
        else -> ScrollMode.SCROLLBACK
    }
    val pane = snapshot?.pane(paneId)
    val scope = rememberCoroutineScope()
    var terminalView by remember { mutableStateOf<TerminalView?>(null) }
    // A− / A+ step the persisted size by 1 sp from the size actually in use (default: the phone's text size).
    fun stepFontSize(delta: Float) {
        val current = terminalView?.effectiveSp ?: (if (fontScale > 0f) TerminalView.BASE_SP * fontScale else TerminalView.DEFAULT_SP)
        session.setFontScale((current + delta).coerceIn(TerminalView.MIN_FONT_SP, TerminalView.MAX_FONT_SP) / TerminalView.BASE_SP)
    }
    val context = LocalContext.current
    val focusManager = LocalFocusManager.current
    val keyboard = LocalSoftwareKeyboardController.current

    var history by remember(paneId) { mutableStateOf<List<TermRow>?>(null) }
    var historyLines by remember(paneId) { mutableIntStateOf(0) }
    var hasMore by remember(paneId) { mutableStateOf(false) }
    var loadingHistory by remember(paneId) { mutableStateOf(false) }
    /** A pull for scrollback found nothing above the screen in herdr (alternate-screen program, fresh shell): shown briefly. */
    var noScrollbackHint by remember(paneId) { mutableStateOf(false) }
    var ctrl by remember { mutableStateOf(false) }
    var rawMode by rememberSaveable { mutableStateOf(false) }
    var approvalBusy by remember(paneId) { mutableStateOf(false) }
    var approvalResult by remember(paneId) { mutableStateOf<ApprovalResult?>(null) }
    var menuOpen by remember { mutableStateOf(false) }
    var confirmClose by remember(paneId) { mutableStateOf(false) }
    var fitJob by remember { mutableStateOf<Job?>(null) }
    var lastFit by remember(paneId, conn) { mutableStateOf<Pair<Int, Int>?>(null) }
    /** "Fitting…": 1 from sending `fit` until its reply, 2 until the first frame after it, 0 otherwise. */
    var fitPhase by remember(paneId) { mutableIntStateOf(0) }

    fun report(e: Throwable) = session.notify(e.message ?: e.javaClass.simpleName)

    fun run(block: suspend (FlowConnection) -> Unit) {
        val c = conn ?: return
        scope.launch {
            try { block(c) } catch (e: Exception) { report(e) }
        }
    }

    // The user is looking at this pane: its approval / finished notifications are read.
    LaunchedEffect(paneId) { Notifications.cancelForPane(context, paneId) }

    // watch + viewing follow the connection object; FlowConnection re-sends both after every reconnect.
    DisposableEffect(conn, paneId) {
        val c = conn
        if (c != null) {
            c.viewing(paneId)
            scope.launch {
                // A pane created a moment ago can be missing from the bridge's snapshot for a few hundred ms
                // (the bridge now waits for it too); retry unknown_pane a few times, like iOS.
                repeat(5) { attempt ->
                    val result = runCatching { c.watch(paneId, zoomOnDesktop) }
                    if (result.isSuccess) return@launch
                    val failure = result.exceptionOrNull()!!
                    if (attempt == 4 || (failure as? FlowException)?.code != ErrorCodes.UNKNOWN_PANE) return@launch
                    delay(400)
                }
            }
        }
        onDispose {
            if (c != null) {
                c.viewing(null)
                session.scope.launch { runCatching { c.unwatch(paneId) } }
            }
        }
    }
    LaunchedEffect(conn, paneId) {
        conn?.approvals?.collect {
            if (it.pane == paneId) {
                approvalResult = it
                approvalBusy = false
                if (it.outcome == Outcome.SENT) session.notify("approval.result · sent", ok = true)
            }
        }
    }
    LaunchedEffect(approvalBusy) {
        if (approvalBusy) {
            delay(25_000)
            approvalBusy = false
        }
    }
    LaunchedEffect(paneId) { session.store.setLastPane(paneId) }
    // Title as last seen, for the "closed" notice once the pane is gone from the snapshot.
    var lastTitle by remember(paneId) { mutableStateOf("") }
    if (confirmClose) {
        CloseTerminalDialog(
            title = lastTitle.ifEmpty { paneId },
            onDismiss = { confirmClose = false },
            onConfirm = {
                confirmClose = false
                val c = conn
                scope.launch {
                    try {
                        if (c == null) throw IllegalStateException("Not connected to the host")
                        try { c.closePane(paneId) } catch (e: FlowException) { if (e.code != ErrorCodes.UNKNOWN_PANE) throw e } // already gone
                        session.notify(closedNotice(lastTitle))
                        onBack()
                    } catch (e: Exception) {
                        report(e)
                    }
                }
            },
        )
    }
    // The pane went away on the desktop (exit typed, closed in herdr or from another device): back to the list.
    var seenInSnapshot by remember(paneId) { mutableStateOf(false) }
    LaunchedEffect(snapshot) {
        val s = snapshot ?: return@LaunchedEffect
        val p = s.pane(paneId)
        if (p != null) {
            seenInSnapshot = true
            lastTitle = sessionTitle(p)
        } else if (seenInSnapshot) {
            session.notify(closedNotice(lastTitle))
            onBack()
        }
    }
    // Swipes go to the program → the phone's own scrollback is off.
    LaunchedEffect(effectiveMode) { if (effectiveMode != ScrollMode.SCROLLBACK) history = null }
    LaunchedEffect(noScrollbackHint) {
        if (noScrollbackHint) {
            delay(8_000)
            noScrollbackHint = false
        }
    }
    // "Fitting…" ends with the first frame after the fit reply (or 3 s after the reply if none comes; the request
    // itself ends the sending phase when it returns or fails).
    LaunchedEffect(grid) { if (fitPhase == 2) fitPhase = 0 }
    LaunchedEffect(fitPhase) {
        if (fitPhase == 2) {
            delay(3_000)
            if (fitPhase == 2) fitPhase = 0
        }
    }
    // "Zoom on desktop while viewing" toggled while this pane is open: apply it now (the bridge takes the flag from the next watch).
    var zoomSetting by remember(paneId) { mutableStateOf(zoomOnDesktop) }
    LaunchedEffect(zoomOnDesktop) {
        if (zoomOnDesktop != zoomSetting) {
            zoomSetting = zoomOnDesktop
            conn?.let { c -> runCatching { c.zoom(paneId, if (zoomOnDesktop) "on" else "off") } }
        }
    }
    // Fit off → give the pane back to herdr (on: the terminal view reports its grid and we send `fit`).
    LaunchedEffect(fitToDevice, conn, paneId) {
        if (!fitToDevice) {
            fitJob?.cancel() // a debounced fit must not follow the release (same as iOS releaseFit)
            fitJob = null
            fitPhase = 0
            lastFit = null
            conn?.let { c -> runCatching { c.releaseFit(paneId) } }
        }
    }

    fun loadHistory(lines: Int) {
        val c = conn ?: return
        if (loadingHistory) return
        loadingHistory = true
        scope.launch {
            try {
                val h = c.history(paneId, lines)
                if (h.scrollback == 0) {
                    // herdr holds nothing above the screen: `recent` is the live view again. Stay live and say so
                    // (programs that draw their own screen scroll with the wheel instead).
                    history = null
                    noScrollbackHint = true
                } else {
                    val widest = h.lines.maxOfOrNull { l -> l.runs.maxOfOrNull { it.c + it.w } ?: 0 } ?: 0
                    val cols = max(grid?.cols ?: 0, widest)
                    history = h.lines.map { TermRow.fromRuns(it.runs, cols) }
                    hasMore = h.has_more && lines < HISTORY_MAX
                    historyLines = lines
                }
            } catch (e: Exception) {
                report(e)
            } finally {
                loadingHistory = false
            }
        }
    }

    /** Answer the dialog by option number: the bridge moves the desktop cursor there and presses Enter. */
    fun choose(promptId: String?, option: Int, label: String) {
        if (promptId == null) return
        approvalResult = null
        approvalBusy = true
        run { c -> c.choose(paneId, promptId, option, label) }
    }

    fun approve(action: String, feedback: String?, force: Boolean) {
        val promptId = pane?.prompt_id ?: return
        approvalBusy = true
        run { c ->
            try {
                c.approve(paneId, promptId, action, feedback, force)
            } catch (e: Exception) {
                approvalBusy = false
                throw e
            }
        }
    }

    // Header text (DESIGN.md §4.4): the session title, one line, nothing under it.
    val title = pane?.let { sessionTitle(it) } ?: lastTitle.ifEmpty { paneId }
    // Trailing slot: the connection word while not connected, "Fitting…" while a fit is in flight, else the pane's
    // status mark (animated while working).
    val headerPill: Pair<String, Color>? = when {
        connState !is ConnectionState.Connected -> Status.connection(connState)
        fitPhase != 0 -> "Fitting…" to Tokens.working
        else -> null
    }
    val markPane = if (headerPill == null) pane else null

    Scaffold(
        containerColor = Tokens.bg,
        topBar = {
            Row(
                Modifier.fillMaxWidth().background(Tokens.bg).statusBarsPadding().heightIn(min = 52.dp).padding(start = 2.dp, end = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                IconButton(onClick = onBack) {
                    Icon(Icons.AutoMirrored.Filled.KeyboardArrowLeft, contentDescription = "Back", tint = Tokens.interactive, modifier = Modifier.size(30.dp))
                }
                TitleAndPill(
                    modifier = Modifier.weight(1f),
                    title = { Text(title, style = Type.paneTitle, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                    pill = when {
                        headerPill != null -> ({ StatusPill(headerPill.first, headerPill.second) })
                        markPane != null -> ({ PaneMark(markPane, height = 18.dp, animated = true) })
                        else -> null
                    },
                )
                // A− / A+: one step of text size each, the only text-size control (iOS uses the textformat.size.smaller /
                // .larger symbols).
                IconButton(onClick = { stepFontSize(-1f) }, modifier = Modifier.semantics { contentDescription = "Smaller text" }) {
                    Text("A−", fontSize = 15.sp, color = Tokens.fg2)
                }
                IconButton(onClick = { stepFontSize(1f) }, modifier = Modifier.semantics { contentDescription = "Larger text" }) {
                    Text("A+", fontSize = 18.sp, color = Tokens.fg2)
                }
                Box {
                    IconButton(onClick = { menuOpen = true }) { Icon(Icons.Default.MoreVert, contentDescription = "More", tint = Tokens.fg2) }
                    DropdownMenu(
                        expanded = menuOpen, onDismissRequest = { menuOpen = false },
                        shape = RoundedCornerShape(12.dp), containerColor = Tokens.panel2, border = BorderStroke(1.dp, Tokens.line),
                    ) {
                        MenuItem("Copy screen") {
                            menuOpen = false
                            // What is on screen: the scrollback rows while browsing them, else the live grid (same as iOS).
                            (history?.joinToString("\n") { it.text() } ?: grid?.plainText())?.let {
                                context.getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("screen", it))
                                session.notify("copied")
                            }
                        }
                        MenuItem("Raw text mode", checked = rawMode) { rawMode = !rawMode; menuOpen = false }
                        if (pane?.hasAgent == true) {
                            val armed = paneId in notifyDone
                            MenuItem("Tell me when it's done", checked = armed) {
                                menuOpen = false
                                scope.launch { try { session.setNotifyDone(paneId, !armed) } catch (e: Exception) { report(e) } }
                            }
                        }
                        Text("Swiping up and down".uppercase(), style = Type.sectionLabel, modifier = Modifier.padding(start = 12.dp, top = 10.dp, bottom = 2.dp, end = 12.dp))
                        for (mode in ScrollMode.entries) {
                            MenuItem(mode.label, checked = mode == scrollMode) { menuOpen = false; session.setScrollMode(paneId, mode) }
                        }
                        HorizontalDivider(color = Tokens.line)
                        MenuItem("Close terminal", color = Tokens.blocked) { menuOpen = false; confirmClose = true }
                    }
                }
            }
        },
    ) { padding ->
        Column(Modifier.padding(padding).consumeWindowInsets(padding).imePadding().fillMaxSize().background(Tokens.bg)) {
            Box(Modifier.weight(1f).fillMaxWidth()) {
                AndroidView(
                    factory = { ctx -> TerminalView(ctx).also { terminalView = it } },
                    update = { v ->
                        v.onScrollback = { if (history == null) loadHistory(HISTORY_FIRST_PAGE) }
                        v.onReachTop = { if (history != null && hasMore && !loadingHistory) loadHistory(min(historyLines * 2, HISTORY_MAX)) }
                        v.onPullBottom = { history = null }
                        v.onTap = {
                            // Same as iOS: a tap on the terminal puts the keyboard away.
                            focusManager.clearFocus()
                            keyboard?.hide()
                        }
                        v.onCopied = { session.notify("copied") }
                        v.forwardScroll = effectiveMode != ScrollMode.SCROLLBACK
                        v.onScrollLines = { dir, n, c, r -> run { it.scroll(paneId, dir, n, effectiveMode.wire, c, r) } }
                        v.styles = conn?.styles
                        v.fitMode = fitToDevice
                        v.onDeviceGrid = { c, r ->
                            if (fitToDevice) {
                                fitJob?.cancel()
                                fitJob = scope.launch {
                                    delay(300)
                                    val target = c to r
                                    if (lastFit != target) {
                                        lastFit = target
                                        val cn = conn ?: return@launch
                                        fitPhase = 1
                                        runCatching { cn.fit(paneId, c, r) }
                                            .onFailure { if (it is CancellationException) throw it; fitPhase = 0; report(it) }
                                            .onSuccess { fitPhase = 2 }
                                    }
                                }
                            }
                        }
                        v.setFontScale(fontScale)
                        v.setGrid(grid)
                        v.setHistory(history)
                    },
                    modifier = Modifier.fillMaxSize(),
                )
                if (grid == null && history == null) {
                    Text("Waiting for the first frame…", Modifier.align(Alignment.Center), style = Type.hint, textAlign = TextAlign.Center)
                }
                if (history != null) {
                    // Scrolling past the bottom also returns to live; this is the visible cue that the view is frozen.
                    PillButton(if (loadingHistory) "Loading…" else "Live ↓", onClick = { history = null }, modifier = Modifier.align(Alignment.BottomEnd).padding(12.dp))
                }
                if (noScrollbackHint) {
                    // Same message and action as iOS: nothing older exists in herdr for this pane.
                    PanelCard(
                        modifier = Modifier.align(Alignment.TopCenter).padding(horizontal = 12.dp, vertical = 8.dp).clickable { noScrollbackHint = false },
                        radius = 10.dp,
                    ) {
                        Column(Modifier.padding(horizontal = 12.dp, vertical = 10.dp)) {
                            Text(
                                "Nothing older here: herdr holds no scrollback for this pane. If a full-screen program is running, swipes can go to it as mouse-wheel steps.",
                                style = Type.small,
                            )
                            LinkText("Use mouse wheel", onClick = { session.setScrollMode(paneId, ScrollMode.WHEEL); noScrollbackHint = false }, modifier = Modifier.align(Alignment.End), style = Type.small)
                        }
                    }
                }
                ToastHost(session)
            }
            val p = pane
            if (p != null && p.isBlocked && p.prompt_id != null) {
                // A long dialog (six-line command, many options, large text) scrolls inside the card so the key row and
                // composer stay reachable: the card takes at most 55 % of the height (same on iOS).
                BoxWithConstraints {
                    Box(Modifier.heightIn(max = maxHeight * 0.55f).verticalScroll(rememberScrollState())) {
                        ApprovalCard(p, approvalResult?.takeIf { it.prompt_id == p.prompt_id }, approvalBusy, onChoose = { option, label -> choose(p.prompt_id, option, label) }) { a, f, force -> approve(a, f, force) }
                    }
                }
            }
            KeyRow(ctrl, onCtrl = { ctrl = it }) { keys -> run { it.keys(paneId, keys) } }
            Composer(rawMode, ctrl = ctrl, upload = { jpeg -> session.upload(jpeg) }) { text, raw ->
                when {
                    ctrl && text.codePointCount(0, text.length) == 1 -> {
                        ctrl = false
                        run { it.keys(paneId, listOf("ctrl+${text.lowercase()}")) }
                    }
                    raw -> run { it.text(paneId, text) }
                    else -> run { session.prompt(it, paneId, text) }
                }
            }
        }
    }
}

/** Overflow menu row; [checked] draws the check mark in `accent` (toggles and the swipe-mode radio group). */
/**
 * The header's middle: title block left, status pill right. The pill keeps its own width up to half the slot and the
 * title takes the rest, so a long connection word ("Reconnecting…") next to four buttons truncates both instead of
 * starving the title (a weighted title next to an unweighted pill can end at zero width). Same rule as iOS, where the
 * stack offers each side half.
 */
@Composable
private fun TitleAndPill(title: @Composable () -> Unit, pill: (@Composable () -> Unit)?, modifier: Modifier = Modifier) {
    Layout(contents = listOf(title, pill ?: {}), modifier = modifier) { (titleMeasurables, pillMeasurables), constraints ->
        val gap = 8.dp.roundToPx()
        val width = constraints.maxWidth
        val pillPlaceable = pillMeasurables.firstOrNull()?.measure(constraints.copy(minWidth = 0, maxWidth = width / 2))
        val pillWidth = pillPlaceable?.width ?: 0
        val titleMax = if (pillPlaceable == null) width else (width - pillWidth - gap).coerceAtLeast(0)
        val titlePlaceable = titleMeasurables.first().measure(constraints.copy(minWidth = 0, maxWidth = titleMax))
        val height = maxOf(titlePlaceable.height, pillPlaceable?.height ?: 0, constraints.minHeight)
        layout(width, height) {
            titlePlaceable.placeRelative(0, (height - titlePlaceable.height) / 2)
            pillPlaceable?.placeRelative(width - pillWidth, (height - pillPlaceable.height) / 2)
        }
    }
}

/** A menu row in the app's look (the pane overflow, the list row's long-press menu): `Type.body` in [color], a check mark when [checked]. */
@Composable
fun MenuItem(label: String, checked: Boolean? = null, color: Color = Tokens.fg, onClick: () -> Unit) {
    DropdownMenuItem(
        text = { Text(label, style = Type.body, color = color) },
        onClick = onClick,
        colors = MenuDefaults.itemColors(textColor = color, leadingIconColor = Tokens.accent),
        leadingIcon = if (checked == null) null else {
            { Box(Modifier.size(18.dp)) { if (checked) Icon(Icons.Default.Check, contentDescription = "On", tint = Tokens.accent, modifier = Modifier.size(18.dp)) } }
        },
    )
}

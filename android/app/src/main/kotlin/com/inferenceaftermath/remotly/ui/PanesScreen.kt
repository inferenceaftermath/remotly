// Home (DESIGN.md §4.3): host header with the connection pill and Settings; a one-line banner only while the connection
// has a problem; "Needs you", then one section per herdr tab. Two-line rows with the tool glyph; a tap opens the pane, a
// long press opens its menu (Close terminal). A round "+" fixed at the bottom-right corner opens the New terminal sheet.
package com.inferenceaftermath.remotly.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.pulltorefresh.PullToRefreshDefaults
import androidx.compose.material3.pulltorefresh.rememberPullToRefreshState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.inferenceaftermath.remotly.core.connection.ConnectionState
import com.inferenceaftermath.remotly.core.connection.FlowException
import com.inferenceaftermath.remotly.core.protocol.ErrorCodes
import com.inferenceaftermath.remotly.core.connection.HostConfig
import com.inferenceaftermath.remotly.core.protocol.AgentStatus
import com.inferenceaftermath.remotly.core.protocol.PaneInfo
import com.inferenceaftermath.remotly.core.protocol.Snapshot
import com.inferenceaftermath.remotly.session.Session
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PanesScreen(session: Session, host: HostConfig, onOpenPane: (String) -> Unit, onSettings: () -> Unit) {
    val snapshot by session.snapshot.collectAsStateWithLifecycle()
    val notifyDone by session.notifyDone.collectAsStateWithLifecycle()
    val demo by session.isDemo.collectAsStateWithLifecycle()
    val conn by session.connection.collectAsStateWithLifecycle()
    val connState by session.connState.collectAsStateWithLifecycle()
    val herdrUp by session.herdrUp.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()

    // "Close terminal" from a row's long-press menu: the same dialog and words as the pane's overflow.
    var paneToClose by remember { mutableStateOf<PaneInfo?>(null) }
    paneToClose?.let { p ->
        val title = sessionTitle(p)
        CloseTerminalDialog(
            demo = demo,
            title = title,
            onDismiss = { paneToClose = null },
            onConfirm = {
                paneToClose = null
                val c = conn
                scope.launch {
                    try {
                        if (c == null) throw IllegalStateException("Not connected to the host")
                        try { c.closePane(p.id) } catch (e: FlowException) { if (e.code != ErrorCodes.UNKNOWN_PANE) throw e } // already gone
                        session.notify(closedNotice(title))
                    } catch (e: Exception) {
                        session.notify(e.message ?: e.javaClass.simpleName)
                    }
                }
            },
        )
    }

    var newTerminal by remember { mutableStateOf(false) }
    if (newTerminal) {
        val c = conn
        NewTerminalDialog(
            demo = demo,
            enabled = c != null,
            onDismiss = { newTerminal = false },
            onCreate = { label, command -> c!!.createPane(label, command) },
            onCreated = { paneId ->
                newTerminal = false
                onOpenPane(paneId)
            },
        )
    }

    val (connWord, connColor) = Status.connection(connState)
    var refreshing by remember { mutableStateOf(false) }
    val refreshState = rememberPullToRefreshState()
    Column(Modifier.fillMaxSize().background(Tokens.bg)) {
        Row(
            Modifier.fillMaxWidth().statusBarsPadding().heightIn(min = 52.dp).padding(start = 16.dp, end = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(host.hostName.ifEmpty { host.url.removePrefix("wss://") }, style = Type.listTitle, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            StatusPill(if (demo) "Local" else connWord, if (demo) Tokens.idle else connColor)
            IconButton(onClick = onSettings) { Icon(Icons.Default.Settings, contentDescription = "Settings", tint = Tokens.fg2) }
        }
        Box(Modifier.weight(1f).fillMaxWidth()) {
            PullToRefreshBox(
                isRefreshing = refreshing,
                onRefresh = {
                    refreshing = true
                    conn?.reconnectNow()
                    scope.launch { delay(900); refreshing = false }
                },
                state = refreshState,
                modifier = Modifier.fillMaxSize(),
                indicator = {
                    PullToRefreshDefaults.Indicator(
                        state = refreshState, isRefreshing = refreshing, modifier = Modifier.align(Alignment.TopCenter),
                        containerColor = Tokens.panel2, color = Tokens.interactive,
                    )
                },
            ) {
                val snap = snapshot
                val now by rememberNow(active = snap?.panes?.any { Status.timed(it) && it.since != null } == true)
                // The problem line shows above the list only; without a snapshot the centred state below carries it.
                val problem = if (snap == null) null else connectionProblem(connState, herdrUp, onRetry = { conn?.reconnectNow() }, onForget = { scope.launch { session.unpair() } })
                // The screen draws edge to edge: the bottom padding keeps the last row clear of the navigation bar and of the
                // New terminal button (52 dp, 16 dp inset, breathing room).
                val navBar = WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding()
                LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 92.dp + navBar)) {
                    if (problem != null) item(key = "problem") { ProblemBanner(problem) }
                    when {
                        // No snapshot yet: the header pill already says Connecting… / Offline / Not paired.
                        snap == null -> item(key = "waiting") {
                            Box(Modifier.fillParentMaxHeight(0.7f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                                Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(12.dp)) {
                                    if (connState is ConnectionState.Unpaired) {
                                        Text("This phone is no longer paired.", style = Type.hint, textAlign = TextAlign.Center)
                                        LinkText("Forget host and pair again") { scope.launch { session.unpair() } }
                                    } else {
                                        Text("Waiting for the bridge…", style = Type.hint, textAlign = TextAlign.Center)
                                        LinkText("Retry now") { conn?.reconnectNow() }
                                    }
                                }
                            }
                        }
                        snap.panes.isEmpty() -> {
                            item(key = "empty") {
                                Text("No panes open in herdr.", style = Type.hint, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth().padding(top = 40.dp))
                            }
                        }
                        else -> paneSections(snap, notifyDone, now, ListCallbacks(onOpenPane = onOpenPane, onClose = { p -> paneToClose = p }))
                    }
                }
            }
            if (snapshot != null) {
                // Over the list, fixed while it scrolls (§4.3); inert while the connection is not up (the banner says why).
                NewTerminalButton(
                    enabled = connState is ConnectionState.Connected,
                    modifier = Modifier.align(Alignment.BottomEnd).navigationBarsPadding().padding(16.dp),
                ) { newTerminal = true }
            }
            ToastHost(session)
        }
    }
}

/** What is wrong with the connection right now, or null when everything is up (DESIGN.md §4.3; same words as iOS). */
private class ConnectionProblem(val text: String, val color: Color, val actionLabel: String? = null, val action: (() -> Unit)? = null)

private fun connectionProblem(state: ConnectionState, herdrUp: Boolean, onRetry: () -> Unit, onForget: () -> Unit): ConnectionProblem? = when (val s = state) {
    is ConnectionState.Unpaired -> ConnectionProblem("This phone is no longer paired.", Tokens.blocked, "Forget host and pair again", onForget)
    ConnectionState.Connecting -> ConnectionProblem("Connecting…", Tokens.working, "Retry now", onRetry)
    is ConnectionState.Reconnecting -> ConnectionProblem("Reconnecting… · attempt ${s.attempt}", Tokens.working, "Retry now", onRetry)
    ConnectionState.Idle -> ConnectionProblem("Offline", Tokens.blocked, "Retry now", onRetry)
    is ConnectionState.Connected -> if (herdrUp) null else ConnectionProblem("herdr is down on the host · pane actions will fail until it is back", Tokens.blocked)
}

/** The one-line card under the header while the connection has a problem: the problem and, when one helps, an action. */
@Composable
private fun ProblemBanner(problem: ConnectionProblem) {
    PanelCard(Modifier.fillMaxWidth().padding(top = 4.dp), radius = 14.dp) {
        Column(Modifier.padding(horizontal = 12.dp, vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(problem.text, style = Type.banner, color = problem.color)
            val label = problem.actionLabel
            val action = problem.action
            if (label != null && action != null) LinkText(label, onClick = action, style = Type.banner, modifier = Modifier.padding(top = 2.dp))
        }
    }
}

/** The round "+" (§4.3): a 52 dp `interactive` disc with the glyph in `onInteractive`; 40 % when disabled. Same as iOS. */
@Composable
private fun NewTerminalButton(enabled: Boolean, modifier: Modifier = Modifier, onClick: () -> Unit) {
    Box(
        modifier
            .size(52.dp)
            .alpha(if (enabled) 1f else 0.4f)
            .clip(CircleShape)
            .background(Tokens.interactive)
            .clickable(enabled = enabled, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Icon(Icons.Default.Add, contentDescription = "New terminal", tint = Tokens.onInteractive, modifier = Modifier.size(24.dp))
    }
}

/** Sort inside a tab: working → idle → done → other agents → plain shells (blocked panes sit under "Needs you"). */
private fun rank(p: PaneInfo): Int = when {
    !p.hasAgent -> 5
    p.agent_status == AgentStatus.BLOCKED -> 0
    p.agent_status == AgentStatus.WORKING -> 1
    p.agent_status == AgentStatus.IDLE -> 2
    p.agent_status == AgentStatus.DONE -> 3
    else -> 4
}

private class ListCallbacks(
    val onOpenPane: (String) -> Unit,
    /** Menu item: close the terminal (the screen confirms first). */
    val onClose: (PaneInfo) -> Unit,
)

private fun androidx.compose.foundation.lazy.LazyListScope.paneSections(
    snap: Snapshot,
    armed: Set<String>,
    now: Long,
    cb: ListCallbacks,
) {
    @Composable
    fun row(p: PaneInfo) = PaneRow(p, p.id in armed, now, onClick = { cb.onOpenPane(p.id) }, onClose = { cb.onClose(p) })
    // "Needs you": blocked panes with an agent, soonest first; a blocked pane appears only here.
    val needsYou = snap.panes.filter { it.hasAgent && it.isBlocked }.sortedWith(compareBy({ it.since ?: Long.MAX_VALUE }, { it.title }))
    val blockedIds = needsYou.map { it.id }.toSet()
    if (needsYou.isNotEmpty()) {
        item(key = "needs-you") { SectionLabel("Needs you") }
        items(needsYou, key = { "need-${it.id}" }) { row(it) }
    }
    val multiWorkspace = snap.workspaces.size > 1
    val orderedTabs = snap.workspaces.flatMap { ws -> snap.tabs.filter { it.workspace_id == ws.id } } +
        snap.tabs.filter { t -> snap.workspaces.none { it.id == t.workspace_id } }
    for (tab in orderedTabs) {
        val panes = snap.panes.filter { it.tab_id == tab.id && it.id !in blockedIds }.sortedWith(compareBy({ rank(it) }, { it.title }))
        if (panes.isEmpty()) continue
        val ws = snap.workspaces.firstOrNull { it.id == tab.workspace_id }
        val label = (if (multiWorkspace && ws != null) "${ws.name.ifEmpty { ws.id }} › " else "") + tab.name.ifEmpty { tab.id }
        item(key = "tab-${tab.id}") { SectionLabel(label) }
        items(panes, key = { it.id }) { row(it) }
    }
    val knownTabs = snap.tabs.map { it.id }.toSet()
    val orphans = snap.panes.filter { it.tab_id !in knownTabs && it.id !in blockedIds }.sortedWith(compareBy({ rank(it) }, { it.title }))
    if (orphans.isNotEmpty()) {
        item(key = "orphans") { SectionLabel("Other") }
        items(orphans, key = { it.id }) { row(it) }
    }
}

/**
 * Line 2 of a row (§4.3): the cwd basename in `fg3` when it is not line 1, then " · <status word>" in the status colour;
 * null for a plain shell without a folder to show.
 */
private fun rowLine2(p: PaneInfo): AnnotatedString? {
    val folder = cwdName(p.cwd)?.takeIf { it != sessionTitle(p) }
    val word = Status.word(p)
    if (folder == null && word == null) return null
    return buildAnnotatedString {
        var first = true
        fun part(text: String, color: Color) {
            if (!first) withStyle(SpanStyle(color = Tokens.fg3)) { append(" · ") }
            withStyle(SpanStyle(color = color)) { append(text) }
            first = false
        }
        folder?.let { part(it, Tokens.fg3) }
        word?.let { part(it, Status.color(p)) }
    }
}

/**
 * Two-line row (§4.3): the tool glyph, the session title, then folder · status; trailing bell and elapsed time. Tap opens
 * the pane, long press opens the menu.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun PaneRow(
    p: PaneInfo,
    armed: Boolean,
    now: Long,
    modifier: Modifier = Modifier,
    onClick: () -> Unit,
    /** The long-press menu's one item (§4.3): close the terminal (the screen confirms first). */
    onClose: () -> Unit,
) {
    val haptics = LocalHapticFeedback.current
    var menuOpen by remember { mutableStateOf(false) }
    // Assistive tech gets the menu item as an action on the merged row.
    val rowActions = listOf(CustomAccessibilityAction("Close terminal") { onClose(); true })
    Column(modifier.fillMaxWidth().background(Tokens.bg)) {
        Hairline(color = Tokens.separator)
        Box(Modifier.fillMaxWidth()) {
            Row(
                Modifier
                    .fillMaxWidth()
                    .combinedClickable(
                        onClick = onClick,
                        onLongClickLabel = "Options",
                        onLongClick = { haptics.performHapticFeedback(HapticFeedbackType.LongPress); menuOpen = true },
                    )
                    .semantics { customActions = rowActions }
                    .padding(horizontal = 4.dp, vertical = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                // Which tool runs here, in the tool's own colour (§4.12); its label names the tool, line 2 has the status.
                AgentGlyph(AgentGlyphKind.forAgent(p.agent), 16.dp, Modifier.semantics { contentDescription = toolName(p) })
                Spacer(Modifier.width(10.dp))
                Column(Modifier.weight(1f)) {
                    Text(sessionTitle(p), style = Type.rowName, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    rowLine2(p)?.let { Text(it, style = Type.rowLine2, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 2.dp)) }
                }
                if (armed) {
                    Spacer(Modifier.width(8.dp))
                    Icon(Icons.Default.Notifications, contentDescription = "Notifies when done", modifier = Modifier.size(14.dp), tint = Tokens.fg3)
                }
                val since = p.since
                if (since != null && Status.timed(p)) {
                    Spacer(Modifier.width(8.dp))
                    Text(elapsedLabel(since, now), style = Type.chrono, maxLines = 1, softWrap = false)
                }
            }
            // The long-press menu (§4.3): the same item as the iOS context menu, the pane overflow's look.
            DropdownMenu(
                expanded = menuOpen, onDismissRequest = { menuOpen = false },
                shape = RoundedCornerShape(12.dp), containerColor = Tokens.panel2, border = BorderStroke(1.dp, Tokens.line),
            ) {
                MenuItem("Close terminal", color = Tokens.blocked) { menuOpen = false; onClose() }
            }
        }
    }
}

/** Name + command for a fresh terminal on the desktop; quick picks start the coding agents (DESIGN.md §4.10). */
@Composable
private fun NewTerminalDialog(
    demo: Boolean,
    enabled: Boolean,
    onDismiss: () -> Unit,
    onCreate: suspend (label: String?, command: String?) -> String,
    onCreated: (String) -> Unit,
) {
    val scope = rememberCoroutineScope()
    var label by remember { mutableStateOf("") }
    var command by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    fun create() {
        if (busy || !enabled) return
        busy = true
        error = null
        scope.launch {
            try {
                onCreated(onCreate(label.ifBlank { null }, command.ifBlank { null }))
            } catch (e: Exception) {
                error = e.message ?: e.javaClass.simpleName
                busy = false
            }
        }
    }
    AlertDialog(
        onDismissRequest = { if (!busy) onDismiss() },
        containerColor = Tokens.panel,
        titleContentColor = Tokens.fg,
        textContentColor = Tokens.fg2,
        shape = RoundedCornerShape(16.dp),
        title = { Text("New terminal", style = Type.navTitle) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("Name (optional)", style = Type.small.copy(fontSize = 13.sp), color = Tokens.fg2)
                FlowField(label, { label = it }, placeholder = "", background = Tokens.panel2)
                Text("Command to run (optional)", style = Type.small.copy(fontSize = 13.sp), color = Tokens.fg2)
                FlowField(command, { command = it }, placeholder = "claude", mono = true, background = Tokens.panel2)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    for (pick in listOf("claude", "codex", "pi")) {
                        val shape = RoundedCornerShape(8.dp)
                        Text(
                            pick,
                            style = Type.chip,
                            modifier = Modifier
                                .clip(shape)
                                .background(Tokens.panel2)
                                .border(1.dp, Tokens.line, shape)
                                .clickable { command = pick; if (label.isBlank()) label = pick }
                                .padding(horizontal = 12.dp, vertical = 6.dp),
                        )
                    }
                }
                Text(if (demo) "Demo mode: creates a local sample terminal. Commands are simulated, never executed." else "Opens a new herdr tab on the desktop and runs the command once the shell is ready.", style = Type.small.copy(fontSize = 13.sp), color = Tokens.fg3)
                if (!enabled) Text("Not connected to the host.", color = Tokens.blocked, style = Type.small)
                error?.let { Text(it, color = Tokens.blocked, style = Type.small) }
            }
        },
        confirmButton = {
            TextButton(onClick = { create() }, enabled = enabled && !busy) {
                Text(if (busy) "Creating…" else "Create", color = Tokens.interactive, fontWeight = FontWeight.SemiBold)
            }
        },
        dismissButton = { TextButton(onClick = onDismiss, enabled = !busy) { Text("Cancel", color = Tokens.fg2) } },
    )
}

/** Confirmation before `pane.close`: the shell and anything running in it end on the desktop. */
@Composable
fun CloseTerminalDialog(title: String, demo: Boolean = false, onDismiss: () -> Unit, onConfirm: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = Tokens.panel,
        titleContentColor = Tokens.fg,
        textContentColor = Tokens.fg2,
        shape = RoundedCornerShape(16.dp),
        title = { Text("Close $title?", style = Type.navTitle) },
        text = { Text(if (demo) "Removes this local sample session. Your real host is unchanged." else "Ends the shell on the desktop and anything running in it.", style = Type.description) },
        confirmButton = { TextButton(onClick = onConfirm) { Text("Close terminal", color = Tokens.blocked, fontWeight = FontWeight.SemiBold) } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel", color = Tokens.fg2) } },
    )
}

/** Toast copy for a closed pane: `<title> closed`. */
fun closedNotice(title: String): String = if (title.isEmpty()) "terminal closed" else "$title closed"

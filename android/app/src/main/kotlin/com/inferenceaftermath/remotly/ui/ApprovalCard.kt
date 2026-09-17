// Shown while the watched pane is `blocked` (DESIGN.md §4.5): the dialog as a card — tool name, command or file,
// the agent's one-line summary, its question — and the choices it offers as buttons in the dialog's own words.
// Tapping one asks the bridge to move the desktop cursor there and press Enter (`choose`), so the same card serves
// permission prompts, Claude's AskUserQuestion menus and pickers; the choice the desktop currently marks is
// highlighted. Without parsed details (trust dialogs, unknown layouts) the card falls back to the agent's key-map
// actions: Approve / Approve for session / Deny / Interrupt, and the quiet "Deny with feedback…".
package com.inferenceaftermath.remotly.ui

import androidx.compose.animation.Crossfade
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.inferenceaftermath.remotly.core.protocol.ApprovalAction
import com.inferenceaftermath.remotly.core.protocol.ApprovalResult
import com.inferenceaftermath.remotly.core.protocol.Outcome
import com.inferenceaftermath.remotly.core.protocol.PaneInfo

@Composable
fun ApprovalCard(
    pane: PaneInfo,
    result: ApprovalResult?,
    busy: Boolean,
    onChoose: (option: Int, label: String) -> Unit,
    onAction: (action: String, feedback: String?, force: Boolean) -> Unit,
) {
    var showFeedback by remember { mutableStateOf(false) }
    var lastAction by remember(pane.prompt_id) { mutableStateOf<Pair<String, String?>?>(null) }
    fun act(action: String, feedback: String? = null) {
        lastAction = action to feedback
        onAction(action, feedback, false)
    }
    val details = pane.approval
    val isChoice = details?.isChoice == true
    val sent = result != null && result.outcome == Outcome.SENT && !busy
    val failed = result != null && result.outcome != Outcome.SENT && !busy
    val toolLabel = details?.tool ?: if (isChoice) "Question" else "Approval"
    val kindLabel = when {
        details == null -> "prompt"
        isChoice -> "question"
        else -> "permission"
    }
    val quiet = if (isChoice) "Something else…" else "Deny with feedback…"

    Column(Modifier.fillMaxWidth().background(Tokens.panel)) {
        Hairline()
        Crossfade(targetState = sent, animationSpec = tween(200), label = "approval") { isSent ->
            Column(Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                val r = result
                if (isSent && r != null) {
                    HeadRow("✓ Answered from your phone", Tokens.done, "sent")
                    Text(describe(r), style = Type.description)
                } else {
                    when {
                        busy -> HeadRow(toolLabel, Tokens.accent, "sending…")
                        failed && r != null -> HeadRow("✕ Not sent", Tokens.blocked, r.outcome.replace('_', ' '))
                        else -> HeadRow(toolLabel, Tokens.accent, kindLabel)
                    }
                    if (failed && r != null) Text(describe(r), style = Type.description)
                    if (details != null) {
                        val what = details.command ?: details.path
                        if (what != null) CommandBlock(what)
                        details.description?.takeIf { it.isNotBlank() && it != what }?.let { Text(it, style = Type.description) }
                        if (details.question.isNotEmpty()) Text(details.question, style = Type.question)
                        if (details.options.isNotEmpty()) {
                            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                                details.options.forEachIndexed { index, option ->
                                    val number = index + 1
                                    val marked = details.selected == number
                                    OptionButton(
                                        option, marked = marked, enabled = !busy,
                                        onClick = { onChoose(number, option) },
                                        description = "Option $number: $option" + if (marked) ", marked on the desktop" else "",
                                    )
                                }
                            }
                        }
                    } else {
                        pane.state_label?.takeIf { it.isNotBlank() }?.let { Text(it, style = Type.description) }
                        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            OptionButton("Approve", marked = true, enabled = !busy, onClick = { act(ApprovalAction.APPROVE) })
                            OptionButton("Approve for session", marked = false, enabled = !busy, onClick = { act(ApprovalAction.APPROVE_SESSION) })
                            OptionButton("Deny", marked = false, enabled = !busy, onClick = { act(ApprovalAction.DENY) })
                            OptionButton("Interrupt", marked = false, enabled = !busy, onClick = { act(ApprovalAction.INTERRUPT) })
                        }
                    }
                    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        QuietAction(quiet, enabled = !busy) { showFeedback = true }
                        val last = lastAction
                        if (failed && r?.outcome == Outcome.SIGNATURE_MISMATCH && last != null) {
                            QuietAction("Send anyway", enabled = !busy) { onAction(last.first, last.second, true) }
                        }
                    }
                }
            }
        }
    }
    if (showFeedback) {
        FeedbackDialog(
            title = quiet,
            onDismiss = { showFeedback = false },
            onSend = { text ->
                showFeedback = false
                act(ApprovalAction.DENY_FEEDBACK, text.ifBlank { null })
            },
        )
    }
}

@Composable
private fun HeadRow(left: String, leftColor: Color, right: String) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(left, style = Type.cardHead.copy(fontWeight = FontWeight.Bold), color = leftColor, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        Text(right, style = Type.cardHead, color = Tokens.fg3, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(start = 8.dp))
    }
}

/** What runs: mono on `bg`, `line` border, radius 8, up to 6 lines, selectable. */
@Composable
private fun CommandBlock(text: String) {
    val shape = RoundedCornerShape(8.dp)
    SelectionContainer {
        Text(
            text,
            style = Type.command,
            maxLines = 6,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.fillMaxWidth().clip(shape).background(Tokens.bg).border(1.dp, Tokens.line, shape).padding(horizontal = 8.dp, vertical = 6.dp),
        )
    }
}

@Composable
private fun QuietAction(text: String, enabled: Boolean, onClick: () -> Unit) {
    Text(
        text,
        style = Type.small,
        color = Tokens.fg2,
        modifier = Modifier.alpha(if (enabled) 1f else 0.6f).clip(RoundedCornerShape(6.dp)).clickable(enabled = enabled, onClick = onClick).padding(vertical = 4.dp),
    )
}

/** "Deny with feedback…" / "Something else…": Esc first, then the words are typed to the agent. */
@Composable
private fun FeedbackDialog(title: String, onDismiss: () -> Unit, onSend: (String) -> Unit) {
    var feedback by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        containerColor = Tokens.panel,
        titleContentColor = Tokens.fg,
        textContentColor = Tokens.fg2,
        shape = RoundedCornerShape(16.dp),
        title = { Text(title, style = Type.navTitle) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                FlowField(feedback, { feedback = it }, placeholder = "What should it do instead?", singleLine = false, minLines = 3, background = Tokens.panel2)
                Text("Esc dismisses the dialog first, then your words are typed to the agent.", style = Type.small.copy(fontSize = 13.sp), color = Tokens.fg3)
            }
        },
        confirmButton = {
            // Blank feedback would fall back to a plain deny; the button waits for words (same on iOS).
            val ready = feedback.isNotBlank()
            TextButton(enabled = ready, onClick = { onSend(feedback) }) { Text("Send", color = if (ready) Tokens.interactive else Tokens.fg3, fontWeight = FontWeight.SemiBold) }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel", color = Tokens.fg2) } },
    )
}

fun describe(r: ApprovalResult): String = when (r.outcome) {
    Outcome.SENT -> "Sent" + (r.status_after?.let { " · agent now $it" } ?: "")
    Outcome.STALE -> "Stale: the prompt changed before the keys were sent"
    Outcome.NOT_BLOCKED -> "The agent is no longer waiting"
    Outcome.SIGNATURE_MISMATCH -> "The screen does not look like a prompt" + (r.detail?.let { " ($it)" } ?: "")
    Outcome.DIALOG_CHANGED -> "The dialog changed; nothing sent" + (r.detail?.let { " ($it)" } ?: "")
    Outcome.FAILED -> "Failed" + (r.detail?.let { ": $it" } ?: "")
    else -> r.outcome + (r.detail?.let { ": $it" } ?: "")
}

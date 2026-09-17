// Notifications, one id per pane and kind: approvals (channel `approvals`: Approve / Deny / Deny + feedback
// with typed text), finished agents (channel `done`: Reply with typed text) and the ongoing "working"
// notification (channel `status`: silent, chronometer, updated by every `status` push). Approve and the two
// text actions require an unlocked phone while the "Require unlock" setting is on.
package com.inferenceaftermath.remotly.push

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.core.app.NotificationCompat
import androidx.core.app.RemoteInput
import androidx.core.content.ContextCompat
import com.inferenceaftermath.remotly.FlowApplication
import com.inferenceaftermath.remotly.MainActivity
import com.inferenceaftermath.remotly.R
import com.inferenceaftermath.remotly.core.protocol.AgentStatus
import com.inferenceaftermath.remotly.core.protocol.ApprovalAction
import com.inferenceaftermath.remotly.core.push.PushPayload

object Notifications {
    const val CHANNEL_APPROVALS = "approvals"
    const val CHANNEL_DONE = "done"
    const val CHANNEL_STATUS = "status"
    const val EXTRA_PANE = "pane"
    const val EXTRA_PROMPT_ID = "prompt_id"
    const val EXTRA_AGENT = "agent"
    const val EXTRA_ACTION = "approval_action"
    const val EXTRA_TITLE = "title"
    /** [KIND_APPROVAL] (an `approve` request) or [KIND_REPLY] (a `prompt`). */
    const val EXTRA_KIND = "kind"
    const val KIND_APPROVAL = "approval"
    const val KIND_REPLY = "reply"
    /** RemoteInput result key (and the extra it is copied to): the typed feedback or reply. */
    const val KEY_TEXT = "text"
    /** DESIGN.md `accent`: tints the small icon and action text. */
    private const val ACCENT = 0xFF2DD4BF.toInt()
    private const val APPROVAL_TIMEOUT_MS = 600_000L
    private const val OUTCOME_TIMEOUT_MS = 120_000L
    private const val DONE_TIMEOUT_MS = 6 * 3_600_000L

    fun ensureChannels(context: Context) {
        val nm = context.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_APPROVALS, context.getString(R.string.channel_approvals), NotificationManager.IMPORTANCE_HIGH).apply {
                description = context.getString(R.string.channel_approvals_desc)
                enableVibration(true)
                setShowBadge(true)
            },
        )
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_DONE, context.getString(R.string.channel_done), NotificationManager.IMPORTANCE_DEFAULT).apply {
                description = context.getString(R.string.channel_done_desc)
                setShowBadge(true)
            },
        )
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_STATUS, context.getString(R.string.channel_status), NotificationManager.IMPORTANCE_LOW).apply {
                description = context.getString(R.string.channel_status_desc)
                enableVibration(false)
                setSound(null, null)
                setShowBadge(false)
            },
        )
    }

    fun hasPermission(context: Context): Boolean =
        Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    fun notificationId(pane: String): Int = pane.hashCode()
    fun doneId(pane: String): Int = "done:$pane".hashCode()
    fun statusId(pane: String): Int = "status:$pane".hashCode()

    private fun requireUnlock(context: Context): Boolean = FlowApplication.of(context).session.requireUnlock.value

    /** Approval alert. Replaces the pane's ongoing "working" notification: one notification per pane. */
    fun showApproval(context: Context, p: PushPayload) {
        if (!hasPermission(context)) return
        val nm = context.getSystemService(NotificationManager::class.java)
        nm.cancel(statusId(p.pane))
        val a = p.approval
        val big = if (a == null) p.body else buildString {
            val what = a.command ?: a.path
            if (what != null) appendLine(if (a.tool != null) "${a.tool} · $what" else what)
            a.description?.let { appendLine(it) }
            if (a.question.isNotEmpty()) appendLine(a.question)
            a.options.forEachIndexed { i, o -> appendLine("${i + 1}. $o") }
        }.trimEnd()
        val unlock = requireUnlock(context)
        val extras = Bundle().apply {
            putString(EXTRA_PANE, p.pane)
            putString(EXTRA_PROMPT_ID, p.promptId)
        }
        val n = NotificationCompat.Builder(context, CHANNEL_APPROVALS)
            .setSmallIcon(R.drawable.ic_notification)
            .setColor(ACCENT)
            .setContentTitle(p.title)
            .setContentText(p.body)
            .setSubText(p.subtitle.ifEmpty { p.host })
            .setStyle(NotificationCompat.BigTextStyle().bigText(big).setSummaryText(p.subtitle.ifEmpty { p.host }))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setDefaults(NotificationCompat.DEFAULT_ALL)
            .setAutoCancel(true)
            .setOnlyAlertOnce(false)
            .setGroup(p.pane)
            .setTimeoutAfter(APPROVAL_TIMEOUT_MS)
            .setContentIntent(openPaneIntent(context, p.pane))
            .apply {
                // A menu (AskUserQuestion, a picker) cannot be answered from a notification: open the app and use the card.
                if (a?.isChoice != true) {
                    addAction(approvalAction(context, p, ApprovalAction.APPROVE, context.getString(R.string.action_approve), unlock))
                    addAction(approvalAction(context, p, ApprovalAction.DENY, context.getString(R.string.action_deny), false))
                    addAction(approvalAction(context, p, ApprovalAction.DENY_FEEDBACK, context.getString(R.string.action_deny_feedback), unlock, typed = context.getString(R.string.hint_feedback)))
                }
            }
            .addExtras(extras)
            .build()
        nm.notify(notificationId(p.pane), n)
    }

    /** "Claude finished": body is the agent's closing words; Reply types the answer as the next prompt. */
    fun showDone(context: Context, p: PushPayload) {
        if (!hasPermission(context)) return
        val n = NotificationCompat.Builder(context, CHANNEL_DONE)
            .setSmallIcon(R.drawable.ic_notification)
            .setColor(ACCENT)
            .setContentTitle(p.title)
            .setContentText(p.body)
            .setSubText(p.subtitle.ifEmpty { p.host })
            .setStyle(NotificationCompat.BigTextStyle().bigText(p.body).setSummaryText(p.subtitle.ifEmpty { p.host }))
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setDefaults(NotificationCompat.DEFAULT_ALL)
            .setAutoCancel(true)
            .setGroup(p.pane)
            .setTimeoutAfter(DONE_TIMEOUT_MS)
            .setContentIntent(openPaneIntent(context, p.pane))
            .addAction(replyAction(context, p, context.getString(R.string.hint_reply), requireUnlock(context)))
            .addExtras(Bundle().apply { putString(EXTRA_PANE, p.pane) })
            .build()
        context.getSystemService(NotificationManager::class.java).notify(doneId(p.pane), n)
    }

    /**
     * Ongoing "working" notification, one per pane, driven by `status` pushes: chronometer from `since`,
     * "Waiting for approval" while blocked (the approval alert arrives on its own and takes over), gone on
     * idle/done/unknown. A `working` update also clears a stale approval alert for the pane.
     */
    fun showStatus(context: Context, p: PushPayload) {
        val nm = context.getSystemService(NotificationManager::class.java)
        when (p.status) {
            AgentStatus.IDLE, AgentStatus.DONE, AgentStatus.UNKNOWN -> {
                nm.cancel(statusId(p.pane))
                return
            }
        }
        if (!hasPermission(context)) return
        val blocked = p.status == AgentStatus.BLOCKED
        if (!blocked) nm.cancel(notificationId(p.pane))
        // While the pane's approval alert is up it has taken over (it cancelled this line): a blocked status or title update
        // must not bring the status line back beside it.
        else if (nm.activeNotifications.any { it.id == notificationId(p.pane) }) return
        // DESIGN.md §4.11: title = the session title, text = the status word (+ " · <detail>" while blocked).
        val word = if (blocked) context.getString(if (p.kind == "choice") R.string.status_question else R.string.status_blocked) else context.getString(R.string.status_working)
        val text = listOfNotNull(word, p.detail.takeIf { blocked && it.isNotBlank() }).joinToString(" · ")
        val n = NotificationCompat.Builder(context, CHANNEL_STATUS)
            .setSmallIcon(R.drawable.ic_notification)
            .setColor(ACCENT)
            .setContentTitle(p.title.ifEmpty { p.pane })
            .setContentText(text)
            .setSubText(p.host)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setOngoing(true)
            .setSilent(true)
            .setOnlyAlertOnce(true)
            .setShowWhen(true)
            .setWhen(if (p.since > 0) p.since else System.currentTimeMillis())
            .setUsesChronometer(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_PROGRESS)
            .setGroup(p.pane)
            .setContentIntent(openPaneIntent(context, p.pane))
            .addExtras(Bundle().apply { putString(EXTRA_PANE, p.pane) })
            .build()
        nm.notify(statusId(p.pane), n)
    }

    /** Replaces a pane's approval (or, with [id]/[channel], its finished) notification with a progress/outcome line. */
    fun showOutcome(context: Context, pane: String, promptId: String, title: String, text: String, ongoing: Boolean = false, id: Int = notificationId(pane), channel: String = CHANNEL_APPROVALS) {
        if (!hasPermission(context)) return
        val extras = Bundle().apply {
            putString(EXTRA_PANE, pane)
            // Outcomes are informational; no prompt_id so stale cleanup leaves them until they time out.
        }
        val n = NotificationCompat.Builder(context, channel)
            .setSmallIcon(R.drawable.ic_notification)
            .setColor(ACCENT)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setOngoing(ongoing)
            .setAutoCancel(!ongoing)
            .setGroup(pane)
            .setTimeoutAfter(if (ongoing) APPROVAL_TIMEOUT_MS else OUTCOME_TIMEOUT_MS)
            .setContentIntent(openPaneIntent(context, pane))
            .addExtras(extras)
            .build()
        context.getSystemService(NotificationManager::class.java).notify(id, n)
    }

    /** Cancels approval notifications whose prompt is no longer in the live snapshot. */
    fun cancelStale(context: Context, livePromptIds: Set<String>) {
        val nm = context.getSystemService(NotificationManager::class.java)
        for (sbn in nm.activeNotifications) {
            val promptId = sbn.notification.extras?.getString(EXTRA_PROMPT_ID) ?: continue
            if (promptId !in livePromptIds) nm.cancel(sbn.id)
        }
    }

    /** The user opened the pane in the app: its approval, finished and outcome notifications are read. The ongoing "working" one stays. */
    fun cancelForPane(context: Context, pane: String) {
        val nm = context.getSystemService(NotificationManager::class.java)
        for (sbn in nm.activeNotifications) {
            if (sbn.notification.channelId == CHANNEL_STATUS) continue
            if (sbn.notification.extras?.getString(EXTRA_PANE) == pane) nm.cancel(sbn.id)
        }
    }

    /** Ongoing "working" notifications of panes that are no longer working or blocked (or gone) come down with the live snapshot. */
    fun reconcileStatus(context: Context, live: Map<String, String>) {
        val nm = context.getSystemService(NotificationManager::class.java)
        for (sbn in nm.activeNotifications) {
            if (sbn.notification.channelId != CHANNEL_STATUS) continue
            val pane = sbn.notification.extras?.getString(EXTRA_PANE) ?: continue
            val status = live[pane]
            if (status != AgentStatus.WORKING && status != AgentStatus.BLOCKED) nm.cancel(sbn.id)
        }
    }

    /** Removes every ongoing "working" notification (the setting was turned off). */
    fun cancelStatus(context: Context) {
        val nm = context.getSystemService(NotificationManager::class.java)
        for (sbn in nm.activeNotifications) if (sbn.notification.channelId == CHANNEL_STATUS) nm.cancel(sbn.id)
    }

    fun cancelAll(context: Context) = context.getSystemService(NotificationManager::class.java).cancelAll()

    private fun openPaneIntent(context: Context, pane: String): PendingIntent {
        val intent = Intent(context, MainActivity::class.java)
            .putExtra(EXTRA_PANE, pane)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        return PendingIntent.getActivity(context, notificationId(pane), intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    private fun approvalAction(context: Context, p: PushPayload, action: String, label: String, unlock: Boolean, typed: String? = null): NotificationCompat.Action {
        val intent = Intent(context, NotificationActionReceiver::class.java)
            .setAction("com.inferenceaftermath.remotly.APPROVAL_$action")
            .putExtra(EXTRA_KIND, KIND_APPROVAL)
            .putExtra(EXTRA_PANE, p.pane)
            .putExtra(EXTRA_PROMPT_ID, p.promptId)
            .putExtra(EXTRA_AGENT, p.agent)
            .putExtra(EXTRA_ACTION, action)
            .putExtra(EXTRA_TITLE, p.title)
        return action(context, intent, (p.pane + p.promptId + action).hashCode(), label, unlock, typed)
    }

    private fun replyAction(context: Context, p: PushPayload, hint: String, unlock: Boolean): NotificationCompat.Action {
        val intent = Intent(context, NotificationActionReceiver::class.java)
            .setAction("com.inferenceaftermath.remotly.REPLY")
            .putExtra(EXTRA_KIND, KIND_REPLY)
            .putExtra(EXTRA_PANE, p.pane)
            .putExtra(EXTRA_AGENT, p.agent)
            .putExtra(EXTRA_TITLE, p.title)
        return action(context, intent, "reply:${p.pane}".hashCode(), context.getString(R.string.action_reply), unlock, hint)
    }

    /** A text action needs a mutable PendingIntent (the system fills the RemoteInput in). */
    private fun action(context: Context, intent: Intent, requestCode: Int, label: String, unlock: Boolean, typed: String?): NotificationCompat.Action {
        val mutability = if (typed != null) PendingIntent.FLAG_MUTABLE else PendingIntent.FLAG_IMMUTABLE
        val pi = PendingIntent.getBroadcast(context, requestCode, intent, mutability or PendingIntent.FLAG_UPDATE_CURRENT)
        return NotificationCompat.Action.Builder(0, label, pi).apply {
            if (typed != null) addRemoteInput(RemoteInput.Builder(KEY_TEXT).setLabel(typed).build())
            setAllowGeneratedReplies(false)
            setAuthenticationRequired(unlock)
        }.build()
    }
}

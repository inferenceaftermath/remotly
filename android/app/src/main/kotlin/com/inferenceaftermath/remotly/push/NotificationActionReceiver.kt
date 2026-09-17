package com.inferenceaftermath.remotly.push

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.RemoteInput

/** Notification action tap (Approve / Deny / Deny + feedback / Reply): show "Sending…" at once, then let the service do the network work. */
class NotificationActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val pane = intent.getStringExtra(Notifications.EXTRA_PANE) ?: return
        val kind = intent.getStringExtra(Notifications.EXTRA_KIND) ?: Notifications.KIND_APPROVAL
        val title = intent.getStringExtra(Notifications.EXTRA_TITLE) ?: "Remotly"
        // RemoteInput results travel in the intent's clip data, which `putExtras` would drop: copy the text over.
        val typed = RemoteInput.getResultsFromIntent(intent)?.getCharSequence(Notifications.KEY_TEXT)?.toString()?.trim()
        val work = Intent(context, NotificationActionService::class.java).putExtras(intent)
        if (typed != null) work.putExtra(Notifications.KEY_TEXT, typed)
        val reply = kind == Notifications.KIND_REPLY
        val id = if (reply) Notifications.doneId(pane) else Notifications.notificationId(pane)
        val channel = if (reply) Notifications.CHANNEL_DONE else Notifications.CHANNEL_APPROVALS
        val promptId = intent.getStringExtra(Notifications.EXTRA_PROMPT_ID) ?: ""
        if (reply) {
            if (typed.isNullOrEmpty()) {
                Notifications.showOutcome(context, pane, promptId, title, "Nothing to send", id = id, channel = channel)
                return
            }
            Notifications.showOutcome(context, pane, promptId, title, "Sending reply…", ongoing = true, id = id, channel = channel)
        } else {
            val action = intent.getStringExtra(Notifications.EXTRA_ACTION) ?: return
            Notifications.showOutcome(context, pane, promptId, title, "Sending ${NotificationActionService.describe(action)}…", ongoing = true)
        }
        try {
            // Executing a notification PendingIntent puts the app on the temporary allowlist, so this is permitted.
            context.startService(work)
        } catch (e: IllegalStateException) {
            Notifications.showOutcome(context, pane, promptId, title, "Could not start: open Remotly and answer there", id = id, channel = channel)
        }
    }
}

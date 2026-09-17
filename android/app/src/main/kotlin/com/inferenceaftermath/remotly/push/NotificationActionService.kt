// Short-lived `mode:"action"` connection for a notification action: hello → one request → wait for the
// outcome → update the notification. Approvals send `approve` and wait ≤ 20 s for `approval.result`;
// replies send `prompt` (armed for the next "finished" alert when that setting is on). Runs as a started
// service so it outlives the broadcast receiver.
package com.inferenceaftermath.remotly.push

import android.app.Service
import android.content.Intent
import android.os.IBinder
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import com.inferenceaftermath.remotly.FlowApplication
import com.inferenceaftermath.remotly.core.connection.ConnectionState
import com.inferenceaftermath.remotly.core.connection.FlowConnection
import com.inferenceaftermath.remotly.core.connection.FlowException
import com.inferenceaftermath.remotly.core.protocol.ApprovalAction
import com.inferenceaftermath.remotly.core.protocol.ApprovalResult
import com.inferenceaftermath.remotly.core.protocol.Outcome

class NotificationActionService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent == null) {
            stopSelf(startId)
            return START_NOT_STICKY
        }
        val pane = intent.getStringExtra(Notifications.EXTRA_PANE)
        val kind = intent.getStringExtra(Notifications.EXTRA_KIND) ?: Notifications.KIND_APPROVAL
        val title = intent.getStringExtra(Notifications.EXTRA_TITLE) ?: "Remotly"
        val typed = intent.getStringExtra(Notifications.KEY_TEXT)
        if (pane == null) {
            stopSelf(startId)
            return START_NOT_STICKY
        }
        if (kind == Notifications.KIND_REPLY) {
            scope.launch {
                val text = runCatching { reply(pane, typed ?: "") }.getOrElse { "Failed: ${it.message ?: it.javaClass.simpleName}" }
                Notifications.showOutcome(this@NotificationActionService, pane, "", title, text, id = Notifications.doneId(pane), channel = Notifications.CHANNEL_DONE)
                stopSelf(startId)
            }
            return START_NOT_STICKY
        }
        val promptId = intent.getStringExtra(Notifications.EXTRA_PROMPT_ID)
        val action = intent.getStringExtra(Notifications.EXTRA_ACTION)
        if (promptId == null || action == null) {
            stopSelf(startId)
            return START_NOT_STICKY
        }
        scope.launch {
            val text = runCatching { approve(pane, promptId, action, typed) }.getOrElse { "Failed: ${it.message ?: it.javaClass.simpleName}" }
            Notifications.showOutcome(this@NotificationActionService, pane, promptId, title, text)
            stopSelf(startId)
        }
        return START_NOT_STICKY
    }

    /** Connects in action mode and runs [block]; connection problems become user-facing lines. */
    private suspend fun withConnection(block: suspend (FlowConnection) -> String): String {
        val app = FlowApplication.of(this)
        val host = app.session.currentHost() ?: return "Not paired: open Remotly to pair with the host"
        val conn = FlowConnection(host, app.session.clientInfo, FlowConnection.MODE_ACTION, scope)
        try {
            conn.start()
            val state = withTimeoutOrNull(CONNECT_TIMEOUT_MS) {
                conn.state.first { it is ConnectionState.Connected || it is ConnectionState.Unpaired }
            } ?: return "Host unreachable (is Tailscale on?). Open Remotly to retry"
            if (state is ConnectionState.Unpaired) return "This phone is no longer paired; open Remotly to pair again"
            return block(conn)
        } finally {
            conn.stop()
        }
    }

    private suspend fun approve(pane: String, promptId: String, action: String, feedback: String?): String = withConnection { conn ->
        // Subscribe before sending so the result cannot slip past (no replay on the flow).
        val result = scope.async(start = CoroutineStart.UNDISPATCHED) { conn.approvals.first { it.prompt_id == promptId } }
        try {
            conn.approve(pane, promptId, action, feedback?.takeIf { it.isNotBlank() })
        } catch (e: Exception) {
            result.cancel()
            return@withConnection "Bridge refused: " + refusal(e)
        }
        val r = withTimeoutOrNull(RESULT_TIMEOUT_MS) { result.await() } ?: return@withConnection "No confirmation from the host yet"
        describe(action, r)
    }

    private suspend fun reply(pane: String, text: String): String {
        if (text.isBlank()) return "Nothing to send"
        val notify = FlowApplication.of(this).session.notifyOnPrompt.value
        return withConnection { conn ->
            try {
                conn.prompt(pane, text, notify)
            } catch (e: Exception) {
                return@withConnection "Bridge refused: " + refusal(e)
            }
            if (notify) "Reply sent · you'll be told when it's done" else "Reply sent"
        }
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    companion object {
        const val CONNECT_TIMEOUT_MS = 15_000L
        const val RESULT_TIMEOUT_MS = 20_000L

        private fun refusal(e: Exception): String = (e as? FlowException)?.let { "${it.code}: ${it.message}" } ?: (e.message ?: "error")

        fun describe(action: String): String = when (action) {
            ApprovalAction.APPROVE -> "approval"
            ApprovalAction.APPROVE_SESSION -> "approval for the session"
            ApprovalAction.DENY -> "denial"
            ApprovalAction.DENY_FEEDBACK -> "denial with feedback"
            ApprovalAction.INTERRUPT -> "interrupt"
            else -> action
        }

        fun describe(action: String, r: ApprovalResult): String {
            val what = describe(action).replaceFirstChar { it.uppercase() }
            return when (r.outcome) {
                Outcome.SENT -> "$what sent" + (r.status_after?.let { " · agent now $it" } ?: "")
                Outcome.STALE -> "Too late: the prompt has changed since this notification"
                Outcome.NOT_BLOCKED -> "The agent is no longer waiting for approval"
                Outcome.SIGNATURE_MISMATCH -> "Screen did not look like a prompt; open Remotly to confirm"
                Outcome.FAILED -> "Failed" + (r.detail?.let { ": $it" } ?: "")
                else -> "${r.outcome}" + (r.detail?.let { ": $it" } ?: "")
            }
        }
    }
}

// FCM data-only payload (shared/protocol/remotly-protocol.md §9): every value is a string. Three kinds:
// `approval` (the pane blocked on a dialog), `done` (an agent this device armed has finished) and
// `status` (every status change of a pane, for the ongoing "working" notification).
package com.inferenceaftermath.remotly.core.push

import com.inferenceaftermath.remotly.core.protocol.ApprovalDetails
import com.inferenceaftermath.remotly.core.protocol.Codec

data class PushPayload(
    val v: Int,
    val type: String,
    val host: String,
    val pane: String,
    val promptId: String,
    val agent: String,
    val title: String,
    val subtitle: String,
    val body: String,
    /** `approval`: the parsed dialog, when the bridge could read one. */
    val approval: ApprovalDetails? = null,
    /** `status` only. */
    val displayAgent: String = "",
    val status: String = "",
    /** `status`: when the agent started this stretch of work (ms since epoch); 0 when absent. */
    val since: Long = 0,
    /** `status`: one line about the pending approval while blocked. */
    val detail: String = "",
    /** `status` while blocked: `permission` or `choice` (a menu: the notification says "Has a question"). */
    val kind: String = "",
) {
    val isApproval: Boolean get() = type == TYPE_APPROVAL && promptId.isNotEmpty()
    val isDone: Boolean get() = type == TYPE_DONE
    val isStatus: Boolean get() = type == TYPE_STATUS && status.isNotEmpty()

    companion object {
        const val TYPE_APPROVAL = "approval"
        const val TYPE_DONE = "done"
        const val TYPE_STATUS = "status"

        fun parse(data: Map<String, String>): PushPayload? {
            val pane = data["pane"]?.trim()?.takeIf { it.isNotEmpty() } ?: return null
            val type = data["type"]?.trim()?.takeIf { it.isNotEmpty() } ?: return null
            val fallback = when (type) {
                TYPE_APPROVAL -> "Approval needed"
                TYPE_DONE -> "Finished"
                else -> ""
            }
            return PushPayload(
                v = data["v"]?.toIntOrNull() ?: 1,
                type = type,
                host = data["host"] ?: "",
                pane = pane,
                promptId = data["prompt_id"] ?: "",
                agent = data["agent"] ?: "",
                title = data["title"]?.takeIf { it.isNotBlank() } ?: fallback,
                subtitle = data["subtitle"] ?: "",
                body = data["body"]?.takeIf { it.isNotBlank() } ?: fallback,
                approval = data["approval"]?.let { runCatching { Codec.json.decodeFromString(ApprovalDetails.serializer(), it) }.getOrNull() },
                displayAgent = data["display_agent"] ?: "",
                status = data["status"] ?: "",
                since = data["since"]?.toLongOrNull() ?: 0L,
                detail = data["detail"] ?: "",
                kind = data["kind"] ?: "",
            )
        }
    }
}

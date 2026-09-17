// Wire models for Remotly protocol v1 (shared/protocol/remotly-protocol.md). Property names are the
// exact wire field names. Server messages are decoded polymorphically on the "t" discriminator.
package com.inferenceaftermath.remotly.core.protocol

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive

const val PROTOCOL_VERSION = 1

/** WebSocket close code the bridge uses for auth failures; clients must re-pair, not retry. */
const val CLOSE_UNAUTHORIZED = 4401

object ErrorCodes {
    const val AUTH = "auth"
    const val BAD_REQUEST = "bad_request"
    const val UNKNOWN_PANE = "unknown_pane"
    const val NOT_WATCHING = "not_watching"
    const val HERDR_DOWN = "herdr_down"
    const val HERDR_ERROR = "herdr_error"
    const val UNSUPPORTED_AGENT = "unsupported_agent"
    const val INVALID_KEY = "invalid_key"
    const val UNSUPPORTED = "unsupported"
    const val FIT_UNAVAILABLE = "fit_unavailable"
    // Client-side only.
    const val DISCONNECTED = "disconnected"
    const val TIMEOUT = "timeout"
}

object AgentStatus {
    const val IDLE = "idle"
    const val WORKING = "working"
    const val BLOCKED = "blocked"
    const val DONE = "done"
    const val UNKNOWN = "unknown"
}

object ApprovalAction {
    const val APPROVE = "approve"
    const val APPROVE_SESSION = "approve_session"
    const val DENY = "deny"
    const val DENY_FEEDBACK = "deny_feedback"
    const val INTERRUPT = "interrupt"
}

object Outcome {
    const val SENT = "sent"
    const val STALE = "stale"
    const val NOT_BLOCKED = "not_blocked"
    const val SIGNATURE_MISMATCH = "signature_mismatch"
    /** `choose`: the menu on screen no longer matches what the phone showed; nothing was sent. */
    const val DIALOG_CHANGED = "dialog_changed"
    const val FAILED = "failed"
}

// ---------------------------------------------------------------- frame pieces

/** fg/bg: "d" (default), "p<n>" (palette 0–255) or "#rrggbb". `a` is the attribute bitmask. */
@Serializable
data class Style(val fg: String = "d", val bg: String = "d", val a: Int = 0) {
    val bold get() = a and BOLD != 0
    val dim get() = a and DIM != 0
    val italic get() = a and ITALIC != 0
    val underline get() = a and UNDERLINE != 0
    val inverse get() = a and INVERSE != 0
    val strikethrough get() = a and STRIKETHROUGH != 0
    val blink get() = a and BLINK != 0

    companion object {
        const val BOLD = 1
        const val DIM = 2
        const val ITALIC = 4
        const val UNDERLINE = 8
        const val INVERSE = 16
        const val STRIKETHROUGH = 32
        const val BLINK = 64
        val DEFAULT = Style()
    }
}

/** A run covers `w` cells from column `c`: narrow characters (one cell each) or one wide grapheme (`w == 2`). */
@Serializable
data class WireRun(val c: Int, val w: Int, val s: Int = 0, val t: String)

/** Frame rows carry `y`; history lines do not (y defaults to 0 and is ignored there). */
@Serializable
data class WireLine(val y: Int = 0, val runs: List<WireRun> = emptyList())

// ---------------------------------------------------------------- server → client

@Serializable
sealed interface ServerMessage

@Serializable
data class HostInfo(
    val name: String = "",
    val herdr_version: String? = null,
    val herdr_protocol: Int? = null,
    val flow_version: String? = null,
)

@Serializable
data class DeviceRef(val id: String = "", val name: String = "")

@Serializable
@SerialName("welcome")
data class Welcome(
    val protocol: Int = PROTOCOL_VERSION,
    val host: HostInfo = HostInfo(),
    val device: DeviceRef = DeviceRef(),
    val snapshot: Snapshot? = null,
    /** Panes this device asked to be told about when the agent finishes. */
    val notify_done: List<String> = emptyList(),
) : ServerMessage

@Serializable
data class Workspace(val id: String, val name: String = "")

@Serializable
data class Tab(val id: String, val workspace_id: String = "", val name: String = "")

/** The bridge's structured reading of the agent's approval dialog (§6 `approval`); present only while blocked and parsed. */
@Serializable
data class ApprovalDetails(
    val tool: String? = null,
    val command: String? = null,
    val path: String? = null,
    val description: String? = null,
    val question: String = "",
    val options: List<String> = emptyList(),
    /** 1-based index of the option carrying the desktop's selection marker, when visible. */
    val selected: Int? = null,
    /** `permission` (a tool about to run: yes/no) or `choice` (AskUserQuestion menus, pickers). */
    val kind: String = "permission",
) {
    val isChoice: Boolean get() = kind == "choice"

    /** `Bash: npm test` / `Edit: src/a.ts` / the question. */
    val headline: String get() {
        val what = command ?: path ?: return question
        return if (tool != null) "$tool: $what" else what
    }
}

@Serializable
data class PaneInfo(
    val id: String,
    val tab_id: String = "",
    val workspace_id: String = "",
    val title: String = "",
    val agent: String? = null,
    val display_agent: String? = null,
    val agent_status: String = AgentStatus.UNKNOWN,
    val state_label: String? = null,
    val cwd: String? = null,
    val focused: Boolean = false,
    val prompt_id: String? = null,
    val approval: ApprovalDetails? = null,
    /** Ms since the epoch when the agent began its current stretch of work (working, carried through blocked); null otherwise or from an older bridge. */
    val since: Long? = null,
) {
    val isBlocked get() = agent_status == AgentStatus.BLOCKED
    /** A coding agent runs here (herdr names it by id and/or display name); false for a plain shell. */
    val hasAgent get() = !agent.isNullOrEmpty() || !display_agent.isNullOrEmpty()
}

/** Used both as a top-level `snapshot` message and embedded (without `t`) in `welcome`. */
@Serializable
@SerialName("snapshot")
data class Snapshot(
    val workspaces: List<Workspace> = emptyList(),
    val tabs: List<Tab> = emptyList(),
    val panes: List<PaneInfo> = emptyList(),
    val focused_pane_id: String? = null,
) : ServerMessage {
    fun pane(id: String): PaneInfo? = panes.firstOrNull { it.id == id }

    /** Returns a snapshot with the pane's live fields replaced from a `pane.status` event. */
    fun applyStatus(s: PaneStatus): Snapshot = copy(
        panes = panes.map { p ->
            if (p.id != s.pane) p else p.copy(
                title = s.title ?: p.title,
                agent = s.agent,
                display_agent = s.display_agent,
                agent_status = s.agent_status,
                state_label = s.state_label,
                prompt_id = if (s.agent_status == AgentStatus.BLOCKED) s.prompt_id else null,
                approval = if (s.agent_status == AgentStatus.BLOCKED) s.approval else null,
                since = s.since,
            )
        },
    )
}

@Serializable
@SerialName("pane.status")
data class PaneStatus(
    val pane: String,
    val agent_status: String = AgentStatus.UNKNOWN,
    val agent: String? = null,
    val display_agent: String? = null,
    /** The cleaned pane title; empty when it was only a status glyph (the apps fall back to the cwd basename, then the id). Null only from a bridge that sent none. */
    val title: String? = null,
    val state_label: String? = null,
    val prompt_id: String? = null,
    val approval: ApprovalDetails? = null,
    val since: Long? = null,
) : ServerMessage

/** The bridge changed this device's "tell me when it's done" arming itself (the alert fired). */
@Serializable
@SerialName("notify.state")
data class NotifyState(val pane: String, val done: Boolean) : ServerMessage

@Serializable
@SerialName("frame")
data class Frame(
    val pane: String,
    val rev: Long = 0,
    val cols: Int,
    val rows: Int,
    val full: Boolean = false,
    val lines: List<WireLine> = emptyList(),
    val styles: Map<String, Style> = emptyMap(),
    /** True while an alternate-screen program (Claude Code, vim, tmux, less) is in the pane's foreground; null until the bridge knows. */
    val alt: Boolean? = null,
) : ServerMessage

@Serializable
@SerialName("history")
data class HistoryMessage(
    val id: String,
    val pane: String = "",
    val lines: List<WireLine> = emptyList(),
    val styles: Map<String, Style> = emptyMap(),
    val has_more: Boolean = false,
    /** Lines herdr holds above the screen; 0 means nothing older exists (alternate-screen program or a fresh shell). Null from an older bridge. */
    val scrollback: Int? = null,
) : ServerMessage

@Serializable
@SerialName("approval.result")
data class ApprovalResult(
    val pane: String,
    val prompt_id: String = "",
    val outcome: String,
    val detail: String? = null,
    val status_after: String? = null,
) : ServerMessage

@Serializable
@SerialName("herdr")
data class HerdrMessage(val state: String) : ServerMessage {
    val isUp get() = state == "up"
}

/** `ok` plus the optional result fields of `watch` (`cols`, `rows`) and `zoom` (`zoomed`). */
@Serializable
@SerialName("ok")
data class OkMessage(
    val id: String,
    val cols: Int? = null,
    val rows: Int? = null,
    val zoomed: Boolean? = null,
    /** `pane.create` → the new pane's id and its tab. */
    val pane: String? = null,
    val tab: String? = null,
    /** `notify` → the arming now in force. */
    val done: Boolean? = null,
) : ServerMessage

@Serializable
@SerialName("error")
data class ErrorMessage(
    val id: String? = null,
    val code: String,
    val message: String = "",
) : ServerMessage

// ---------------------------------------------------------------- client → server

@Serializable
sealed interface ClientMessage

@Serializable
data class ClientInfo(val platform: String, val app_version: String, val device_name: String)

@Serializable
@SerialName("hello")
data class Hello(val token: String, val client: ClientInfo, val mode: String = "full") : ClientMessage

@Serializable
@SerialName("watch")
/** `zoom = true`: the bridge zooms the pane on the desktop while this device watches it (§4 `watch {zoom:true}`); omitted otherwise. */
data class Watch(val id: String, val pane: String, val zoom: Boolean? = null) : ClientMessage

@Serializable
@SerialName("unwatch")
data class Unwatch(val id: String, val pane: String) : ClientMessage

@Serializable
@SerialName("history")
data class History(val id: String, val pane: String, val lines: Int, val unwrapped: Boolean? = null) : ClientMessage

@Serializable
@SerialName("keys")
data class Keys(val id: String, val pane: String, val keys: List<String>) : ClientMessage

/** New terminal (herdr tab) on the desktop, optionally running `command` (§4 `pane.create`). */
@Serializable
@SerialName("pane.create")
data class PaneCreate(val id: String, val label: String? = null, val command: String? = null) : ClientMessage

/** Close the pane on the desktop: its shell and whatever runs in it end (§4 `pane.close`). */
@Serializable
@SerialName("pane.close")
data class PaneClose(val id: String, val pane: String) : ClientMessage

/** Touch scrolling forwarded to the program: `wheel` = SGR mouse-wheel reports, `arrows` = Up/Down keys (§4 `scroll`). */
@Serializable
@SerialName("scroll")
data class Scroll(
    val id: String,
    val pane: String,
    val direction: String,
    val lines: Int? = null,
    val mode: String? = null,
    val col: Int? = null,
    val row: Int? = null,
) : ClientMessage

@Serializable
@SerialName("text")
data class Text(val id: String, val pane: String, val text: String) : ClientMessage

/** `notify = true` arms "tell me when it's done" for this device before the text goes in (§4 `prompt`). */
@Serializable
@SerialName("prompt")
data class Prompt(val id: String, val pane: String, val text: String, val notify: Boolean? = null) : ClientMessage

/** Arm/disarm the "tell me when it's done" alert for this device on a pane (§4 `notify`). */
@Serializable
@SerialName("notify")
data class Notify(val id: String, val pane: String, val done: Boolean) : ClientMessage

/** Android: no fields — opt this device's FCM token into `status` messages (§4 `activity.register`). */
@Serializable
@SerialName("activity.register")
data class ActivityRegister(val id: String, val token: String? = null, val pane: String? = null) : ClientMessage

@Serializable
@SerialName("activity.unregister")
data class ActivityUnregister(val id: String, val pane: String? = null) : ClientMessage

@Serializable
@SerialName("approve")
data class Approve(
    val id: String,
    val pane: String,
    val prompt_id: String,
    val action: String,
    val feedback: String? = null,
    val force: Boolean? = null,
) : ClientMessage

/** Answer the dialog on screen by moving its cursor to `option` (1-based) and pressing Enter; `label` guards against a changed menu. */
@Serializable
@SerialName("choose")
data class Choose(val id: String, val pane: String, val prompt_id: String, val option: Int, val label: String) : ClientMessage

@Serializable
@SerialName("zoom")
data class Zoom(val id: String, val pane: String, val mode: String = "toggle") : ClientMessage

/** Resize the pane's PTY on the desktop to this device's grid; `release = true` gives it back (§4 `fit`). */
@Serializable
@SerialName("fit")
data class Fit(val id: String, val pane: String, val cols: Int? = null, val rows: Int? = null, val release: Boolean? = null) : ClientMessage

/** `pane` is a string or an explicit JSON `null` (never omitted), hence the JsonElement. */
@Serializable
@SerialName("viewing")
data class Viewing(val pane: JsonElement = JsonNull, val id: String? = null) : ClientMessage {
    companion object {
        fun of(pane: String?, id: String? = null) = Viewing(if (pane == null) JsonNull else JsonPrimitive(pane), id)
    }
}

@Serializable
@SerialName("push.register")
data class PushRegister(val id: String, val platform: String, val token: String, val env: String? = null) : ClientMessage

@Serializable
@SerialName("push.unregister")
data class PushUnregister(val id: String) : ClientMessage

// ---------------------------------------------------------------- codec

object Codec {
    val json = Json {
        ignoreUnknownKeys = true
        explicitNulls = false
        encodeDefaults = true
        coerceInputValues = true
        classDiscriminator = "t"
    }

    /** Returns null for malformed JSON or an unknown `t` (the client ignores such messages). */
    fun decodeServer(text: String): ServerMessage? = try {
        json.decodeFromString(ServerMessage.serializer(), text)
    } catch (e: SerializationException) {
        null
    } catch (e: IllegalArgumentException) {
        null
    }

    fun encode(msg: ClientMessage): String = json.encodeToString(ClientMessage.serializer(), msg)
}

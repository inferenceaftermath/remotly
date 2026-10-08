package com.inferenceaftermath.remotly.core.demo

import com.inferenceaftermath.remotly.core.protocol.Codec
import kotlinx.serialization.json.*

/** An in-memory protocol peer. It has no network, filesystem writes, shell or upload capabilities.
 * Owned by one FlowConnection; all calls are serialized by that connection's lock. */
internal class DemoBridge {
    private val seed = Codec.json.parseToJsonElement(
        requireNotNull(javaClass.getResourceAsStream("/demo.json")).bufferedReader().use { it.readText() },
    ).jsonObject
    private val base = seed.getValue("snapshot").jsonObject
    private val panes = base.getValue("panes").jsonArray.map { it.jsonObject.toMutableMap() }.toMutableList()
    private val output = seed.getValue("lines").jsonObject.mapValues { (_, v) -> v.jsonArray.map { it.jsonPrimitive.content }.toMutableList() }.toMutableMap()
    private val input = mutableMapOf<String, String>()
    private val finishing = mutableMapOf<String, Int>()
    /** Lines trimmed off the front of each pane's output, so a line keeps its scrollback number. */
    private val trimmed = mutableMapOf<String, Int>()
    /** Per pane, the number of the next scrollback line the phone has not been sent. */
    private val sent = mutableMapOf<String, Int>()
    /** The pane whose new scrollback lines are pushed (the last `scrollback` request, until another pane is watched). */
    private var scrollbackPane: String? = null
    private var watched: String? = null
    private var cols = 80
    private var rows = 24
    private var revision = 0
    private var sequence = 0
    private var ticks = 0

    fun welcome(): String {
        watched = null
        scrollbackPane = null
        return obj("t" to "welcome", "protocol" to 1,
            "host" to obj("name" to "Demo host", "flow_version" to "sample"),
            "device" to obj("id" to "demo-device", "name" to "This device"),
            "snapshot" to snapshot(), "notify_done" to emptyList<String>()).toString()
    }

    fun receive(text: String): List<String> {
        val m = Codec.json.parseToJsonElement(text).jsonObject
        val type = m.string("t")
        val id = m.string("id")
        val pane = m.string("pane")
        fun ok(vararg fields: Pair<String, Any?>) = obj("t" to "ok", "id" to id, *fields)
        fun error(code: String, message: String) = listOf(obj("t" to "error", "id" to id, "code" to code, "message" to message).toString())
        if (type == "viewing") return emptyList()
        if (type == "pane.create") {
            if (panes.size >= 12) return error("bad_request", "Demo supports up to 12 sample terminals. Exit and re-enter to reset.")
            val newId = "demo-new-${++sequence}"
            panes += obj("id" to newId, "tab_id" to "demo-tab", "workspace_id" to "demo-workspace",
                "title" to clean(m.string("label")).ifBlank { "Sample terminal" }, "agent_status" to "idle", "cwd" to "/sample/project").toMutableMap()
            output[newId] = mutableListOf("REMOTLY DEMO - SAMPLE DATA", "Commands are simulated, never executed.")
            if (m.string("command").isNotBlank()) submit(newId, m.string("command"))
            return listOf(ok("pane" to newId, "tab" to "demo-tab").toString(), snapshot().toString())
        }
        val p = panes.firstOrNull { it["id"]?.jsonPrimitive?.content == pane }
            ?: return error("unknown_pane", "Sample session is no longer available.")
        val events = mutableListOf<JsonObject>()
        when (type) {
            "watch" -> {
                watched = pane
                if (scrollbackPane != pane) scrollbackPane = null
                events += ok("cols" to cols, "rows" to rows); events += frame(pane)
            }
            "unwatch" -> { if (watched == pane) watched = null; if (scrollbackPane == pane) scrollbackPane = null; events += ok() }
            "scrollback" -> {
                // The sample lines that have left the screen, as one copy under one epoch, like the bridge's (§4 `scrollback`).
                val (base, lines) = copy(pane)
                val next = base + lines.size
                val from = m["from"]?.jsonPrimitive?.intOrNull
                val resume = m.string("epoch") == EPOCH && from != null && from in base..next
                val start = if (resume) from else base
                if (!resume || start < next) events += scrollback(pane, start, lines.subList(start - base, lines.size), reset = !resume)
                sent[pane] = next
                scrollbackPane = pane
                events += ok("epoch" to EPOCH, "next" to next, "max_lines" to MAX_LINES)
            }
            "fit" -> {
                cols = if (m["release"]?.jsonPrimitive?.booleanOrNull == true) 80 else (m["cols"]?.jsonPrimitive?.intOrNull ?: 80).coerceIn(20, 200)
                rows = if (m["release"]?.jsonPrimitive?.booleanOrNull == true) 24 else (m["rows"]?.jsonPrimitive?.intOrNull ?: 24).coerceIn(5, 100)
                events += ok("cols" to cols, "rows" to rows)
                if (watched == pane) events += frame(pane)
            }
            "history" -> {
                val all = wrapped(pane)
                val count = (m["lines"]?.jsonPrimitive?.intOrNull ?: 100).coerceIn(1, 999)
                events += obj("t" to "history", "id" to id, "pane" to pane,
                    "lines" to all.takeLast(count).map { obj("runs" to runs(it)) }, "styles" to styles(),
                    "has_more" to (all.size > count), "scrollback" to maxOf(0, all.size - rows))
            }
            "pane.close" -> {
                panes.remove(p); output.remove(pane); input.remove(pane); finishing.remove(pane); trimmed.remove(pane); sent.remove(pane)
                if (watched == pane) watched = null
                if (scrollbackPane == pane) scrollbackPane = null
                events += ok(); events += snapshot()
            }
            "approve", "choose" -> {
                val prompt = m.string("prompt_id")
                val approval = p["approval"]?.jsonObject
                var outcome = "sent"
                if (p["prompt_id"]?.jsonPrimitive?.content != prompt) outcome = "stale"
                else if (type == "choose") {
                    val options = approval?.get("options")?.jsonArray ?: JsonArray(emptyList())
                    val option = m["option"]?.jsonPrimitive?.intOrNull ?: 0
                    if (option !in 1..options.size || options[option - 1].jsonPrimitive.content != m.string("label")) outcome = "dialog_changed"
                } else if ((approval?.string("kind") == "choice" && m.string("action") !in listOf("deny_feedback", "interrupt")) || m.string("action") !in listOf("approve", "approve_session", "deny", "deny_feedback", "interrupt")) outcome = "dialog_changed"
                if (outcome == "sent") {
                    val answer = if (type == "choose") m.string("label") else m.string("action")
                    append(pane, "Sample response: $answer")
                    if (m.string("feedback").isNotBlank()) append(pane, "Sample feedback: ${m.string("feedback")}")
                    if ((type == "approve" && m.string("action") in listOf("deny", "deny_feedback", "interrupt")) || (type == "choose" && approval?.string("kind") == "permission" && m["option"]?.jsonPrimitive?.intOrNull == 3)) {
                        append(pane, "Sample request denied. No command was run.")
                        setStatus(pane, "idle"); finishing.remove(pane)
                    } else { setStatus(pane, "working"); finishing[pane] = ticks + 5 }
                }
                events += ok()
                events += obj("t" to "approval.result", "pane" to pane, "prompt_id" to prompt, "outcome" to outcome)
                events += snapshot()
                if (watched == pane) events += frame(pane)
            }
            "prompt", "text", "keys" -> {
                if (type == "prompt") submit(pane, m.string("text"))
                if (type == "text") input[pane] = clean((input[pane] ?: "") + m.string("text"))
                if (type == "keys") for (key in m["keys"]?.jsonArray.orEmpty().map { it.jsonPrimitive.content }) {
                    when (key) {
                        "enter" -> { submit(pane, input.remove(pane) ?: ""); input.remove(pane) }
                        "backspace" -> input[pane] = (input[pane] ?: "").dropLast(1)
                        "ctrl+c", "esc" -> { finishing.remove(pane); input.remove(pane); setStatus(pane, "idle"); append(pane, "Sample input cancelled.") }
                        else -> append(pane, "Sample key: $key")
                    }
                }
                events += ok(); events += snapshot()
                if (watched == pane) events += frame(pane)
            }
            "zoom" -> events += ok("zoomed" to (m.string("mode") != "off"))
            "scroll" -> events += ok()
            else -> return error("unsupported", "This feature needs a paired host and is unavailable in demo mode.")
        }
        events += newScrollback()
        return events.map { it.toString() }
    }

    /** Called every 200 ms while connected; tests advance this clock without sleeping. */
    fun tick(): List<String> {
        ticks++
        val events = mutableListOf<JsonObject>()
        for (pane in finishing.filterValues { it <= ticks }.keys.sorted()) {
            finishing.remove(pane)
            append(pane, "Simulated result: 3 tests passed. No commands were executed.")
            setStatus(pane, "done")
            events += snapshot()
            if (watched == pane) events += frame(pane)
        }
        events += newScrollback()
        return events.map { it.toString() }
    }

    private fun submit(pane: String, text: String) {
        append(pane, "> ${clean(text)}")
        append(pane, "Simulating a sample response...")
        input.remove(pane)
        setStatus(pane, "working")
        finishing[pane] = ticks + 5
    }
    private fun setStatus(pane: String, status: String) {
        panes.firstOrNull { it["id"]?.jsonPrimitive?.content == pane }?.let {
            it["agent_status"] = JsonPrimitive(status); it.remove("prompt_id"); it.remove("approval")
        }
    }
    private fun append(pane: String, text: String) {
        output.getOrPut(pane) { mutableListOf() }.let { lines ->
            lines += clean(text).split('\n')
            while (lines.size > 200) { lines.removeAt(0); trimmed[pane] = (trimmed[pane] ?: 0) + 1 }
        }
    }
    /**
     * The pane's scrollback copy: the number of its first line and its lines, the output lines wholly above the screen
     * (and any sent before that a wider screen has taken back: the copy never shrinks, as on the bridge).
     */
    private fun copy(pane: String): Pair<Int, List<String>> {
        val lines = output[pane].orEmpty()
        fun rowsOf(line: String) = line.split('\n').sumOf { maxOf(1, (it.length + cols - 1) / cols) }
        var screen = rows - (input[pane]?.let { rowsOf("> $it") } ?: 0)
        var end = lines.size
        while (end > 0 && screen > 0) screen -= rowsOf(lines[--end])
        val base = trimmed[pane] ?: 0
        end = maxOf(end, minOf(lines.size, (sent[pane] ?: 0) - base))
        return base to lines.subList(0, end)
    }

    /** Lines of the subscribed pane that left the screen since it was last sent some. */
    private fun newScrollback(): List<JsonObject> {
        val pane = scrollbackPane ?: return emptyList()
        val (base, lines) = copy(pane)
        val from = maxOf(sent[pane] ?: 0, base)
        if (base + lines.size <= from) return emptyList()
        sent[pane] = base + lines.size
        return listOf(scrollback(pane, from, lines.subList(from - base, lines.size), reset = false))
    }

    private fun scrollback(pane: String, start: Int, lines: List<String>, reset: Boolean): JsonObject = obj(
        "t" to "scrollback", "pane" to pane, "epoch" to EPOCH, "start" to start,
        "lines" to lines.map { obj("runs" to runs(it)) }, "styles" to styles(),
        *(if (reset) arrayOf<Pair<String, Any?>>("reset" to true) else emptyArray()),
    )

    private fun wrapped(pane: String): List<String> =
        (output[pane].orEmpty() + listOfNotNull(input[pane]?.let { "> $it" })).flatMap { it.split('\n') }.flatMap { it.chunked(cols).ifEmpty { listOf("") } }
    private fun frame(pane: String): JsonObject = obj("t" to "frame", "pane" to pane, "rev" to ++revision,
        "cols" to cols, "rows" to rows, "full" to true, "alt" to false,
        "lines" to wrapped(pane).takeLast(rows).mapIndexed { y, line -> obj("y" to y, "runs" to runs(line)) }, "styles" to styles())
    private fun snapshot() = JsonObject(base + ("panes" to JsonArray(panes.map { JsonObject(it) })))
    private fun styles() = obj("0" to obj("fg" to "d", "bg" to "d", "a" to 0))
    private fun runs(text: String) = if (text.isEmpty()) emptyList() else listOf(obj("c" to 0, "w" to text.length, "s" to 0, "t" to text))
    private fun clean(text: String) = text.take(2000).map { if (it == '\n' || it in ' '..'~') it else '?' }.joinToString("")
    private fun JsonObject.string(key: String) = this[key]?.jsonPrimitive?.contentOrNull ?: ""
    private fun obj(vararg entries: Pair<String, Any?>): JsonObject = JsonObject(entries.associate { it.first to json(it.second) })
    private fun json(value: Any?): JsonElement = when (value) {
        null -> JsonNull
        is JsonElement -> value
        is String -> JsonPrimitive(value)
        is Boolean -> JsonPrimitive(value)
        is Number -> JsonPrimitive(value)
        is List<*> -> JsonArray(value.map(::json))
        else -> error("Unsupported demo value")
    }

    private companion object {
        const val EPOCH = "demo"
        const val MAX_LINES = 10_000
    }
}

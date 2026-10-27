// What the pairing screen does with each QR the camera delivers (DESIGN.md §4.8). The camera reads a code that stays
// in view many times a second; a code whose pairing failed must not go out again on the next frame, or five frames hit
// the bridge's lockout (`pair.locked_out`, 15 minutes) before the error has even been read.
package com.inferenceaftermath.remotly.core.pairing

class ScanGate(private val foreignNoticeMs: Long = 2400) {
    sealed interface Decision {
        /** Send this code. The gate is in flight until [failed] or [succeeded]; every scan meanwhile is ignored. */
        data class Pair(val payload: QrPayload) : Decision

        /** Show the plain toast "Not a Remotly pairing code" (at most once per [foreignNoticeMs] while one is in view). */
        data object Notice : Decision

        data object Ignore : Decision
    }

    /** The scanned text whose pairing is in flight. */
    var inFlight: String? = null
        private set

    /** The failure shown over the viewfinder; null while scanning is live. Set by [failed], cleared by [resume] or a different code. */
    var paused: String? = null
        private set

    private var rejected: String? = null
    private var lastForeignAt: Long? = null

    /** The decision for one camera read of [text] at [nowMs] (any monotonic or wall clock in milliseconds). */
    fun scanned(text: String, nowMs: Long): Decision {
        if (inFlight != null || text == rejected) return Decision.Ignore
        val payload = QrPayload.parse(text)
        if (payload == null) {
            if (paused != null) return Decision.Ignore
            val last = lastForeignAt
            if (last != null && nowMs - last < foreignNoticeMs) return Decision.Ignore
            lastForeignAt = nowMs
            return Decision.Notice
        }
        inFlight = text
        rejected = null
        paused = null
        return Decision.Pair(payload)
    }

    /** The in-flight code was refused: it is not sent again while it stays in view, and [message] is shown until [resume]. */
    fun failed(message: String) {
        val code = inFlight ?: return
        rejected = code
        inFlight = null
        paused = message
    }

    fun succeeded() {
        inFlight = null
    }

    /** The user tapped the viewfinder: the code that failed may be scanned again. */
    fun resume() {
        rejected = null
        paused = null
    }
}

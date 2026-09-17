// OkHttp WebSocket client for the Remotly protocol: hello on open, request/reply by id, event flows,
// reconnect with 0.5 s → 10 s backoff (re-sending watch/viewing), no retry after close 4401.
package com.inferenceaftermath.remotly.core.connection

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import com.inferenceaftermath.remotly.core.pairing.FlowTls
import com.inferenceaftermath.remotly.core.protocol.ActivityRegister
import com.inferenceaftermath.remotly.core.protocol.ActivityUnregister
import com.inferenceaftermath.remotly.core.protocol.Approve
import com.inferenceaftermath.remotly.core.protocol.Choose
import com.inferenceaftermath.remotly.core.protocol.Notify
import com.inferenceaftermath.remotly.core.protocol.NotifyState
import com.inferenceaftermath.remotly.core.protocol.ApprovalResult
import com.inferenceaftermath.remotly.core.protocol.CLOSE_UNAUTHORIZED
import com.inferenceaftermath.remotly.core.protocol.ClientInfo
import com.inferenceaftermath.remotly.core.protocol.ClientMessage
import com.inferenceaftermath.remotly.core.protocol.Codec
import com.inferenceaftermath.remotly.core.protocol.ErrorCodes
import com.inferenceaftermath.remotly.core.protocol.ErrorMessage
import com.inferenceaftermath.remotly.core.protocol.Fit
import com.inferenceaftermath.remotly.core.protocol.PaneClose
import com.inferenceaftermath.remotly.core.protocol.PaneCreate
import com.inferenceaftermath.remotly.core.protocol.Scroll
import com.inferenceaftermath.remotly.core.protocol.Frame
import com.inferenceaftermath.remotly.core.protocol.Hello
import com.inferenceaftermath.remotly.core.protocol.HerdrMessage
import com.inferenceaftermath.remotly.core.protocol.History
import com.inferenceaftermath.remotly.core.protocol.HistoryMessage
import com.inferenceaftermath.remotly.core.protocol.Keys
import com.inferenceaftermath.remotly.core.protocol.OkMessage
import com.inferenceaftermath.remotly.core.protocol.PaneStatus
import com.inferenceaftermath.remotly.core.protocol.Prompt
import com.inferenceaftermath.remotly.core.protocol.PushRegister
import com.inferenceaftermath.remotly.core.protocol.PushUnregister
import com.inferenceaftermath.remotly.core.protocol.ServerMessage
import com.inferenceaftermath.remotly.core.protocol.Snapshot
import com.inferenceaftermath.remotly.core.protocol.Text
import com.inferenceaftermath.remotly.core.protocol.Unwatch
import com.inferenceaftermath.remotly.core.protocol.Viewing
import com.inferenceaftermath.remotly.core.protocol.Watch
import com.inferenceaftermath.remotly.core.protocol.Welcome
import com.inferenceaftermath.remotly.core.protocol.Zoom
import com.inferenceaftermath.remotly.core.terminal.StyleTable
import com.inferenceaftermath.remotly.core.terminal.TerminalGrid
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/** Paired host as stored on the device. `url` is the `wss://host:port` origin from the QR. */
data class HostConfig(
    val url: String,
    val token: String,
    val fingerprint: String? = null,
    val hostName: String = "",
    val deviceId: String = "",
) {
    val wsUrl: String get() = url.trimEnd('/') + "/ws"
}

sealed interface ConnectionState {
    data object Idle : ConnectionState
    data object Connecting : ConnectionState
    data class Connected(val welcome: Welcome) : ConnectionState
    data class Reconnecting(val attempt: Int, val delayMs: Long, val reason: String) : ConnectionState
    /** Close 4401 / `error auth`: the token is gone; the user must re-pair. Never retried. */
    data class Unpaired(val reason: String) : ConnectionState
}

class FlowException(val code: String, message: String) : Exception(message)

class FlowConnection(
    val host: HostConfig,
    private val client: ClientInfo,
    private val mode: String = MODE_FULL,
    private val scope: CoroutineScope,
    okHttp: OkHttpClient = FlowTls.client(host.fingerprint),
) {
    private val http = okHttp.newBuilder()
        .pingInterval(PING_INTERVAL_S, TimeUnit.SECONDS)
        .connectTimeout(10, TimeUnit.SECONDS)
        .build()
    private val ids = AtomicInteger()
    private val pending = ConcurrentHashMap<String, CompletableDeferred<ServerMessage>>()
    private val lock = Any()
    private var socket: WebSocket? = null
    private var reconnectJob: Job? = null
    private var backoffMs = INITIAL_BACKOFF_MS
    private var attempt = 0
    @Volatile private var stopped = true

    @Volatile var watchedPane: String? = null
    /** `zoom` flag of the current watch, re-sent with it after a reconnect. */
    @Volatile var watchZoom: Boolean = false
        private set
    @Volatile var viewingPane: String? = null
    /** (cols, rows) imposed on the watched pane via `fit`; re-sent after every reconnect. */
    @Volatile var fitSize: Pair<Int, Int>? = null
        private set

    /** Style ids are per connection; reset on every `welcome`. */
    val styles = StyleTable()

    private val _state = MutableStateFlow<ConnectionState>(ConnectionState.Idle)
    val state: StateFlow<ConnectionState> = _state.asStateFlow()
    private val _snapshot = MutableStateFlow<Snapshot?>(null)
    val snapshot: StateFlow<Snapshot?> = _snapshot.asStateFlow()
    private val _grid = MutableStateFlow<TerminalGrid?>(null)
    /** Grid of the watched pane, rebuilt on every frame. */
    val grid: StateFlow<TerminalGrid?> = _grid.asStateFlow()
    private val _paneAlt = MutableStateFlow<Boolean?>(null)
    /** Whether an alternate-screen program (Claude Code, vim, less) has the watched pane, from frames; null until the bridge has said. */
    val paneAlt: StateFlow<Boolean?> = _paneAlt.asStateFlow()
    private val _herdrUp = MutableStateFlow(true)
    val herdrUp: StateFlow<Boolean> = _herdrUp.asStateFlow()
    private val _paneStatus = events<PaneStatus>()
    val paneStatus: SharedFlow<PaneStatus> = _paneStatus.asSharedFlow()
    private val _frames = events<Frame>()
    val frames: SharedFlow<Frame> = _frames.asSharedFlow()
    private val _approvals = events<ApprovalResult>()
    val approvals: SharedFlow<ApprovalResult> = _approvals.asSharedFlow()
    private val _notifyState = events<NotifyState>()
    /** The bridge changed a "tell me when it's done" arming of this device (the alert fired). */
    val notifyState: SharedFlow<NotifyState> = _notifyState.asSharedFlow()
    private val _errors = events<ErrorMessage>()
    /** Errors without a request id (other than `auth`, which surfaces as `Unpaired`). */
    val errors: SharedFlow<ErrorMessage> = _errors.asSharedFlow()

    val isConnected: Boolean get() = _state.value is ConnectionState.Connected

    // ------------------------------------------------------------ lifecycle

    fun start() {
        synchronized(lock) {
            if (!stopped) return
            stopped = false
            backoffMs = INITIAL_BACKOFF_MS
            attempt = 0
        }
        connect()
    }

    fun stop() {
        synchronized(lock) {
            stopped = true
            reconnectJob?.cancel()
            reconnectJob = null
            socket?.close(1000, "bye")
            socket = null
        }
        failPending("stopped")
        if (_state.value !is ConnectionState.Unpaired) _state.value = ConnectionState.Idle
    }

    /** Skip the remaining backoff (network came back, app came to the foreground). */
    fun reconnectNow() {
        synchronized(lock) {
            if (stopped || socket != null) return
            reconnectJob?.cancel()
            reconnectJob = null
        }
        connect()
    }

    private fun connect() {
        synchronized(lock) {
            if (stopped || socket != null) return
            _state.value = ConnectionState.Connecting
            socket = http.newWebSocket(Request.Builder().url(host.wsUrl).build(), listener)
        }
    }

    private val listener = object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            webSocket.send(Codec.encode(Hello(host.token, client, mode)))
        }

        override fun onMessage(webSocket: WebSocket, text: String) = handle(text)

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            webSocket.close(code, reason)
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = onDisconnected(webSocket, code, reason)

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) =
            onDisconnected(webSocket, response?.code ?: 0, t.message ?: t.javaClass.simpleName)
    }

    private fun onDisconnected(ws: WebSocket, code: Int, reason: String) {
        synchronized(lock) {
            if (socket !== ws) return
            socket = null
        }
        failPending(reason)
        if (code == CLOSE_UNAUTHORIZED || _state.value is ConnectionState.Unpaired) {
            synchronized(lock) { stopped = true }
            _state.value = ConnectionState.Unpaired(reason.ifEmpty { "unauthorized" })
            return
        }
        if (stopped) {
            _state.value = ConnectionState.Idle
            return
        }
        synchronized(lock) {
            val wait = backoffMs
            attempt++
            backoffMs = minOf(backoffMs * 2, MAX_BACKOFF_MS)
            _state.value = ConnectionState.Reconnecting(attempt, wait, reason)
            reconnectJob = scope.launch {
                delay(wait)
                connect()
            }
        }
    }

    // ------------------------------------------------------------ inbound

    internal fun handle(text: String) {
        when (val msg = Codec.decodeServer(text) ?: return) {
            is Welcome -> onWelcome(msg)
            is Snapshot -> _snapshot.value = msg
            is PaneStatus -> {
                _snapshot.value = _snapshot.value?.applyStatus(msg)
                _paneStatus.tryEmit(msg)
            }
            is Frame -> onFrame(msg)
            is HistoryMessage -> {
                styles.merge(msg.styles)
                pending.remove(msg.id)?.complete(msg)
            }
            is ApprovalResult -> _approvals.tryEmit(msg)
            is NotifyState -> _notifyState.tryEmit(msg)
            is HerdrMessage -> _herdrUp.value = msg.isUp
            is OkMessage -> pending.remove(msg.id)?.complete(msg)
            is ErrorMessage -> onError(msg)
        }
    }

    private fun onWelcome(w: Welcome) {
        synchronized(lock) {
            backoffMs = INITIAL_BACKOFF_MS
            attempt = 0
        }
        styles.reset()
        _herdrUp.value = true // the bridge follows welcome with `herdr down` when applicable
        w.snapshot?.let { _snapshot.value = it }
        _state.value = ConnectionState.Connected(w)
        val pane = watchedPane
        val viewing = viewingPane
        if (pane != null || viewing != null) scope.launch {
            if (pane != null) {
                runCatching { watch(pane, watchZoom) }
                fitSize?.let { (c, r) -> runCatching { fit(pane, c, r) } }
            }
            if (viewing != null) viewing(viewing)
        }
    }

    private fun onFrame(f: Frame) {
        styles.merge(f.styles)
        if (f.pane != watchedPane) return
        _grid.value = (_grid.value ?: TerminalGrid.empty(f.cols, f.rows)).apply(f)
        f.alt?.let { _paneAlt.value = it }
        _frames.tryEmit(f)
    }

    private fun onError(e: ErrorMessage) {
        val id = e.id
        if (id != null) {
            pending.remove(id)?.completeExceptionally(FlowException(e.code, e.message))
            return
        }
        if (e.code == ErrorCodes.AUTH) {
            synchronized(lock) {
                stopped = true
                reconnectJob?.cancel()
            }
            _state.value = ConnectionState.Unpaired(e.message.ifEmpty { "unauthorized" })
        }
        _errors.tryEmit(e)
    }

    private fun failPending(reason: String) {
        val it = pending.entries.iterator()
        while (it.hasNext()) {
            it.next().value.completeExceptionally(FlowException(ErrorCodes.DISCONNECTED, reason))
            it.remove()
        }
    }

    // ------------------------------------------------------------ outbound

    private fun send(msg: ClientMessage): Boolean {
        val ws = synchronized(lock) { socket } ?: return false
        if (_state.value !is ConnectionState.Connected) return false
        return ws.send(Codec.encode(msg))
    }

    private suspend fun request(build: (String) -> ClientMessage): ServerMessage {
        val id = ids.incrementAndGet().toString()
        val deferred = CompletableDeferred<ServerMessage>()
        pending[id] = deferred
        if (!send(build(id))) {
            pending.remove(id)
            throw FlowException(ErrorCodes.DISCONNECTED, "not connected")
        }
        try {
            return withTimeout(REQUEST_TIMEOUT_MS) { deferred.await() }
        } catch (e: TimeoutCancellationException) {
            throw FlowException(ErrorCodes.TIMEOUT, "no reply from bridge")
        } finally {
            pending.remove(id)
        }
    }

    /** With [zoom] the bridge zooms the pane on the desktop while this device looks at it and restores the split when it leaves. */
    suspend fun watch(pane: String, zoom: Boolean = false): OkMessage {
        if (watchedPane != pane) {
            _grid.value = null
            _paneAlt.value = null
            fitSize = null
        }
        watchedPane = pane
        watchZoom = zoom
        return request { Watch(it, pane, if (zoom) true else null) } as OkMessage
    }

    suspend fun unwatch(pane: String) {
        if (watchedPane == pane) {
            watchedPane = null
            _grid.value = null
            _paneAlt.value = null
            fitSize = null
        }
        request { Unwatch(it, pane) }
    }

    suspend fun history(pane: String, lines: Int, unwrapped: Boolean = false): HistoryMessage =
        request { History(it, pane, lines.coerceIn(1, 999), if (unwrapped) true else null) } as HistoryMessage

    suspend fun keys(pane: String, keys: List<String>) { request { Keys(it, pane, keys) } }

    /** Open a new terminal on the desktop, typing `command` into it once its shell is up; returns the new pane id. */
    suspend fun createPane(label: String?, command: String?): String {
        val ok = request { PaneCreate(it, label?.ifBlank { null }, command?.ifBlank { null }) } as OkMessage
        return ok.pane ?: throw FlowException(ErrorCodes.HERDR_ERROR, "bridge did not return the new pane")
    }

    /** Close a pane on the desktop: its shell and whatever runs in it end. */
    suspend fun closePane(pane: String) { request { PaneClose(it, pane) } }

    /** Forward a swipe to the program as `lines` wheel reports (at cell `col`,`row`, 1-based) or arrow keys. */
    suspend fun scroll(pane: String, direction: String, lines: Int, mode: String, col: Int, row: Int) {
        request { Scroll(it, pane, direction, lines.coerceIn(1, 50), mode, col, row) }
    }

    suspend fun text(pane: String, text: String) { request { Text(it, pane, text) } }

    /** `notify = true` also arms "tell me when it's done" for this device on the pane. */
    suspend fun prompt(pane: String, text: String, notify: Boolean = false) { request { Prompt(it, pane, text, if (notify) true else null) } }

    /** Arm or disarm the "tell me when it's done" alert; returns the arming now in force. */
    suspend fun notifyDone(pane: String, done: Boolean): Boolean = (request { Notify(it, pane, done) } as OkMessage).done ?: done

    /** Opt this device's FCM token into `status` data messages (the ongoing "working" notification). */
    suspend fun activityRegister() { request { ActivityRegister(it) } }

    suspend fun activityUnregister() { request { ActivityUnregister(it) } }

    suspend fun approve(pane: String, promptId: String, action: String, feedback: String? = null, force: Boolean = false) {
        request { Approve(it, pane, promptId, action, feedback, if (force) true else null) }
    }

    /** Answer a dialog by option number; the outcome arrives on [approvals] like an approve. */
    suspend fun choose(pane: String, promptId: String, option: Int, label: String) {
        request { Choose(it, pane, promptId, option, label) }
    }

    suspend fun zoom(pane: String, mode: String = "toggle"): Boolean =
        (request { Zoom(it, pane, mode) } as OkMessage).zoomed ?: false

    /** Resize the pane's PTY to this device's grid (protocol §4 `fit`). Remembered for reconnects. */
    suspend fun fit(pane: String, cols: Int, rows: Int): OkMessage {
        fitSize = cols to rows
        return request { Fit(it, pane, cols, rows) } as OkMessage
    }
    /** Give the pane back to herdr's own size. */
    suspend fun releaseFit(pane: String) {
        fitSize = null
        request { Fit(it, pane, release = true) }
    }
    /** Fire-and-forget; remembered and re-sent after every reconnect. */
    fun viewing(pane: String?) {
        viewingPane = pane
        send(Viewing.of(pane))
    }

    suspend fun pushRegister(platform: String, token: String, env: String? = null) {
        request { PushRegister(it, platform, token, env) }
    }

    suspend fun pushUnregister() { request { PushUnregister(it) } }

    companion object {
        const val MODE_FULL = "full"
        const val MODE_ACTION = "action"
        const val PING_INTERVAL_S = 15L
        const val INITIAL_BACKOFF_MS = 500L
        const val MAX_BACKOFF_MS = 10_000L
        const val REQUEST_TIMEOUT_MS = 20_000L

        private fun <T> events() = MutableSharedFlow<T>(extraBufferCapacity = 64, onBufferOverflow = BufferOverflow.DROP_OLDEST)
    }
}

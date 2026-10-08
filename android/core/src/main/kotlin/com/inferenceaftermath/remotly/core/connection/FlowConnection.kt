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
import kotlin.math.min
import com.inferenceaftermath.remotly.core.demo.DemoBridge
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
import com.inferenceaftermath.remotly.core.protocol.Scrollback
import com.inferenceaftermath.remotly.core.protocol.ScrollbackMessage
import com.inferenceaftermath.remotly.core.protocol.ServerMessage
import com.inferenceaftermath.remotly.core.protocol.Snapshot
import com.inferenceaftermath.remotly.core.protocol.Text
import com.inferenceaftermath.remotly.core.protocol.Unwatch
import com.inferenceaftermath.remotly.core.protocol.Viewing
import com.inferenceaftermath.remotly.core.protocol.Watch
import com.inferenceaftermath.remotly.core.protocol.Welcome
import com.inferenceaftermath.remotly.core.protocol.Zoom
import com.inferenceaftermath.remotly.core.terminal.HistoryStyles
import com.inferenceaftermath.remotly.core.terminal.ScrollbackLines
import com.inferenceaftermath.remotly.core.terminal.ScrollbackOutcome
import com.inferenceaftermath.remotly.core.terminal.ScrollbackStores
import com.inferenceaftermath.remotly.core.terminal.StyleTable
import com.inferenceaftermath.remotly.core.terminal.TerminalGrid
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.lang.ref.WeakReference

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
    val isDemo: Boolean = false,
    private val lifetime: ConnectionLifetime = ConnectionLifetime(),
) {
    private val lifetimeKey = Any()
    private val demo = if (isDemo) DemoBridge() else null
    private var demoJob: Job? = null
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
    // Scrollback (protocol §4 `scrollback`): the copy of every pane looked at lately, kept across reconnects; changed
    // under `lock` (where messages are handled), read by the app through immutable snapshots.
    private val scrollbacks = ScrollbackStores()
    private val historyStyles = HistoryStyles()
    /** The pane whose history has arrived (an answer's `ok`, or the `history` fallback): a pull past the top with no
     *  rows can then say there is none. */
    @Volatile var historyLoadedFor: String? = null
    /** This connection's bridge answered `scrollback` with `unsupported`: history is its one `history` read. */
    @Volatile private var legacyScrollback = false
        private set
    /** herdr's screen rows for the watched pane, from the `watch` reply (where the `history` fallback's screen starts). */
    @Volatile private var watchedScreenRows = 0
    /** The width of the last frame shown: a pane opened again shows its history at it before its first frame (as iOS,
     *  whose grid keeps its size). Outlives the terminal view, which goes with the pane screen. */
    @Volatile var lastCols = 0
        private set
    /** The fallback's `history` reads so far (under `lock`): only the latest one's answer is shown, since a read made
     *  after a fit can be answered before an earlier one. */
    private var legacyReads = 0

    /** `scrollback` requests waiting for their `ok`: id → (pane, asked without `epoch`). */
    private val scrollbackAsks = ConcurrentHashMap<String, Pair<String, Boolean>>()
    /** Panes with a request for the whole copy in flight: further gaps wait for its answer. */
    private val resyncing = ConcurrentHashMap.newKeySet<String>()
    private val _scrollback = MutableStateFlow<ScrollbackLines?>(null)
    /**
     * History of the watched pane: the bridge's copy as far as it has arrived (lines that left the screen, oldest
     * first), or one `history` read from a bridge without `scrollback`. Check [ScrollbackLines.pane]: it can still be
     * the previous pane's for a moment after a switch.
     */
    val scrollback: StateFlow<ScrollbackLines?> = _scrollback.asStateFlow()
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
            if (!stopped || !lifetime.isActive) return
            stopped = false
            backoffMs = INITIAL_BACKOFF_MS
            attempt = 0
            val weak = WeakReference(this)
            lifetime.onCancel(lifetimeKey) { weak.get()?.stop() }
        }
        connect()
    }

    fun stop() {
        synchronized(lock) {
            lifetime.remove(lifetimeKey)
            stopped = true
            demoJob?.cancel()
            demoJob = null
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
            if (stopped || socket != null || (isDemo && isConnected)) return
            reconnectJob?.cancel()
            reconnectJob = null
        }
        connect()
    }

    private fun connect() {
        synchronized(lock) {
            if (stopped || socket != null) return
            if (demo != null) {
                handle(demo.welcome())
                demoJob?.cancel()
                demoJob = scope.launch {
                    while (true) {
                        delay(200)
                        synchronized(lock) { if (!stopped) demo.tick().forEach(::handle) }
                    }
                }
                return
            }
            _state.value = ConnectionState.Connecting
            lifetime.whileActive { socket = http.newWebSocket(Request.Builder().url(host.wsUrl).build(), listener) }
        }
    }

    private val listener = object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            synchronized(lock) {
                if (!stopped && socket === webSocket) lifetime.whileActive { webSocket.send(Codec.encode(Hello(host.token, client, mode))) }
                else webSocket.cancel()
            }
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            synchronized(lock) { if (!stopped && socket === webSocket) handle(text) }
        }

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
            is ScrollbackMessage -> onScrollback(msg)
            is HistoryMessage -> {
                styles.merge(msg.styles)
                pending.remove(msg.id)?.complete(msg)
            }
            is ApprovalResult -> _approvals.tryEmit(msg)
            is NotifyState -> _notifyState.tryEmit(msg)
            is HerdrMessage -> _herdrUp.value = msg.isUp
            is OkMessage -> {
                scrollbackAsks.remove(msg.id)?.let { (pane, whole) -> onScrollbackOk(pane, whole, msg) }
                pending.remove(msg.id)?.complete(msg)
            }
            is ErrorMessage -> onError(msg)
        }
    }

    private fun onWelcome(w: Welcome) {
        synchronized(lock) {
            backoffMs = INITIAL_BACKOFF_MS
            attempt = 0
        }
        styles.reset()
        legacyScrollback = false // this bridge may be a newer one
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
        lastCols = f.cols
        _grid.value = (_grid.value ?: TerminalGrid.empty(f.cols, f.rows)).apply(f)
        f.alt?.let { _paneAlt.value = it }
        _frames.tryEmit(f)
    }

    /** Lines of the watched pane's history; a gap in them asks for the whole copy again. */
    private fun onScrollback(m: ScrollbackMessage) {
        styles.merge(m.styles)
        if (m.pane != watchedPane) return
        val store = scrollbacks.of(m.pane)
        val lines = m.lines.map { historyStyles.remap(it.runs, styles) }
        when (val r = store.apply(m.epoch, m.start, lines, m.reset == true)) {
            ScrollbackOutcome.Resync -> resyncScrollback(m.pane)
            is ScrollbackOutcome.Applied -> {
                scrollbacks.fit() // other panes' copies give way to this one's lines
                if (r.reset || r.appended > 0 || r.dropped > 0) publishScrollback(m.pane)
            }
        }
    }

    /** The answer is complete: take the bridge's cap, and ask again for everything when the copy does not match its `ok`. */
    private fun onScrollbackOk(pane: String, whole: Boolean, ok: OkMessage) {
        if (whole) resyncing.remove(pane)
        if (pane != watchedPane) return
        historyLoadedFor = pane
        ok.max_lines?.let { scrollbacks.maxLines = it }
        val store = scrollbacks.of(pane)
        if (ok.max_lines != null) store.limit(ok.max_lines)
        publishScrollback(pane) // also says the answer is over
        // a second whole copy that does not match either is left as it is rather than asked for forever
        if (!store.agrees(ok.epoch, ok.next) && !whole) resyncScrollback(pane)
    }

    private fun publishScrollback(pane: String) {
        val answering = scrollbackAsks.values.any { it.first == pane }
        _scrollback.value = scrollbacks.peek(pane)?.snapshot(historyStyles.table, answering)
    }

    /**
     * Says whether an answer for [pane] is arriving, on what is shown: an older bridge's `history` rows on show (another
     * generation than the store's) stay up, only marked, until the fallback's own read replaces them.
     */
    private fun publishAnswering(pane: String) {
        val shown = _scrollback.value
        if (shown != null && shown.pane == pane && shown.generation != scrollbacks.peek(pane)?.generation) {
            _scrollback.value = shown.answering(scrollbackAsks.values.any { it.first == pane })
        } else {
            publishScrollback(pane)
        }
    }

    /** An answer ended without its `ok` (an error, a timeout, `unsupported`): its pane's history is no longer arriving. */
    private fun answerEnded(pane: String) {
        if (pane == watchedPane) publishAnswering(pane)
    }

    private fun resyncScrollback(pane: String) {
        if (resyncing.add(pane)) scope.launch { requestScrollback(pane, whole = true) }
    }

    /**
     * Ask for the pane's history: what came after the copy held (or all of it, [whole] or with nothing held). The
     * answer arrives as `scrollback` messages before the `ok`; a bridge without it gets one `history` read instead.
     */
    private suspend fun requestScrollback(pane: String, whole: Boolean) {
        // a pane left meanwhile: asking for it would move the bridge's live lines away from the pane now watched
        if (watchedPane != pane) return
        val (epoch, from) = synchronized(lock) {
            val store = scrollbacks.peek(pane)
            // the answer's lines come before the `ok` that says how many the bridge keeps: hold up to the protocol's
            // most until then, so none are dropped against an older or smaller limit
            scrollbacks.raiseForAnswer(pane)
            if (whole || store?.epoch == null) null to null else store.epoch to store.next
        }
        var asked: String? = null
        try {
            request(SCROLLBACK_TIMEOUT_MS) { id ->
                // checked again as it goes out: `watch` sets the pane before its own message goes, so a switch either
                // follows this request on the wire (and ends its subscription) or is seen here and sends nothing
                if (watchedPane != pane) return@request null
                asked = id
                scrollbackAsks[id] = pane to (epoch == null)
                if (epoch == null) resyncing.add(pane)
                publishAnswering(pane) // the answer is arriving from now on (iOS marks it before sending too)
                Scrollback(id, pane, epoch, from)
            }
        } catch (e: FlowException) {
            if (e.code == ErrorCodes.UNSUPPORTED) legacyScrollback = true
            if (e.code == ErrorCodes.UNSUPPORTED && watchedPane == pane) legacyHistory(pane)
        } finally {
            asked?.let { if (scrollbackAsks.remove(it) != null) answerEnded(pane) }
            if (epoch == null) resyncing.remove(pane)
        }
    }

    /**
     * A bridge without `scrollback`: one `history` read of 999 lines, herdr's `recent` read — the last 999 rows of
     * history and screen, the screen's blank bottom rows counted but not sent. Its history rows are the reply's
     * `scrollback` first rows when history and screen fit in 999 rows, else the first 999 − screen rows (the screen's
     * height from the `watch` reply), so nothing depends on whether a frame has arrived yet. Shown as they are; nothing
     * is added to them until the next watch.
     */
    private suspend fun legacyHistory(pane: String) {
        val read = synchronized(lock) { ++legacyReads }
        val h = try { history(pane, 999) } catch (e: FlowException) { return }
        if (watchedPane != pane || synchronized(lock) { legacyReads } != read) return
        val total = h.lines.size
        val screen = watchedScreenRows
        val above = h.scrollback
        val kept = when {
            above == null -> (total - screen).coerceAtLeast(0)
            above + screen <= 999 -> min(above, total)
            else -> min(total, (999 - screen).coerceAtLeast(0))
        }
        val lines = h.lines.take(kept).map { historyStyles.remap(it.runs, styles) }
        synchronized(lock) {
            if (watchedPane != pane || legacyReads != read) return
            historyLoadedFor = pane
            _scrollback.value = ScrollbackLines(pane, ScrollbackLines.newGeneration(), 0, lines, historyStyles.table)
        }
    }

    private fun onError(e: ErrorMessage) {
        val id = e.id
        if (id != null) {
            scrollbackAsks.remove(id)?.let { (pane, whole) ->
                if (whole) resyncing.remove(pane)
                answerEnded(pane)
            }
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
        scrollbackAsks.clear()
        resyncing.clear()
        val it = pending.entries.iterator()
        while (it.hasNext()) {
            it.next().value.completeExceptionally(FlowException(ErrorCodes.DISCONNECTED, reason))
            it.remove()
        }
    }

    // ------------------------------------------------------------ outbound

    private fun send(msg: ClientMessage): Boolean = synchronized(lock) {
        if (stopped || !isConnected) return false
        var sent = false
        lifetime.whileActive {
            if (demo != null) {
                demo.receive(Codec.encode(msg)).forEach(::handle); sent = true
            } else {
                sent = socket?.send(Codec.encode(msg)) ?: false
            }
        }
        sent
    }

    private suspend fun request(timeoutMs: Long = REQUEST_TIMEOUT_MS, build: (String) -> ClientMessage?): ServerMessage {
        val id = ids.incrementAndGet().toString()
        val deferred = CompletableDeferred<ServerMessage>()
        pending[id] = deferred
        // built and sent in one step under the lock; a builder that finds the request no longer wanted returns null
        val sent = synchronized(lock) { build(id)?.let { send(it) } }
        if (sent != true) {
            pending.remove(id)
            throw if (sent == null) FlowException(ErrorCodes.SUPERSEDED, "a newer request replaced this one") else FlowException(ErrorCodes.DISCONNECTED, "not connected")
        }
        try {
            return withTimeout(timeoutMs) { deferred.await() }
        } catch (e: TimeoutCancellationException) {
            throw FlowException(ErrorCodes.TIMEOUT, "no reply from bridge")
        } finally {
            pending.remove(id)
        }
    }

    /**
     * With [zoom] the bridge zooms the pane on the desktop while this device looks at it and restores the split when it
     * leaves. Every watch that succeeds (the re-watch after a reconnect too) is followed by a `scrollback` request that
     * brings the pane's history up to date; what is already held shows at once.
     */
    suspend fun watch(pane: String, zoom: Boolean = false): OkMessage {
        if (watchedPane != pane) {
            _grid.value = null
            _paneAlt.value = null
            fitSize = null
            historyLoadedFor = null
            watchedPane = pane
            synchronized(lock) { publishScrollback(pane) }
        }
        watchZoom = zoom
        val ok = request { Watch(it, pane, if (zoom) true else null) } as OkMessage
        if (watchedPane == pane) {
            ok.rows?.let { watchedScreenRows = it }
            scope.launch { requestScrollback(pane, whole = false) }
        }
        return ok
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
        val ok = request { Fit(it, pane, cols, rows) } as OkMessage
        rereadLegacyHistory(pane, ok)
        return ok
    }
    /** Give the pane back to herdr's own size. */
    suspend fun releaseFit(pane: String) {
        fitSize = null
        rereadLegacyHistory(pane, request { Fit(it, pane, release = true) } as? OkMessage)
    }

    /** A bridge without `scrollback` re-wrapped the pane to another size: its one `history` read is read again at it. */
    private fun rereadLegacyHistory(pane: String, ok: OkMessage?) {
        if (!legacyScrollback || watchedPane != pane) return
        ok?.rows?.let { watchedScreenRows = it }
        scope.launch { legacyHistory(pane) }
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
        /** A `scrollback` answer is the pane's whole history and goes out only as fast as the link takes it, so over a
         *  slow one it can take minutes; a connection that drops fails it at once. */
        const val SCROLLBACK_TIMEOUT_MS = 300_000L

        private fun <T> events() = MutableSharedFlow<T>(extraBufferCapacity = 64, onBufferOverflow = BufferOverflow.DROP_OLDEST)
    }
}

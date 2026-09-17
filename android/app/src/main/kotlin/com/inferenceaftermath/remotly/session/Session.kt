// App-wide state: the paired host, the live FlowConnection (foreground only), pane navigation
// requests from notifications, push registration, "tell me when it's done" arming and
// stale-notification cleanup.
package com.inferenceaftermath.remotly.session

import android.app.Application
import android.net.ConnectivityManager
import android.net.Network
import android.os.Build
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import com.inferenceaftermath.remotly.core.connection.ConnectionState
import com.inferenceaftermath.remotly.core.connection.FlowConnection
import com.inferenceaftermath.remotly.core.connection.UploadClient
import com.inferenceaftermath.remotly.core.connection.HostConfig
import com.inferenceaftermath.remotly.core.pairing.PairDevice
import com.inferenceaftermath.remotly.core.pairing.PairingClient
import com.inferenceaftermath.remotly.core.pairing.QrPayload
import com.inferenceaftermath.remotly.core.protocol.ClientInfo
import com.inferenceaftermath.remotly.core.protocol.Snapshot
import com.inferenceaftermath.remotly.core.terminal.TerminalGrid
import com.inferenceaftermath.remotly.data.HostStore
import com.inferenceaftermath.remotly.push.Notifications
import com.inferenceaftermath.remotly.push.PushRegistrar

/** One toast: [ok] picks the green variant. [id] makes a repeated identical text show again. */
data class Notice(val text: String, val ok: Boolean = false, val id: Long = System.nanoTime())

sealed interface HostState {
    data object Loading : HostState
    data object None : HostState
    data class Paired(val host: HostConfig) : HostState
}

@OptIn(ExperimentalCoroutinesApi::class)
class Session(private val app: Application, val store: HostStore) {
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    val clientInfo: ClientInfo = ClientInfo("android", appVersion(app), deviceName())

    val hostState: StateFlow<HostState> = store.host
        .map { if (it == null) HostState.None else HostState.Paired(it) }
        .stateIn(scope, SharingStarted.Eagerly, HostState.Loading)

    private val _connection = MutableStateFlow<FlowConnection?>(null)
    val connection: StateFlow<FlowConnection?> = _connection

    val connState: StateFlow<ConnectionState> = _connection
        .flatMapLatest { it?.state ?: flowOf(ConnectionState.Idle) }
        .stateIn(scope, SharingStarted.Eagerly, ConnectionState.Idle)
    val snapshot: StateFlow<Snapshot?> = _connection
        .flatMapLatest { it?.snapshot ?: flowOf(null) }
        .stateIn(scope, SharingStarted.Eagerly, null)
    val grid: StateFlow<TerminalGrid?> = _connection
        .flatMapLatest { it?.grid ?: flowOf(null) }
        .stateIn(scope, SharingStarted.Eagerly, null)
    val herdrUp: StateFlow<Boolean> = _connection
        .flatMapLatest { it?.herdrUp ?: flowOf(true) }
        .stateIn(scope, SharingStarted.Eagerly, true)
    /** Whether an alternate-screen program has the watched pane (bridge `frame.alt`); null until known. */
    val paneAlt: StateFlow<Boolean?> = _connection
        .flatMapLatest { it?.paneAlt ?: flowOf(null) }
        .stateIn(scope, SharingStarted.Eagerly, null)

    /** Pane requested by a notification tap; the UI consumes it with [consumeRequestedPane]. */
    val requestedPane = MutableStateFlow<String?>(null)
    /** Transient notice for the shared toast (DESIGN.md §4.2); cleared with [consumeNotice]. */
    val notice = MutableStateFlow<Notice?>(null)
    fun notify(text: String, ok: Boolean = false) { notice.value = Notice(text, ok) }
    fun consumeNotice() { notice.value = null }
    val fontScale: StateFlow<Float> = store.fontScale.stateIn(scope, SharingStarted.Eagerly, 0f)
    val fitToDevice: StateFlow<Boolean> = store.fitToDevice.stateIn(scope, SharingStarted.Eagerly, true)
    val zoomOnDesktop: StateFlow<Boolean> = store.zoomOnDesktop.stateIn(scope, SharingStarted.Eagerly, true)
    val notifyOnPrompt: StateFlow<Boolean> = store.notifyOnPrompt.stateIn(scope, SharingStarted.Eagerly, true)
    val requireUnlock: StateFlow<Boolean> = store.requireUnlock.stateIn(scope, SharingStarted.Eagerly, true)
    val liveStatus: StateFlow<Boolean> = store.liveStatus.stateIn(scope, SharingStarted.Eagerly, true)

    /**
     * Panes this phone asked to be told about when their agent finishes. The bridge is the source of truth:
     * seeded from `welcome.notify_done`, corrected by `notify.state` (the alert fired) and by the `done` push
     * itself when it reaches us in the foreground; toggled here through [setNotifyDone] and [prompt].
     */
    private val _notifyDone = MutableStateFlow<Set<String>>(emptySet())
    val notifyDone: StateFlow<Set<String>> = _notifyDone

    /**
     * How a vertical swipe on a pane behaves, per pane and persisted: [ScrollMode.AUTO] (the default) forwards
     * wheel steps while an alternate-screen program has the pane and scrolls the phone's own history otherwise;
     * the other modes fix one behaviour. Panes not in the map use AUTO.
     */
    val scrollModes: StateFlow<Map<String, ScrollMode>> = store.scrollModes
        .map { m -> m.mapNotNull { (pane, wire) -> ScrollMode.entries.firstOrNull { it.wire == wire }?.let { pane to it } }.toMap() }
        .stateIn(scope, SharingStarted.Eagerly, emptyMap())
    fun setScrollMode(pane: String, mode: ScrollMode) { scope.launch { store.setScrollMode(pane, mode.wire) } }

    private var active = false
    private val network = app.getSystemService(ConnectivityManager::class.java)
    private val networkCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            _connection.value?.reconnectNow()
        }
    }

    init {
        scope.launch { hostState.collect { syncConnection() } }
        scope.launch {
            connState.map { it is ConnectionState.Connected }.distinctUntilChanged().collect { connected ->
                if (connected) _connection.value?.let { PushRegistrar.registerCurrentToken(app, this@Session) }
            }
        }
        // Remove delivered approval notifications whose prompt is no longer live; forget arms of panes that are gone.
        scope.launch {
            combine(snapshot, connState) { s, c -> if (c is ConnectionState.Connected && s != null) s else null }
                .collect { s ->
                    if (s != null) {
                        Notifications.cancelStale(app, s.panes.mapNotNull { it.prompt_id }.toSet())
                        Notifications.reconcileStatus(app, s.panes.associate { it.id to it.agent_status })
                        _notifyDone.update { armed -> armed.filterTo(HashSet()) { s.pane(it) != null } }
                    }
                }
        }
        scope.launch { connState.collect { if (it is ConnectionState.Connected) _notifyDone.value = it.welcome.notify_done.toSet() } }
        scope.launch {
            _connection.flatMapLatest { it?.notifyState ?: emptyFlow() }.collect { ns -> _notifyDone.update { if (ns.done) it + ns.pane else it - ns.pane } }
        }
    }

    // ------------------------------------------------------------ lifecycle

    /** Called from the activity's onStart/onStop: the live socket exists only while the UI is visible. */
    fun setActive(isActive: Boolean) {
        if (active == isActive) return
        active = isActive
        runCatching {
            if (isActive) network.registerDefaultNetworkCallback(networkCallback) else network.unregisterNetworkCallback(networkCallback)
        }
        syncConnection()
    }

    @Synchronized
    private fun syncConnection() {
        val host = (hostState.value as? HostState.Paired)?.host
        val current = _connection.value
        if (host == null || !active) {
            current?.stop()
            if (host == null) _connection.value = null
            return
        }
        if (current == null || current.host != host) {
            current?.stop()
            _connection.value = FlowConnection(host, clientInfo, FlowConnection.MODE_FULL, scope).also { it.start() }
        } else if (current.state.value !is ConnectionState.Unpaired) {
            current.start()
        }
    }

    // ------------------------------------------------------------ pairing

    suspend fun pair(payload: QrPayload): HostConfig {
        val result = PairingClient().pair(payload.url, payload.code, payload.fingerprint, PairDevice(clientInfo.device_name, "android", clientInfo.app_version))
        val host = HostConfig(payload.url, result.token, payload.fingerprint, result.host_name.ifEmpty { payload.hostName ?: payload.url }, result.device_id)
        store.save(host)
        return host
    }

    suspend fun unpair() {
        _connection.value?.let { c ->
            if (c.isConnected) runCatching { c.pushUnregister() }
            c.stop()
        }
        _connection.value = null
        Notifications.cancelAll(app)
        store.clear()
    }

    // ------------------------------------------------------------ panes

    fun requestPane(pane: String) {
        requestedPane.value = pane
    }

    fun consumeRequestedPane(): String? = requestedPane.value.also { requestedPane.value = null }

    fun isViewing(pane: String): Boolean = _connection.value?.let { it.isConnected && it.viewingPane == pane } ?: false

    /** True when we are connected and the snapshot no longer lists this prompt (push arrived late). */
    /**
     * A push is stale when we know the pane and its live prompt differs (the desktop already answered).
     * An unknown pane (snapshot lag, or the bridge's synthetic `push-test`) is not evidence of staleness.
     */
    fun isPromptStale(promptId: String): Boolean {
        if (connState.value !is ConnectionState.Connected) return false
        val s = snapshot.value ?: return false
        val paneId = promptId.substringBefore('@', missingDelimiterValue = "")
        val pane = s.panes.firstOrNull { it.id == paneId } ?: return false
        return pane.prompt_id != promptId
    }

    fun setFontScale(scale: Float) {
        scope.launch { store.setFontScale(scale) }
    }

    fun setFitToDevice(on: Boolean) {
        scope.launch { store.setFitToDevice(on) }
    }

    fun setZoomOnDesktop(on: Boolean) {
        scope.launch { store.setZoomOnDesktop(on) }
    }

    fun setNotifyOnPrompt(on: Boolean) {
        scope.launch { store.setNotifyOnPrompt(on) }
    }

    fun setRequireUnlock(on: Boolean) {
        scope.launch { store.setRequireUnlock(on) }
    }

    /** Ongoing "working" notifications: tell the bridge at once so `status` pushes start or stop. */
    fun setLiveStatus(on: Boolean) {
        scope.launch {
            store.setLiveStatus(on)
            _connection.value?.takeIf { it.isConnected }?.let { runCatching { if (on) it.activityRegister() else it.activityUnregister() } }
            if (!on) Notifications.cancelStatus(app)
        }
    }

    // ------------------------------------------------------------ "tell me when it's done"

    /** Arm or disarm the finished alert for this phone on a pane. Throws when not connected or refused. */
    suspend fun setNotifyDone(pane: String, done: Boolean) {
        val c = _connection.value?.takeIf { it.isConnected } ?: throw IllegalStateException("Not connected to the host")
        val armed = c.notifyDone(pane, done)
        _notifyDone.update { if (armed) it + pane else it - pane }
    }

    /** Send a prompt; with "tell me when it's done" on, an agent pane is armed in the same request. */
    suspend fun prompt(c: FlowConnection, pane: String, text: String) {
        val notify = notifyOnPrompt.value && snapshot.value?.pane(pane)?.hasAgent == true
        c.prompt(pane, text, notify)
        if (notify) _notifyDone.update { it + pane }
    }

    /** Store a photo on the host (`POST /upload`); returns its absolute path there. */
    suspend fun upload(jpeg: ByteArray): String {
        val host = (hostState.value as? HostState.Paired)?.host ?: throw IllegalStateException("Not paired")
        return UploadClient(host).upload(jpeg).path
    }

    /** A `done` push for the pane reached this phone: the bridge has disarmed it. */
    fun onDoneDelivered(pane: String) {
        _notifyDone.update { it - pane }
    }

    // ------------------------------------------------------------ push

    fun onPushToken(token: String) {
        scope.launch {
            store.setPushToken(token)
            _connection.value?.takeIf { it.isConnected }?.let { c ->
                runCatching { c.pushRegister("android", token) }.onSuccess {
                    if (liveStatus.value) runCatching { c.activityRegister() }
                }
            }
        }
    }

    suspend fun currentHost(): HostConfig? = store.host.first()

    companion object {
        fun appVersion(app: Application): String = try {
            val info = app.packageManager.getPackageInfo(app.packageName, 0)
            val code = if (Build.VERSION.SDK_INT >= 28) info.longVersionCode else @Suppress("DEPRECATION") info.versionCode.toLong()
            "${info.versionName} ($code)"
        } catch (e: Exception) {
            "0.0"
        }

        fun deviceName(): String {
            val model = Build.MODEL ?: "Android"
            val maker = Build.MANUFACTURER ?: ""
            val name = if (model.startsWith(maker, ignoreCase = true) || maker.isEmpty()) model else "${maker.replaceFirstChar { it.uppercase() }} $model"
            return name.take(64)
        }
    }
}

/** `wire` is what a `scroll` request carries; AUTO is never sent, it resolves to WHEEL or SCROLLBACK first. */
enum class ScrollMode(val wire: String, val label: String) {
    AUTO("auto", "Automatic"),
    SCROLLBACK("scrollback", "Scrollback on this phone"),
    WHEEL("wheel", "Mouse wheel to the program"),
    ARROWS("arrows", "Arrow keys to the program"),
}

// Single observable app state: paired host, connection, snapshot, watched pane grid, history, approvals,
// "tell me when it's done" arming, push registration and Live Activity tokens. Everything here runs on the
// main actor; the networking actor (`FlowConnection`) publishes events that are folded in by `handle(_:)`.
import ActivityKit
import FlowKit
import Observation
import SwiftUI
import UIKit

struct ApprovalAttempt: Hashable {
    var action: ApprovalAction
    var feedback: String?
}

@MainActor @Observable
final class AppModel {
    static let shared = AppModel()

    // Host and connection
    private(set) var host: PairedHost?
    private(set) var isDemo = false
    private var modeEpoch = 0
    private(set) var realConnectionLifetime = ConnectionLifetime()
    static let demoHost = PairedHost(name: "Demo host", url: URL(string: "demo://local")!, fingerprint: nil, token: "", deviceId: "demo-device")
    var displayHost: PairedHost? { isDemo ? Self.demoHost : host }

    func enterDemo() { switchDemo(true) }
    func exitDemo() { switchDemo(false) }

    private func switchDemo(_ enabled: Bool) {
        guard isDemo != enabled else { return }
        realConnectionLifetime.cancel()
        if !enabled { realConnectionLifetime = ConnectionLifetime() }
        modeEpoch += 1
        let old = connection
        let queued = lifecycleQueue
        lifecycleQueue = nil
        eventTask?.cancel()
        eventTask = nil
        connection = nil
        // Clear navigation before replacing the peer. Every asynchronous completion checks its peer.
        viewingEpoch += 1
        fitTask?.cancel()
        noScrollbackHintTask?.cancel()
        navigationPath = []
        watchedPane = nil
        snapshot = nil
        hostInfo = nil
        deviceInfo = nil
        grid = TerminalGrid()
        history = nil
        historyHasMore = false
        isLoadingHistory = false
        noScrollbackHint = false
        fitPhase = .none
        paneAlt = [:]
        demoScrollModes = [:]
        approvalResults = [:]
        approvalInFlight = nil
        lastApprovalAttempt = [:]
        notifyDone = []
        notice = nil
        lastError = nil
        registeredPushToken = nil
        pushRegistered = false
        connectionState = .idle
        isDemo = enabled
        // Keep the keychain pairing and real Live Activities intact.
        Task { await queued?.value; await old?.stop() }
        if isForeground { connect() }
    }
    private(set) var connectionState: ConnectionState = .idle
    private(set) var hostInfo: Welcome.HostInfo?
    private(set) var deviceInfo: Welcome.DeviceInfo?
    private(set) var herdrUp = true
    private(set) var snapshot: Snapshot?
    private(set) var isForeground = false
    var navigationPath: [String] = []
    var lastError: String?
    /// The toast (shared/design/DESIGN.md §4.2): top centre of every screen for 2.4 s; `ok` is the green variant.
    struct Notice: Equatable {
        /// Distinguishes two identical notices in a row, so the first one's timer cannot clear the second.
        let id = UUID()
        var text: String
        var ok: Bool
    }
    var notice: Notice?

    // Terminal
    private(set) var watchedPane: String?
    private(set) var grid = TerminalGrid()
    private(set) var history: TerminalGrid?
    private(set) var historyHasMore = false
    private(set) var isLoadingHistory = false
    /// Shown briefly when a pull for scrollback finds that herdr holds nothing above the screen (alternate-screen program, fresh shell).
    private(set) var noScrollbackHint = false
    private var noScrollbackHintTask: Task<Void, Never>?
    /// "Fitting…" on the pane view's pill: from the moment a `fit` is sent until the first frame after its reply.
    private(set) var fitPhase: FitPhase = .none
    var fitting: Bool { fitPhase != .none }
    /// "Zoom on desktop while viewing" (Settings): sent with `watch` so the bridge zooms the pane and restores the split when we leave.
    private var zoomWhileViewing = false
    /// Bumped by every `startViewing` / `stopViewing`; a viewing task whose epoch is stale (the user switched or left
    /// panes while its first network send was out) skips its `watch` / `unwatch` rather than act on the old pane.
    private var viewingEpoch = 0
    /// Monotonic version passed to `FlowConnection.watch`/`stopWatching` (`watchIntent`) and `fit`/`releaseFit`
    /// (`fitIntent`). Rapid taps and toggles spawn independent, unordered tasks; the connection rejects any that
    /// reaches it with an intent below the newest it has applied, so a stale watch/fit cannot win the race and be
    /// remembered for the next reconnect. Assigned synchronously here so intent order matches the user's action order.
    private var watchIntent = 0
    private var fitIntent = 0
    private var historyLines = 0
    /// Per pane, persisted in UserDefaults; panes not listed use `.auto`.
    private var scrollModes: [String: ScrollMode] = [:]
    private var demoScrollModes: [String: ScrollMode] = [:]
    /// From frames: whether an alternate-screen program (Claude Code, vim, less) has the pane. Reset when a pane is opened.
    private(set) var paneAlt: [String: Bool] = [:]
    private static let scrollModesKey = "scrollModes"

    // Approvals (keyed by prompt_id)
    private(set) var approvalResults: [String: ApprovalResult] = [:]
    private(set) var approvalInFlight: String?
    private(set) var lastApprovalAttempt: [String: ApprovalAttempt] = [:]

    // Push
    private(set) var pushTokenHex: String?
    private var registeredPushToken: String?
    /// True once this connection accepted `push.register` (the bridge wants it before any `activity.register`).
    private var pushRegistered = false

    /// Panes this phone asked to be told about when their agent finishes. The bridge is the source of truth:
    /// seeded from `welcome.notify_done`, corrected by `notify.state` (the alert fired) and by the `done` push itself.
    private(set) var notifyDone: Set<String> = []

    // Live Activities: the bridge starts, updates and ends them over APNs; the app only hands it the tokens.
    @ObservationIgnored private var activityStartTokenTask: Task<Void, Never>?
    @ObservationIgnored private var activityUpdatesTask: Task<Void, Never>?
    @ObservationIgnored private var pushToStartToken: String?
    @ObservationIgnored private var activityTokens: [String: String] = [:]
    @ObservationIgnored private var syncedActivityTokens: Set<String> = []

    private let hostStore = HostStore()
    @ObservationIgnored private var connection: FlowConnection?
    @ObservationIgnored private var eventTask: Task<Void, Never>?

    init() {
        if let saved = UserDefaults.standard.dictionary(forKey: Self.scrollModesKey) as? [String: String] {
            scrollModes = saved.compactMapValues(ScrollMode.init(rawValue:))
        }
        UserDefaults.standard.removeObject(forKey: "pinnedPanes") // pins were removed on 2026-09-09; drop the old value
        do {
            host = try hostStore.load()
        } catch {
            lastError = error.localizedDescription
        }
    }

    // MARK: Lookups

    var needsRepair: Bool { connectionState == .unpaired }

    func pane(_ id: String) -> Pane? { snapshot?.panes.first { $0.id == id } }

    /// "Needs you" (§4.3): blocked panes, the one waiting longest first (same order as Android).
    var blockedPanes: [Pane] {
        (snapshot?.panes ?? []).filter(\.needsYou).sorted {
            ($0.since ?? Int.max, $0.title) < ($1.since ?? Int.max, $1.title)
        }
    }

    /// §4.3 order inside a section: blocked → working → idle → done → other agents → plain shells, then by title (the
    /// same `rank` as Android).
    static func listOrder(_ a: Pane, _ b: Pane) -> Bool {
        (listRank(a), a.title) < (listRank(b), b.title)
    }

    private static func listRank(_ pane: Pane) -> Int { pane.hasAgent ? pane.agentStatus.sortRank : 5 }

    /// Panes of a tab in §4.3 order.
    func panes(inTab tabId: String) -> [Pane] {
        (snapshot?.panes ?? [])
            .filter { $0.tabId == tabId }
            .sorted { AppModel.listOrder($0, $1) }
    }

    func tabs(inWorkspace workspaceId: String) -> [FlowKit.Tab] {  // qualified: SwiftUI has its own `Tab` on iOS 18
        (snapshot?.tabs ?? []).filter { $0.workspaceId == workspaceId }
    }

    // MARK: Connection lifecycle

    /// Lifecycle calls reach the connection in the order they were made. Each is a hop to the connection actor;
    /// two independent hops (background's `suspend`, then foreground's `resume`) could land reversed and leave a
    /// stopped connection in the foreground, so they are chained on one task.
    @ObservationIgnored private var lifecycleQueue: Task<Void, Never>?

    private func onConnection(_ operation: @escaping @Sendable (FlowConnection) async -> Void) {
        guard let connection else { return }
        let previous = lifecycleQueue
        lifecycleQueue = Task {
            await previous?.value
            guard self.connection === connection else { return }
            await operation(connection)
        }
    }

    func connect() {
        guard let host = displayHost else { return }
        if connection != nil {
            onConnection { await $0.resume() }
            return
        }
        let conn = FlowConnection(host: host, client: AppInfo.clientInfo(deviceName: UIDevice.current.name), mode: .full, demo: isDemo,
                                  lifetime: isDemo ? ConnectionLifetime() : realConnectionLifetime)
        connection = conn
        eventTask = Task { [weak self] in
            for await event in conn.events {
                guard !Task.isCancelled, let self, self.connection === conn else { return }
                self.handle(event)
            }
        }
        onConnection { await $0.start() }
    }

    /// Pull-to-refresh and "Retry now": drop the socket and reconnect (a fresh `hello` brings a fresh snapshot). Not
    /// after 4401: the bridge would refuse the same token again; the banner offers pairing again instead (as Android).
    func reconnectNow() async {
        guard connectionState != .unpaired else { return }
        guard connection != nil else { connect(); return }
        onConnection { await $0.start() }
        await lifecycleQueue?.value
    }

    func scenePhaseChanged(_ phase: ScenePhase) {
        switch phase {
        case .active:
            isForeground = true
            connect()
            startObservingActivities()
        case .background:
            isForeground = false
            onConnection { await $0.suspend() }
        default:
            break
        }
    }

    private func handle(_ event: ConnectionEvent) {
        switch event {
        case .state(let state):
            connectionState = state
        case .welcome(let welcome):
            hostInfo = welcome.host
            deviceInfo = welcome.device
            herdrUp = true
            grid.resetStyles() // style ids are per connection
            registeredPushToken = nil
            pushRegistered = false
            syncedActivityTokens = []
            notifyDone = Set(welcome.notifyDone)
            registerPushIfNeeded()
            if let snapshot = welcome.snapshot { apply(snapshot: snapshot) }
        case .snapshot(let snapshot):
            apply(snapshot: snapshot)
        case .paneStatus(let status):
            apply(status: status)
        case .frame(let frame):
            guard frame.pane == watchedPane else { break }
            grid.apply(frame: frame)
            if fitPhase == .replied { fitPhase = .none } // the first frame drawn at the new size
            if let alt = frame.alt, paneAlt[frame.pane] != alt {
                paneAlt[frame.pane] = alt
                if effectiveScrollMode(for: frame.pane) != .scrollback { history = nil } // swipes now go to the program
            }
        case .history:
            break // history arrives as a request reply
        case .approvalResult(let result):
            approvalResults[result.promptId] = result
            if approvalInFlight == result.promptId { approvalInFlight = nil }
            if result.outcome == .sent { showNotice("approval.result · sent", ok: true) }
        case .notifyState(let pane, let done):
            if done { notifyDone.insert(pane) } else { notifyDone.remove(pane) }
        case .herdr(let isUp):
            herdrUp = isUp
        }
    }

    private func apply(snapshot: Snapshot) {
        // The pane on screen is gone from herdr (exit typed, closed on the desktop or from another device): back to the list.
        if let shown = navigationPath.last, let old = self.snapshot?.panes.first(where: { $0.id == shown }),
           !snapshot.panes.contains(where: { $0.id == shown }) {
            navigationPath = []
            showNotice(closedNotice(title: Theme.sessionTitle(for: old)))
        }
        self.snapshot = snapshot
        let ids = Set(snapshot.panes.map(\.id))
        notifyDone = notifyDone.filter(ids.contains)
        let live = snapshot.livePromptIds
        if !isDemo { Task { await FlowNotifications.removeStaleApprovals(livePromptIds: live) } }
        reconcileActivities()
    }

    private func apply(status: PaneStatus) {
        guard var snapshot, let i = snapshot.panes.firstIndex(where: { $0.id == status.pane }) else { return }
        snapshot.panes[i].agentStatus = status.agentStatus
        // Every field rides on every event (protocol §6): a null agent means the pane is a plain shell now.
        snapshot.panes[i].agent = status.agent
        snapshot.panes[i].displayAgent = status.displayAgent
        if let title = status.title { snapshot.panes[i].title = title }
        snapshot.panes[i].stateLabel = status.stateLabel
        snapshot.panes[i].promptId = status.agentStatus == .blocked ? status.promptId : nil
        snapshot.panes[i].approval = status.agentStatus == .blocked ? status.approval : nil
        snapshot.panes[i].since = status.since
        self.snapshot = snapshot
        reconcileActivities()
    }

    private func report(_ error: Error, from source: FlowConnection? = nil) {
        if let source, connection !== source { return }
        if let flow = error as? FlowError, flow == .notConnected || flow == .closed { return }
        lastError = (error as? LocalizedError)?.errorDescription ?? String(describing: error)
    }

    // MARK: Pairing

    func pair(with payload: QRPayload) async throws {
        guard !isDemo else { throw FlowError.superseded }
        let epoch = modeEpoch
        let client = PairingClient(origin: payload.origin, fingerprint: payload.fingerprint)
        let response = try await client.pair(code: payload.code, deviceName: UIDevice.current.name, appVersion: AppInfo.version)
        let paired = PairedHost(name: response.hostName.isEmpty ? payload.hostName : response.hostName,
                                url: payload.origin, fingerprint: payload.fingerprint,
                                token: response.token, deviceId: response.deviceId)
        guard !isDemo, modeEpoch == epoch else { throw FlowError.superseded }
        try hostStore.save(paired)
        host = paired
        lastError = nil
        connect()
    }

    func forgetHost() {
        if isDemo { exitDemo(); return }
        // The old host's cleanup runs after whatever was queued for its connection, but off the queue: the next
        // pairing's `start()` must not wait behind an `unregisterPush` that a dead socket answers only by timeout.
        let queued = lifecycleQueue
        lifecycleQueue = nil
        if let connection {
            Task {
                await queued?.value
                _ = try? await connection.unregisterPush()
                await connection.stop()
            }
        }
        eventTask?.cancel()
        eventTask = nil
        connection = nil
        do { try hostStore.delete() } catch { lastError = error.localizedDescription }
        host = nil
        snapshot = nil
        hostInfo = nil
        deviceInfo = nil
        // Live Activities belong to the host that started them: none outlives the pairing (Android cancels its
        // notifications the same way), or a tap on one would open the next host's same-named pane.
        Task {
            for activity in Activity<FlowActivityAttributes>.activities {
                await activity.end(nil, dismissalPolicy: .immediate)
            }
        }
        navigationPath = []
        watchedPane = nil
        history = nil
        connectionState = .idle
        registeredPushToken = nil
    }

    // MARK: Viewing a pane

    func openPane(_ id: String) {
        guard !isDemo || snapshot?.panes.contains(where: { $0.id == id }) == true else { return }
        if navigationPath != [id] { navigationPath = [id] }
    }

    func startViewing(_ pane: String, zoom: Bool = false) {
        viewingEpoch += 1
        let epoch = viewingEpoch
        watchIntent += 1
        let intent = watchIntent
        zoomWhileViewing = zoom
        if watchedPane != pane {
            grid.clearContents()
            history = nil
            fitPhase = .none
            paneAlt[pane] = nil // the first frames say whether a full-screen program has it now
        }
        watchedPane = pane
        if !isDemo { Task { await FlowNotifications.removeDelivered(forPane: pane) } } // the user is looking at it now
        guard let connection else { return }
        Task {
            await connection.setViewing(pane, epoch: epoch)
            // `stopViewing()` (or another pane) may have come while that send was out; a `watch` now would make the
            // connection remember, and restore after the next reconnect, a pane nobody is looking at.
            guard self.connection === connection, self.viewingEpoch == epoch, self.watchedPane == pane else { return }
            await self.watchRetryingUnknownPane(pane, intent: intent, connection: connection)
        }
    }

    /// A pane created a moment ago can be missing from the bridge's snapshot for a few hundred ms (the bridge
    /// now waits for it too); retry `unknown_pane` a few times while this pane is still the one being viewed.
    private func watchRetryingUnknownPane(_ pane: String, intent: Int, connection: FlowConnection) async {
        for attempt in 0..<5 {
            guard self.connection === connection, watchedPane == pane else { return }
            do {
                _ = try await connection.watch(pane: pane, zoom: zoomWhileViewing, intent: intent)
                return
            } catch let error as FlowError {
                if case .superseded = error { return } // a newer watch/stop replaced this one; leave the pane to it
                if case .server(let code, _) = error, code == .unknownPane, attempt < 4 {
                    try? await Task.sleep(for: .milliseconds(400))
                    if watchedPane != pane { return }
                    continue
                }
                report(error, from: connection)
                return
            } catch {
                report(error, from: connection)
                return
            }
        }
    }

    /// `pane` is the view that disappeared. When panes are swapped by a deep link the new pane's `onAppear` can run
    /// before the old one's `onDisappear`, so a bare stop would read the shared `watchedPane` as the new pane and
    /// unwatch it: act only when the disappearing pane is still the one being viewed.
    func stopViewing(_ pane: String) {
        guard watchedPane == pane else { return }
        viewingEpoch += 1
        let epoch = viewingEpoch
        watchIntent += 1
        let intent = watchIntent
        watchedPane = nil
        history = nil
        fitPhase = .none
        guard let connection else { return }
        Task {
            await connection.setViewing(nil, epoch: epoch)
            // A `startViewing` that came while that send was out (the user reopened this or another pane) has the say.
            // Otherwise drop whatever pane the connection watches — which can differ from `pane` if this pane's own
            // `watch` was skipped — so a reconnect does not restore a pane the user has left.
            guard self.connection === connection, self.viewingEpoch == epoch else { return }
            await connection.stopWatching(intent: intent)
        }
    }

    // MARK: Fit (pane follows this device)

    private var fitTask: Task<Void, Never>?

    /// The terminal view reports the grid it can show; debounced, then sent as `fit` for the watched pane.
    func fitPane(cols: Int, rows: Int) {
        guard let pane = watchedPane, let connection else { return }
        fitTask?.cancel()
        fitIntent += 1
        let intent = fitIntent
        fitTask = Task {
            try? await Task.sleep(for: .milliseconds(300))
            guard !Task.isCancelled, self.connection === connection, self.watchedPane == pane else { return }
            self.fitPhase = .sent
            do {
                _ = try await connection.fit(pane: pane, cols: cols, rows: rows, intent: intent)
                // Cancelled while waiting (a newer fit, or fit switched off): the reply is stale, say nothing.
                guard !Task.isCancelled, self.connection === connection, self.watchedPane == pane else { return }
                self.fitPhase = .replied
                // The pill clears on the next frame; a program that does not redraw on the resize would leave it
                // stuck, so give up waiting after 3 s (same on Android).
                try? await Task.sleep(for: .seconds(3))
                if !Task.isCancelled, self.fitPhase == .replied { self.fitPhase = .none }
            } catch {
                if self.connection === connection, self.watchedPane == pane { self.fitPhase = .none }
            }
        }
    }

    /// Fit switched off while viewing: give the pane back to herdr's size.
    func releaseFit() {
        fitTask?.cancel()
        fitPhase = .none
        guard let pane = watchedPane, let connection else { return }
        fitIntent += 1
        let intent = fitIntent
        Task { try? await connection.releaseFit(pane: pane, intent: intent) }
    }

    // MARK: Input

    private func perform(_ operation: @escaping @Sendable (FlowConnection) async throws -> Void) {
        guard let connection else { lastError = FlowError.notConnected.errorDescription; return }
        Task {
            do { try await operation(connection) } catch { if self.connection === connection { self.report(error, from: connection) } }
        }
    }

    func sendKeys(_ keys: [String]) {
        guard let pane = watchedPane, !keys.isEmpty else { return }
        perform { try await $0.sendKeys(pane: pane, keys: keys) }
    }

    /// With "Tell me when it's done" on, a prompt to an agent pane arms the finished alert in the same request.
    func sendPrompt(_ text: String) {
        guard let pane = watchedPane, !text.isEmpty else { return }
        let notify = !isDemo && FlowSettings.notifyOnPrompt && (self.pane(pane)?.hasAgent ?? false)
        if notify { notifyDone.insert(pane) }
        perform { try await $0.sendPrompt(pane: pane, text: text, notify: notify) }
    }

    func sendText(_ text: String) {
        guard let pane = watchedPane, !text.isEmpty else { return }
        perform { try await $0.sendText(pane: pane, text: text) }
    }

    /// The setting changed while a pane is open: re-watch the pane with the new flag, so the change goes through the
    /// bridge's zoom ownership. A bare `zoom` would zoom the desktop but leave no lease, so leaving would not restore
    /// the split and a reconnect would not re-apply it.
    func setZoomWhileViewing(_ on: Bool) {
        zoomWhileViewing = on
        guard let pane = watchedPane, let connection else { return }
        watchIntent += 1
        let intent = watchIntent
        Task {
            // `zoomWhileViewing` is the newest intent (set synchronously above by the latest toggle). Rapid on↔off
            // toggles spawn independent, unordered tasks; a stale one whose `on` no longer matches must not run last
            // and re-watch with the wrong flag, which `watch` would then remember and restore after a reconnect.
            guard self.connection === connection, self.watchedPane == pane, self.zoomWhileViewing == on else { return }
            do { _ = try await connection.watch(pane: pane, zoom: on, intent: intent) }
            catch FlowError.superseded { } // a newer watch/stop replaced it; nothing to report
            catch { self.report(error, from: connection) }
        }
    }

    // MARK: Approvals

    func approve(pane: String, promptId: String, action: ApprovalAction, feedback: String? = nil, force: Bool = false) {
        guard let connection else { lastError = FlowError.notConnected.errorDescription; return }
        approvalInFlight = promptId
        approvalResults[promptId] = nil
        lastApprovalAttempt[promptId] = ApprovalAttempt(action: action, feedback: feedback)
        Task {
            do {
                try await connection.approve(pane: pane, promptId: promptId, action: action, feedback: feedback, force: force)
            } catch {
                guard self.connection === connection else { return }
                if self.approvalInFlight == promptId { self.approvalInFlight = nil }
                self.report(error, from: connection)
            }
        }
    }

    /// Answer the dialog by its option number: the bridge moves the desktop cursor there and presses Enter.
    func choose(pane: String, promptId: String, option: Int, label: String) {
        guard let connection else { lastError = FlowError.notConnected.errorDescription; return }
        approvalInFlight = promptId
        approvalResults[promptId] = nil
        lastApprovalAttempt[promptId] = nil
        Task {
            do {
                try await connection.choose(pane: pane, promptId: promptId, option: option, label: label)
            } catch {
                guard self.connection === connection else { return }
                if self.approvalInFlight == promptId { self.approvalInFlight = nil }
                self.report(error, from: connection)
            }
        }
    }

    /// "Send anyway" after `signature_mismatch`: repeat the last attempt with `force: true`.
    func retryForced(pane: String, promptId: String) {
        guard let attempt = lastApprovalAttempt[promptId] else { return }
        approve(pane: pane, promptId: promptId, action: attempt.action, feedback: attempt.feedback, force: true)
    }

    // MARK: "Tell me when it's done"

    func isArmed(_ pane: String) -> Bool { notifyDone.contains(pane) }

    /// Arm or disarm the finished alert for this phone on a pane; the bridge's answer wins.
    func setNotifyDone(_ pane: String, _ done: Bool) async {
        guard !isDemo else { showNotice("Notifications require a paired host"); return }
        guard let connection else { lastError = FlowError.notConnected.errorDescription; return }
        do {
            let armed = try await connection.notifyDone(pane: pane, done: done)
            guard self.connection === connection else { return }
            if armed { notifyDone.insert(pane) } else { notifyDone.remove(pane) }
        } catch {
            report(error, from: connection)
        }
    }

    /// A "finished" push reached this phone: the bridge has disarmed the pane.
    func onDoneDelivered(_ pane: String) { notifyDone.remove(pane) }

    /// A reply typed into a notification armed the pane again.
    func onArmedFromNotification(_ pane: String) { notifyDone.insert(pane) }

    // MARK: History (scrollback)

    func loadHistory(lines: Int = 500) {
        guard let connection, let pane = watchedPane, !isLoadingHistory else { return }
        isLoadingHistory = true
        let count = min(max(lines, 1), 999)
        Task {
            defer { if self.connection === connection { self.isLoadingHistory = false } }
            do {
                let message = try await connection.history(pane: pane, lines: count)
                guard self.connection === connection, self.watchedPane == pane else { return }
                if message.scrollback == 0 {
                    // herdr holds nothing above the screen: `recent` is the live view again. Stay live and say so
                    // (programs that draw their own screen scroll with the wheel instead).
                    self.history = nil
                    self.showNoScrollbackHint()
                    return
                }
                self.grid.mergeStyles(message.styles)
                self.history = TerminalGrid(historyLines: message.lines, cols: self.grid.cols, styles: self.grid.styles)
                self.historyHasMore = message.hasMore && count < 999
                self.historyLines = count
            } catch {
                self.report(error, from: connection)
            }
        }
    }

    private func showNoScrollbackHint() {
        noScrollbackHintTask?.cancel()
        noScrollbackHint = true
        noScrollbackHintTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(8))
            guard !Task.isCancelled else { return }
            self?.noScrollbackHint = false
        }
    }

    func dismissNoScrollbackHint() {
        noScrollbackHintTask?.cancel()
        noScrollbackHint = false
    }

    /// Near the top of the loaded scrollback: fetch a bigger window (herdr caps a read at 999 lines).
    func loadMoreHistory() {
        guard history != nil, historyHasMore, !isLoadingHistory else { return }
        loadHistory(lines: min(historyLines * 2, 999))
    }

    func jumpToLive() { history = nil }

    // MARK: New terminal

    /// Creates a herdr tab (optionally running `command`) and opens it; nil (with `lastError` set) on failure.
    func createPane(label: String?, command: String?) async -> String? {
        guard let connection else {
            lastError = FlowError.notConnected.errorDescription
            return nil
        }
        do {
            let pane = try await connection.createPane(label: label, command: command)
            guard self.connection === connection else { return nil }
            navigationPath = [pane]
            return pane
        } catch {
            report(error, from: connection)
            return nil
        }
    }

    /// Ends the pane's shell on the desktop (herdr `pane.close`); leaves the pane view if it was open. `title` names the
    /// pane in the "closed" notice (the caller's, as last shown; else the snapshot's, empty once the pane is gone).
    func closePane(_ id: String, title: String? = nil) async {
        guard let connection else {
            lastError = FlowError.notConnected.errorDescription
            return
        }
        let title = title ?? pane(id).map { Theme.sessionTitle(for: $0) } ?? ""
        do {
            try await connection.closePane(id)
        } catch let error as FlowError {
            guard self.connection === connection else { return }
            // Already gone (exit typed, or closed from elsewhere a moment ago): nothing to report.
            if case .server(let code, _) = error, code == .unknownPane { /* closed all the same */ } else {
                // The user asked for this: a connection lost between the confirmation and the request is said, not
                // swallowed as `report` does for background work (Android toasts the same failure).
                if error == .notConnected || error == .closed { lastError = error.errorDescription } else { report(error, from: connection) }
                return
            }
        } catch {
            return report(error, from: connection)
        }
        guard self.connection === connection else { return }
        if navigationPath.contains(id) { navigationPath = [] }
        showNotice(closedNotice(title: title))
    }

    private func closedNotice(title: String) -> String { title.isEmpty ? "terminal closed" : "\(title) closed" }

    func showNotice(_ text: String, ok: Bool = false) {
        let shown = Notice(text: text, ok: ok)
        notice = shown
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(2400))
            if self?.notice == shown { self?.notice = nil }
        }
    }

    // MARK: Scroll mode (swipe → phone scrollback, or forwarded to the program)

    /// The user's choice for the pane (what the menu shows).
    func scrollMode(for pane: String) -> ScrollMode { (isDemo ? demoScrollModes[pane] : scrollModes[pane]) ?? .auto }

    /// What applies right now: `.auto` is wheel while an alternate-screen program has the pane, scrollback otherwise.
    func effectiveScrollMode(for pane: String) -> ScrollMode {
        let mode = scrollMode(for: pane)
        guard mode == .auto else { return mode }
        return paneAlt[pane] == true ? .wheel : .scrollback
    }

    func setScrollMode(_ mode: ScrollMode, for pane: String) {
        if isDemo { demoScrollModes[pane] = mode }
        else {
            scrollModes[pane] = mode
            UserDefaults.standard.set(scrollModes.mapValues(\.rawValue), forKey: Self.scrollModesKey)
        }
        if effectiveScrollMode(for: pane) != .scrollback, watchedPane == pane { history = nil }
    }

    /// `lines` wheel steps or arrow keys in `direction` at the touched cell (1-based), per the pane's effective mode.
    func scroll(direction: String, lines: Int, col: Int, row: Int) {
        guard let pane = watchedPane, lines > 0 else { return }
        let mode = effectiveScrollMode(for: pane)
        guard mode != .scrollback else { return }
        perform { try await $0.scroll(pane: pane, direction: direction, lines: lines, mode: mode.rawValue, col: col, row: row) }
    }

    // MARK: Push

    func setPushToken(_ hex: String) {
        pushTokenHex = hex
        registerPushIfNeeded()
    }

    func registerPushIfNeeded() {
        guard !isDemo else { return }
        guard let connection, connectionState == .connected, let token = pushTokenHex, registeredPushToken != token else { return }
        registeredPushToken = token
        let env = PushEnvironmentDetector.current
        Task {
            do {
                try await connection.registerPush(token: token, env: env)
                guard self.connection === connection else { return }
                self.pushRegistered = true
                self.syncActivityTokens()
            } catch {
                guard self.connection === connection else { return }
                self.registeredPushToken = nil
                self.report(error, from: connection)
            }
        }
    }

    func requestNotifications() async -> Bool {
        guard !isDemo else { return false }
        let granted = await FlowNotifications.requestAuthorization(requireUnlock: FlowSettings.requireUnlock)
        if granted { UIApplication.shared.registerForRemoteNotifications() }
        return granted
    }

    // MARK: Live Activities

    /// Collects the push-to-start token (iOS 17.2+) and every activity's update token; idempotent, off while the setting is off.
    func startObservingActivities() {
        guard !isDemo else { return }
        guard activityStartTokenTask == nil, FlowSettings.liveActivities else { return }
        for activity in Activity<FlowActivityAttributes>.activities { observe(activity) }
        activityStartTokenTask = Task { @MainActor [weak self] in
            guard #available(iOS 17.2, *) else { return }
            for await data in Activity<FlowActivityAttributes>.pushToStartTokenUpdates {
                guard let self else { return }
                self.pushToStartToken = Self.hex(data)
                self.syncActivityTokens()
            }
        }
        activityUpdatesTask = Task { @MainActor [weak self] in
            for await activity in Activity<FlowActivityAttributes>.activityUpdates {
                guard let self else { return }
                self.observe(activity)
            }
        }
    }

    private func observe(_ activity: Activity<FlowActivityAttributes>) {
        let pane = activity.attributes.pane
        if let token = activity.pushToken {
            activityTokens[pane] = Self.hex(token)
            syncActivityTokens()
        }
        let updates = activity.pushTokenUpdates
        Task { @MainActor [weak self] in
            for await data in updates {
                guard let self else { return }
                self.activityTokens[pane] = Self.hex(data)
                self.syncActivityTokens()
            }
            self?.activityTokens[pane] = nil // the stream ends with the activity
        }
    }

    /// Hands the bridge every token it has not seen yet: over the live connection once `push.register` went through
    /// (the bridge requires that first), or, when the app was woken in the background by a push-to-start activity and
    /// has no connection, over a short action connection before iOS suspends it again.
    private func syncActivityTokens() {
        guard !isDemo else { return }
        guard FlowSettings.liveActivities else { return }
        var pending: [(pane: String?, token: String)] = []
        if let token = pushToStartToken, !syncedActivityTokens.contains("start:\(token)") { pending.append((nil, token)) }
        for (pane, token) in activityTokens where !syncedActivityTokens.contains("\(pane):\(token)") { pending.append((pane, token)) }
        guard !pending.isEmpty else { return }
        let keys = pending.map { item in item.pane.map { "\($0):\(item.token)" } ?? "start:\(item.token)" }
        if let connection, connectionState == .connected, pushRegistered {
            syncedActivityTokens.formUnion(keys)
            Task {
                for item in pending { try? await connection.registerActivity(token: item.token, pane: item.pane) }
            }
        } else if !isForeground, let host {
            syncedActivityTokens.formUnion(keys)
            let client = AppInfo.clientInfo(deviceName: UIDevice.current.name)
            let lifetime = realConnectionLifetime
            Task {
                let background = UIApplication.shared.beginBackgroundTask(withName: "flow.activity-token", expirationHandler: nil)
                let ok = await ActivityTokenClient.register(pending, host: host, client: client, lifetime: lifetime)
                if !ok, self.realConnectionLifetime === lifetime { self.syncedActivityTokens.subtract(keys) } // the next connection retries
                UIApplication.shared.endBackgroundTask(background)
            }
        }
        // Foreground without a registered connection: registerPushIfNeeded() calls back here once push.register succeeds.
    }

    /// The live snapshot is the truth while the app is open: activities of panes that are no longer working or blocked
    /// (or gone) end now, and a pane keeps only the activity the bridge holds the token for. Covers a bridge that lost
    /// the token (restart before the app could hand it over) and duplicate starts.
    private func reconcileActivities() {
        guard !isDemo else { return }
        guard let snapshot else { return }
        let statuses = Dictionary(uniqueKeysWithValues: snapshot.panes.map { ($0.id, $0.agentStatus) })
        var keep: [String: Activity<FlowActivityAttributes>] = [:]
        var doomed: [Activity<FlowActivityAttributes>] = []
        for activity in Activity<FlowActivityAttributes>.activities {
            let pane = activity.attributes.pane
            let status = statuses[pane]
            guard status == .working || status == .blocked else { doomed.append(activity); continue }
            let known = activityTokens[pane]
            let isKnown = known != nil && activity.pushToken.map(Self.hex) == known
            if let current = keep[pane] {
                if isKnown { doomed.append(current); keep[pane] = activity } else { doomed.append(activity) }
            } else {
                keep[pane] = activity
            }
        }
        guard !doomed.isEmpty else { return }
        // Ended from inside the task, found again by id: an `Activity` is not Sendable, so handing the collected ones
        // over to the task is a data race to the compiler (Xcode 26.6); the ids are plain strings.
        let doomedIDs = Set(doomed.map(\.id))
        Task {
            for activity in Activity<FlowActivityAttributes>.activities where doomedIDs.contains(activity.id) {
                await activity.end(nil, dismissalPolicy: .immediate)
            }
        }
    }

    /// Settings toggle. Off: the bridge stops pushing (`activity.unregister` without a pane) and current activities end at once.
    func setLiveActivities(_ on: Bool) {
        guard !isDemo else { return }
        if on {
            syncedActivityTokens = []
            startObservingActivities()
            syncActivityTokens()
        } else {
            activityStartTokenTask?.cancel()
            activityStartTokenTask = nil
            activityUpdatesTask?.cancel()
            activityUpdatesTask = nil
            syncedActivityTokens = []
            if let connection { Task { try? await connection.unregisterActivity(pane: nil) } }
            Task {
                for activity in Activity<FlowActivityAttributes>.activities {
                    await activity.end(nil, dismissalPolicy: .immediate)
                }
            }
        }
    }

    private static func hex(_ data: Data) -> String { data.map { String(format: "%02x", $0) }.joined() }
}

/// Where a `fit` of the watched pane stands (drives the "Fitting…" pill).
enum FitPhase {
    case none, sent, replied
}

/// How a vertical swipe on a pane behaves. Raw values are the protocol's `scroll.mode` (except `scrollback`, which sends nothing).
/// `rawValue` is the wire `mode` of a `scroll` request; `.auto` is never sent, it resolves to wheel or scrollback first.
enum ScrollMode: String, CaseIterable, Identifiable {
    case auto, scrollback, wheel, arrows
    var id: String { rawValue }
    var label: String {
        switch self {
        case .auto: return "Automatic"
        case .scrollback: return "Scrollback on this phone"
        case .wheel: return "Mouse wheel to the program"
        case .arrows: return "Arrow keys to the program"
        }
    }
}

extension Pane {
    /// Shown under "Needs you" (§4.3): blocked, and an agent's pane (a plain shell has no approval to give). The same
    /// rule decides what the tab sections leave out.
    var needsYou: Bool { isBlocked && hasAgent }
}

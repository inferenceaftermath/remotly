// WebSocket client for the Remotly bridge (shared/protocol/remotly-protocol.md §1, §4, §6).
//
// One actor owns the URLSessionWebSocketTask. Requests get a client-chosen `id` and resume a
// continuation on `ok` / `error` / `history`; server events are published on `events`. The actor
// pings every 15 s and treats a ping without a pong (5 s), a `hello` without a `welcome` (3 s) or a connect
// attempt older than 10 s as a dead socket, reconnects with 0.5 s → 10 s backoff, re-sends `watch`, `fit`
// and `viewing` after each `welcome`, and stops for good on close code 4401 (state `.unpaired`).
//
// Every socket belongs to a generation. Its receive loop, ping deadline and cleanup act only while it is
// the current generation, so a socket that ends late cannot touch its replacement: URLSession can take
// minutes to report a lost connection, its async `receive` need not end on cancel and its async `send`
// can hang (Apple forums 678384, 713812, 726676), so sends and receives go through completion-handler
// calls whose continuations the actor resolves itself when it drops the socket. `stop()` and `suspend()`
// never wait for the network; `resume()` (foreground) trusts a connected socket only if it has heard
// from the bridge within one ping round, and pings it otherwise.
import Foundation
#if canImport(Network)
import Network
#endif
#if canImport(os)
import os
#endif

public actor FlowConnection {
    public static let pingInterval: Duration = .seconds(15)
    /// A ping without a pong within this long means the socket is dead (URLSession itself may not say so for minutes).
    public static let pongTimeout: Duration = .seconds(5)
    /// `hello` handed to the socket and no `welcome` back within this long: give the attempt up and try again (a bridge
    /// answers within milliseconds; one that took the socket and stays silent is gone). A stall before the `hello` is
    /// even handed over falls to `attemptTimeout`; should the bridge's own 5 s hello timer win that race, its close
    /// 4408 is an ordinary drop (`bridge/src/server/session.ts` HELLO_TIMEOUT_MS), never a "re-pair".
    public static let welcomeTimeout: Duration = .seconds(3)
    /// A connect attempt (socket opened, handshake, `hello` handed over, `welcome`) older than this is abandoned:
    /// covers a `send` that never completes and a handshake into a path that is not up yet.
    public static let attemptTimeout: Duration = .seconds(10)
    /// A connect attempt older than this is abandoned when the app returns to the foreground (a handshake into a
    /// Tailscale path that is not up yet can hang for URLSession's 20 s request timeout).
    public static let resumeAbandonsAttemptAfter: Duration = .seconds(3)
    public static let minBackoff: Double = 0.5
    public static let maxBackoff: Double = 10
    /// A `watch` / `unwatch` / `pane.close` reply can trail several of the bridge's serialised herdr operations —
    /// leaving the old pane (fit + zoom off), applying/reading the new one's zoom and size, the close itself — each
    /// bounded by herdr's own ~10 s request timeout (`bridge/src/herdr/client.ts`), and it can queue behind another
    /// session turn's herdr work too, so the true latency has no fixed upper bound. This is therefore a generous
    /// backstop, not a proof the bridge did nothing: it sits well above the ping/pong liveness window so a still-live
    /// bridge is given time to answer, while a dead socket still fails its pending requests at once through
    /// `failIO()`. When it does fire on a lease mutation the reply is genuinely ambiguous — the bridge may have taken
    /// the watch and, honouring the named pane, a later `unwatch` could not stop it — so `expire` drops the socket to
    /// force the bridge to dispose the session (releasing its leases) and let a clean reconnect reconcile, rather than
    /// leaving a ghost watch that streams and holds leases.
    public static let leaseRequestTimeout: Duration = .seconds(45)

    /// Delay before reconnect attempt `attempt` (1-based): 0.5 s, 1 s, 2 s … capped at 10 s.
    public static func backoff(attempt: Int) -> Double {
        min(maxBackoff, minBackoff * pow(2, Double(max(0, attempt - 1))))
    }

    /// A connected socket that has heard nothing (message or pong) for longer than one ping round is not trusted
    /// when the app comes back: it is replaced instead of pinged. Never heard anything counts as stale.
    public static func isStale(lastInbound: ContinuousClock.Instant?, now: ContinuousClock.Instant) -> Bool {
        guard let lastInbound else { return true }
        return now - lastInbound > pingInterval + pongTimeout
    }

    /// Server events and state changes. Single consumer.
    public nonisolated let events: AsyncStream<ConnectionEvent>
    private let sink: AsyncStream<ConnectionEvent>.Continuation

    private let host: PairedHost
    private let client: ClientInfo
    private let mode: HelloMode
    private let session: URLSession
    private let decoder = JSONDecoder()

    public private(set) var state: ConnectionState = .idle
    private var task: URLSessionWebSocketTask?
    private var runLoop: Task<Void, Never>?
    private var pingTask: Task<Void, Never>?
    /// Bumped by every start, stop and restart; work of an older generation returns without touching state.
    private var generation = 0
    /// Reconnect attempt within the current generation: 0 is the first try ("Connecting…"), reset on `welcome`.
    private var attempt = 0
    /// When the current connect attempt began (nil while none is in flight).
    private var attemptStartedAt: ContinuousClock.Instant?
    /// The generation sleeping out a backoff right now, if any (a network change or the foreground ends the wait).
    private var backoffGeneration: Int?
    private var stopped = true
    private var welcomed = false
    private var sawAuthError = false
    /// A 4401 refused this token for good (protocol §1): no further sockets from this connection, whatever the
    /// lifecycle does; only a new pairing (a new connection) clears it.
    private var authRejected = false
    /// In-flight completion-handler sends and receives by id: the actor resolves them itself when it drops the
    /// socket (URLSession may never call back for a lost connection), and a late real completion finds nothing.
    private var sends: [Int: CheckedContinuation<Void, Error>] = [:]
    private var receives: [Int: CheckedContinuation<String?, Error>] = [:]
    private var ioSeq = 0
    private var pending: [String: CheckedContinuation<ServerMessage, Error>] = [:]
    private var nextId = 0
    /// Last message or pong from the bridge on the current socket.
    private var lastInbound: ContinuousClock.Instant?
    private var pingSeq = 0
    /// Sequence of the ping whose pong is outstanding, if any; its deadline decides the socket's fate.
    private var awaitingPong: Int?
    /// Counts sockets opened; a welcome deadline applies to the socket it was armed for, not a later attempt of the
    /// same generation.
    private var socketSeq = 0
    /// The pane this device wants watched (set before the `watch` goes out; re-sent after every reconnect).
    private var watchedPane: String?
    /// The pane the bridge confirmed watching, from its replies: a `watch` it refuses (herdr down, pane gone) leaves
    /// its previous one in place, so this can differ from `watchedPane`.
    private var confirmedPane: String?
    /// What a pending request's `ok` will mean for `confirmedPane`, by request id (applied as the reply is read).
    private var watchEffects: [String: WatchEffect] = [:]
    /// Ids of pending lease-mutating requests (watch / unwatch / fit / release). A send failure or a timeout on one is
    /// ambiguous — the bridge may have applied it — so `deliver` / `expire` drop the socket to reconcile. Superset of
    /// `watchEffects` (fit / release change no `confirmedPane` but still hold a lease).
    private var leaseRequests: Set<String> = []
    /// `watch` and `unwatch` go out one at a time, each after the previous reply, so the bridge sees them in the order
    /// they were meant: two in flight (the restore after a reconnect and a tap, or a tap and the unwatch of the pane
    /// left) used to race on a bridge that ran their handlers concurrently and kept whichever finished last. The bridge
    /// serialises them too since 2026-09-12; the phone keeps its own order so an older bridge behaves as well.
    private var controlQueue: Task<Void, Never>?
    /// `zoom` flag of the current watch, re-sent with it after a reconnect.
    private var watchZoom = false
    private var viewingPane: String?
    /// The newest `setViewing` epoch applied; older ones are dropped so an out-of-order stale update cannot win.
    private var lastViewingEpoch = 0
    /// Newest applied intent for the watched pane (`watch`/`stopWatching`) and for its fit (`fit`/`releaseFit`). The UI
    /// issues these from independent tasks whose hops to this actor are not ordered, so a stale one — a `watch(A)` that
    /// crossed a switch away, a `fit` that crossed a `release` — is rejected here rather than winning by arriving last.
    private var watchIntent = 0
    private var fitIntent = 0
    /// Grid imposed on the watched pane via `fit`; re-sent after every reconnect.
    /// The size the phone last imposed on the pane it is fitting, tagged with that pane so a reconnect restores it only
    /// for the pane still wanted (never A's dimensions onto B) and a switch does not forget a fit already taken for the
    /// new pane.
    private var fitSize: (pane: String, cols: Int, rows: Int)?
    #if canImport(Network)
    private var pathMonitor: NWPathMonitor?
    #endif
    #if canImport(os)
    private static let logger = Logger(subsystem: "com.inferenceaftermath.remotly", category: "connection")
    #endif

    public init(host: PairedHost, client: ClientInfo, mode: HelloMode = .full) {
        self.host = host
        self.client = client
        self.mode = mode
        let (stream, continuation) = AsyncStream<ConnectionEvent>.makeStream(bufferingPolicy: .unbounded)
        events = stream
        sink = continuation
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 20
        config.waitsForConnectivity = false
        session = URLSession(configuration: config, delegate: PinningSessionDelegate(fingerprint: host.fingerprint), delegateQueue: nil)
    }

    deinit {
        sink.finish()
        session.invalidateAndCancel()
    }

    // MARK: Lifecycle

    /// Connects (or reconnects at once, skipping any backoff) and keeps the connection alive until `stop()`.
    public func start() {
        restart(attempt: 0, reason: "start")
    }

    /// Closes the socket and stops reconnecting. `start()` resumes and re-watches.
    public func stop() {
        stopped = true
        generation += 1
        runLoop?.cancel()
        runLoop = nil
        attemptStartedAt = nil
        backoffGeneration = nil
        closeSocket()
        stopPathMonitor()
        setState(authRejected ? .unpaired : .stopped)
        log("stop")
    }

    /// The app is back in the foreground. A connected socket that has heard from the bridge within one ping round is
    /// pinged now (the pong deadline replaces it if the bridge stays silent); one that has not is replaced at once,
    /// since URLSession reports a connection lost while the phone slept only minutes later, if at all. A backoff wait
    /// ends now, and a connect attempt that has been hanging for a few seconds is abandoned for a fresh one.
    public func resume() {
        switch state {
        case .connected:
            if FlowConnection.isStale(lastInbound: lastInbound, now: ContinuousClock.now) {
                restart(attempt: 1, reason: "resume: silent socket")
            } else {
                ping(generation: generation)
            }
        case .connecting, .reconnecting:
            let hanging = attemptStartedAt.map { ContinuousClock.now - $0 > FlowConnection.resumeAbandonsAttemptAfter } ?? true
            if backoffGeneration == generation || hanging { restart(attempt: attempt, reason: "resume") }
        case .idle, .stopped:
            restart(attempt: 0, reason: "resume")
        case .unpaired:
            break // 4401 is final (protocol §1): the same token would be refused again; pairing again clears it
        }
    }

    /// The app went to the background: tell the bridge this device is not looking at any pane (best effort, not
    /// awaited: the close that follows means the same to the bridge), then close and stop reconnecting. Nothing
    /// here waits for the network, so a `resume()` that follows always finds the connection stopped.
    public func suspend() {
        if welcomed, let task, let text = try? ClientMessage.viewing(pane: nil, id: nil).encoded() {
            task.send(.string(text)) { _ in }
        }
        stop()
    }

    /// Drop whatever socket there is and connect again under a fresh generation. `attempt` seeds the state shown
    /// (0 "Connecting…", 1+ "Reconnecting… · attempt n") and the backoff should this attempt fail too.
    private func restart(attempt initial: Int, reason: String) {
        if authRejected {
            setState(.unpaired)
            return
        }
        stopped = false
        generation += 1
        let gen = generation
        attempt = initial
        backoffGeneration = nil
        runLoop?.cancel()
        closeSocket()
        startPathMonitor()
        log("restart gen=\(gen) attempt=\(initial) reason=\(reason)")
        runLoop = Task { await self.run(generation: gen) }
    }

    private func run(generation gen: Int) async {
        while !Task.isCancelled && !stopped && gen == generation {
            setState(attempt == 0 ? .connecting : .reconnecting(attempt: attempt))
            let outcome = await connectOnce(generation: gen)
            guard gen == generation, !stopped, !Task.isCancelled else { return }
            if outcome.unpaired {
                authRejected = true
                stopped = true
                closeSocket()
                stopPathMonitor()
                setState(.unpaired)
                log("unpaired gen=\(gen)")
                return
            }
            if outcome.welcomed { attempt = 0 }
            attempt += 1
            let delay = FlowConnection.backoff(attempt: attempt)
            backoffGeneration = gen
            try? await Task.sleep(for: .seconds(delay))
            if backoffGeneration == gen { backoffGeneration = nil }
        }
    }

    private struct Outcome { var welcomed: Bool; var unpaired: Bool }
    private enum WatchEffect { case watching(String), notWatching }

    private func connectOnce(generation gen: Int) async -> Outcome {
        let socket = session.webSocketTask(with: host.webSocketURL)
        socket.maximumMessageSize = 1 << 20
        task = socket
        welcomed = false
        sawAuthError = false
        lastInbound = nil
        awaitingPong = nil
        attemptStartedAt = ContinuousClock.now
        socketSeq += 1
        let seq = socketSeq
        socket.resume()
        armDeadline(FlowConnection.attemptTimeout, socket: seq, reason: "attempt timeout")
        // Send the hello and start reading at once, instead of awaiting the send's completion first. A bad token is
        // answered with `error auth` + close 4401, and that send's completion can hang while the socket closes;
        // blocking on it would miss the rejection already sitting in the receive buffer, and a refused token would
        // look like a generic dropped attempt instead of latching `.unpaired`. The receive loop below reads the
        // rejection either way (sets `sawAuthError` or sees close 4401). On a clean send the child arms the tighter
        // `welcomeTimeout`; until then the `attemptTimeout` bounds a handshake that stalls with nothing sent.
        let sender = Task { [weak self] in
            await self?.sendHello(on: socket, socket: seq, generation: gen)
        }
        var sawWelcome = false
        while !stopped && gen == generation {
            let text: String?
            do {
                text = try await receive(from: socket)
            } catch {
                break
            }
            // A socket that delivers late (after a restart replaced it) must not touch its replacement's state.
            guard gen == generation, task === socket else { break }
            lastInbound = ContinuousClock.now
            guard let text else { continue }
            handle(text: text)
            if welcomed { sawWelcome = true }
            if sawAuthError { break }
        }
        sender.cancel()
        let unpaired = sawAuthError || socket.closeCode.rawValue == 4401
        // Latch here, in the same actor step that observes the rejection, not only back in `run()` after the await:
        // the token cannot change without a new `FlowConnection`, so any 4401 on it is final. Were it deferred, a
        // `suspend()` / `restart()` landing on the turn boundary before `run()` resumes would bump the generation,
        // `run()` would discard this outcome, and `stop()` would publish `.stopped` — so foregrounding would retry a
        // token the bridge has already refused.
        if unpaired { authRejected = true }
        finish(socket, generation: gen)
        return Outcome(welcomed: sawWelcome, unpaired: unpaired)
    }

    /// One receive, tracked: `failIO()` resolves it if the socket is dropped first; a completion arriving after
    /// that finds nothing to resume. Only one receive is ever outstanding, so message order is kept. Yields the
    /// message text (nil for a non-UTF-8 binary frame); the `Message` value itself stays in the completion handler.
    private func receive(from socket: URLSessionWebSocketTask) async throws -> String? {
        ioSeq += 1
        let id = ioSeq
        return try await withCheckedThrowingContinuation { continuation in
            receives[id] = continuation
            socket.receive { [weak self] result in
                let text: Result<String?, any Error> = result.map { message in
                    switch message {
                    case .string(let s): return s
                    case .data(let d): return String(data: d, encoding: .utf8)
                    @unknown default: return nil
                    }
                }
                Task { await self?.receiveCompleted(id, result: text) }
            }
        }
    }

    private func receiveCompleted(_ id: Int, result: Result<String?, any Error>) {
        receives.removeValue(forKey: id)?.resume(with: result)
    }

    /// One send, tracked the same way, so a `send` that never calls back cannot hold a task forever.
    private func send(_ message: URLSessionWebSocketTask.Message, on socket: URLSessionWebSocketTask) async throws {
        ioSeq += 1
        let id = ioSeq
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            sends[id] = continuation
            socket.send(message) { [weak self] error in
                Task { await self?.sendCompleted(id, error: error) }
            }
        }
    }

    private func sendCompleted(_ id: Int, error: (any Error)?) {
        guard let continuation = sends.removeValue(forKey: id) else { return }
        if let error {
            continuation.resume(throwing: error)
        } else {
            continuation.resume()
        }
    }

    /// Resolve every in-flight send and receive of the socket being dropped, so no task waits on URLSession forever.
    private func failIO() {
        let outstandingSends = sends
        sends.removeAll()
        for (_, continuation) in outstandingSends { continuation.resume(throwing: FlowError.closed) }
        let outstandingReceives = receives
        receives.removeAll()
        for (_, continuation) in outstandingReceives { continuation.resume(throwing: FlowError.closed) }
    }

    /// End `socket`. Only the current socket's end clears the shared per-connection state: an older socket that
    /// ends late must not clear its replacement's `welcomed`, cancel its ping or fail its pending requests.
    private func finish(_ socket: URLSessionWebSocketTask, generation gen: Int) {
        socket.cancel(with: .normalClosure, reason: nil)
        guard gen == generation, task === socket else { return }
        task = nil
        attemptStartedAt = nil
        resetSocketState()
        failIO()
        failAllPending(.closed)
        log("socket closed gen=\(gen) code=\(socket.closeCode.rawValue)")
    }

    private func closeSocket() {
        if let task {
            task.cancel(with: .normalClosure, reason: nil)
            self.task = nil
        }
        attemptStartedAt = nil
        resetSocketState()
        failIO()
        failAllPending(.closed)
    }

    private func resetSocketState() {
        welcomed = false
        awaitingPong = nil
        lastInbound = nil
        confirmedPane = nil // the bridge drops the watch with the socket
        pingTask?.cancel()
        pingTask = nil
    }

    private func setState(_ newState: ConnectionState) {
        guard newState != state else { return }
        state = newState
        sink.yield(.state(newState))
    }

    // MARK: Liveness

    /// Socket `seq` must be welcomed within `timeout`, else the attempt is given up: a handshake or send that never
    /// completes, or a bridge that accepted the socket and went quiet, would otherwise hold "Connecting…" forever.
    /// Applies to that socket only, not to a later attempt of the same generation. The socket is dropped, not
    /// replaced at once: its run loop sees the attempt fail and applies the backoff, so a path that accepts sockets
    /// and answers nothing is retried at 0.5 s → 10 s, not every few seconds.
    private func armDeadline(_ timeout: Duration, socket seq: Int, reason: String) {
        Task { [weak self] in
            try? await Task.sleep(for: timeout)
            await self?.deadlinePassed(socket: seq, reason: reason)
        }
    }

    /// Send the `hello` on the socket it was made for, then arm the tighter welcome deadline. Bound to `socket` (not
    /// `self.task`), and guarded on generation / sequence / socket identity before it registers the send, so a sender
    /// that only runs after a `restart()` replaced the socket does nothing — it cannot send a duplicate hello on the
    /// replacement (whose own sender handles it) or leave a hung send continuation attached to it. The welcome
    /// deadline is armed only while this socket is still current and not yet welcomed; until then `attemptTimeout`
    /// covers a stalled send.
    private func sendHello(on socket: URLSessionWebSocketTask, socket seq: Int, generation gen: Int) async {
        guard !Task.isCancelled, gen == generation, seq == socketSeq, task === socket else { return }
        do {
            let text = try ClientMessage.hello(token: host.token, client: client, mode: mode).encoded()
            try await send(.string(text), on: socket)
        } catch {
            return // the receive loop or a deadline ends the attempt; there is nothing to arm
        }
        guard gen == generation, seq == socketSeq, task === socket, !stopped, !welcomed else { return }
        armDeadline(FlowConnection.welcomeTimeout, socket: seq, reason: "no welcome")
    }

    private func deadlinePassed(socket seq: Int, reason: String) {
        guard seq == socketSeq, task != nil, !stopped, !welcomed else { return }
        log("\(reason) gen=\(generation) attempt=\(attempt)")
        closeSocket() // the pending receive fails with `.closed`; `connectOnce` returns and `run` backs off
    }

    private func startPing(generation gen: Int) {
        pingTask?.cancel()
        pingTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: FlowConnection.pingInterval)
                if Task.isCancelled { return }
                await self?.ping(generation: gen)
            }
        }
    }

    /// One ping with a pong deadline. `sendPing`'s own error comes late or never for a lost connection, so the
    /// deadline is what detects a dead socket; a pong in time also counts as hearing from the bridge.
    private func ping(generation gen: Int) {
        guard gen == generation, welcomed, let task else { return }
        if awaitingPong != nil { return } // one ping in flight at a time; its deadline decides
        pingSeq += 1
        let seq = pingSeq
        awaitingPong = seq
        task.sendPing { [weak self] error in
            Task { await self?.pong(seq: seq, generation: gen, error: error) }
        }
        Task { [weak self] in
            try? await Task.sleep(for: FlowConnection.pongTimeout)
            await self?.pongDeadline(seq: seq, generation: gen)
        }
    }

    private func pong(seq: Int, generation gen: Int, error: (any Error)?) {
        guard gen == generation, awaitingPong == seq else { return } // an older socket's pong, or a repeat
        awaitingPong = nil
        if let error {
            log("ping failed gen=\(gen): \(error.localizedDescription)")
            restart(attempt: 1, reason: "ping failed")
            return
        }
        lastInbound = ContinuousClock.now
    }

    private func pongDeadline(seq: Int, generation gen: Int) {
        guard gen == generation, awaitingPong == seq else { return }
        awaitingPong = nil
        log("no pong within \(FlowConnection.pongTimeout) gen=\(gen)")
        restart(attempt: 1, reason: "no pong")
    }

    /// The network path changed (Tailscale up after unlock, Wi-Fi ↔ cellular): a backoff wait ends now, and a
    /// connected socket is pinged in case it died with the old path. The same nudge Android gets from its
    /// default-network callback.
    private func pathChanged(satisfied: Bool) {
        guard satisfied, !stopped else { return }
        if backoffGeneration == generation {
            restart(attempt: attempt, reason: "network changed")
        } else if state == .connected {
            ping(generation: generation)
        }
    }

    private func startPathMonitor() {
        #if canImport(Network)
        guard pathMonitor == nil else { return }
        let monitor = NWPathMonitor()
        monitor.pathUpdateHandler = { [weak self] path in
            let satisfied = path.status == .satisfied
            Task { await self?.pathChanged(satisfied: satisfied) }
        }
        monitor.start(queue: DispatchQueue(label: "com.inferenceaftermath.remotly.path", qos: .utility))
        pathMonitor = monitor
        #endif
    }

    private func stopPathMonitor() {
        #if canImport(Network)
        pathMonitor?.cancel()
        pathMonitor = nil
        #endif
    }

    /// Lifecycle breadcrumbs (Console.app, subsystem com.inferenceaftermath.remotly): generations, reasons and close
    /// codes only, never tokens or pane text.
    private nonisolated func log(_ message: String) {
        #if canImport(os)
        FlowConnection.logger.info("\(message, privacy: .public)")
        #endif
    }

    // MARK: Inbound

    private func handle(text: String) {
        let message: ServerMessage
        do {
            message = try decoder.decode(ServerMessage.self, from: Data(text.utf8))
        } catch {
            return
        }
        switch message {
        case .welcome(let welcome):
            onWelcome(welcome)
        case .ok(let ok):
            resolve(id: ok.id, with: .ok(ok))
        case .error(let error):
            if let id = error.id {
                fail(id: id, error: .server(code: error.code, message: error.message))
            } else if error.code == .auth {
                sawAuthError = true
            }
        case .history(let history):
            if pending[history.id] != nil {
                resolve(id: history.id, with: .history(history))
            } else {
                sink.yield(.history(history))
            }
        case .snapshot(let snapshot): sink.yield(.snapshot(snapshot))
        case .paneStatus(let status): sink.yield(.paneStatus(status))
        case .frame(let frame): sink.yield(.frame(frame))
        case .approvalResult(let result): sink.yield(.approvalResult(result))
        case .notifyState(let ns): sink.yield(.notifyState(pane: ns.pane, done: ns.done))
        case .herdr(let herdr): sink.yield(.herdr(isUp: herdr.isUp))
        case .unknown: break
        }
    }

    private func onWelcome(_ welcome: Welcome) {
        welcomed = true
        attempt = 0
        attemptStartedAt = nil
        let gen = generation
        let seq = socketSeq
        setState(.connected)
        sink.yield(.welcome(welcome))
        startPing(generation: gen)
        log("welcome gen=\(gen)")
        if watchedPane != nil {
            Task {
                // The pane wanted is read when this runs, not at the welcome: a tap during the reconnect changes it. A
                // `watch` or `unwatch` the user makes meanwhile queues behind this one (`controlQueue`) and has the
                // last word, so one restore is enough; a refused watch is left to its caller's retry.
                guard gen == self.generation, let pane = self.watchedPane else { return }
                // Re-issue the restore at the current intents so a `watch`/`stopWatching` (or `fit`/`releaseFit`) the
                // user makes during the reconnect, which advanced the intent, still supersedes this replay. Pinned to
                // this socket so a restore that waited in the FIFO across a reconnect does not fire on the replacement.
                guard (try? await self.watch(pane: pane, zoom: self.watchZoom, intent: self.watchIntent, pinnedSocket: seq)) != nil else { return }
                guard gen == self.generation, self.watchedPane == pane, self.confirmedPane == pane else { return }
                guard let fit = self.fitSize, fit.pane == pane else { return } // only restore a fit still for this pane
                _ = try? await self.fit(pane: pane, cols: fit.cols, rows: fit.rows, intent: self.fitIntent)
            }
        }
        if viewingPane != nil {
            Task {
                // Bound to the socket that welcomed: a suspend/restart may install a replacement before this replay
                // runs, and a `viewing` sent on it before its own `hello` is read as "message before hello" and closed
                // 4401 — latching a good token as unpaired. Send only while this exact socket is still current and
                // welcomed; `transmit` then goes out on it, not on the replacement.
                guard gen == self.generation, seq == self.socketSeq, self.welcomed else { return }
                _ = try? await self.transmit(.viewing(pane: self.viewingPane, id: nil))
            }
        }
    }

    // MARK: Outbound

    private func transmit(_ message: ClientMessage) async throws {
        guard let task else { throw FlowError.notConnected }
        let text = try message.encoded()
        try await send(.string(text), on: task)
    }

    private func request(timeout: Duration = .seconds(15), lease: Bool = false, watchEffect: WatchEffect? = nil, requireViewing: String? = nil, _ make: (String) -> ClientMessage) async throws -> ServerMessage {
        guard welcomed, task != nil else { throw FlowError.notConnected }
        nextId += 1
        let id = String(nextId)
        let message = make(id)
        let socket = socketSeq
        if let watchEffect { watchEffects[id] = watchEffect }
        if lease || watchEffect != nil { leaseRequests.insert(id) }
        return try await withCheckedThrowingContinuation { continuation in
            pending[id] = continuation
            Task { await self.deliver(message, id: id, socket: socket, requireViewing: requireViewing) }
            Task { await self.expire(id: id, after: timeout) }
        }
    }

    /// Sends a request on the socket it was made for, and only while its caller is still waiting: a request whose
    /// socket was replaced meanwhile has already failed with `.closed` and must not run on the next one (it could be
    /// a `pane.close` or a prompt), nor go out before that socket's `welcome`. `requireViewing` (a `fit`) is dropped
    /// unsent if the UI has since switched away from that pane.
    private func deliver(_ message: ClientMessage, id: String, socket seq: Int, requireViewing: String?) async {
        guard pending[id] != nil else { return }
        guard seq == socketSeq, welcomed, task != nil else { fail(id: id, error: .closed); return }
        // A `fit` is checked against the pane still viewed at the moment it goes out, not only when it was issued: the
        // send is deferred to this task, so a switch (its `setViewing` transmit) can slip in between. Dropping the fit
        // here — with no suspension before the frame reaches the socket — keeps a stale fit off the wire, so it cannot
        // land after the new pane's `viewing` cleanup and leave a ghost fit lease on the pane switched away from.
        if let requireViewing, viewingPane != requireViewing { fail(id: id, error: .superseded); return }
        do {
            try await transmit(message)
        } catch {
            // A lease mutation whose send failed is ambiguous the same way a timed-out one is (see `expire`): the
            // bridge may have received and applied the frame before the socket faulted, leaving a watcher, fit or zoom
            // a later request cannot stop. Drop the socket — if it is still this one, and was not already torn down by
            // `finish` (which clears `leaseRequests`) — so the bridge disposes the session and a fresh attempt
            // reconciles. A non-lease request just fails; its caller retries.
            let wasLeaseMutation = leaseRequests.contains(id)
            fail(id: id, error: .closed)
            if wasLeaseMutation, seq == socketSeq, task != nil {
                log("lease request \(id) send failed; dropping socket to reconcile")
                closeSocket()
            }
        }
    }

    private func expire(id: String, after timeout: Duration) async {
        try? await Task.sleep(for: timeout)
        guard pending[id] != nil else { return } // already answered
        // A watch / unwatch that ran out of time is ambiguous: queueing on the bridge (behind another watch's own
        // serialised herdr work) makes the reply latency effectively unbounded, so the `leaseRequestTimeout` is a
        // backstop, not a proof the bridge did nothing. The bridge may still establish the watch, and — since it
        // honours the named pane — a later `unwatch` cannot stop it: a ghost that streams and holds its leases. Drop
        // the socket so the bridge disposes that session (releasing its leases and stopping the watcher); the run loop
        // reconnects and `onWelcome` re-watches the pane still wanted, and re-fits it, from a clean, empty queue.
        let wasLeaseMutation = leaseRequests.contains(id)
        fail(id: id, error: .timeout)
        if wasLeaseMutation {
            log("lease request \(id) timed out; dropping socket to reconcile")
            closeSocket()
        }
    }

    private func resolve(id: String, with message: ServerMessage) {
        // Applied here, as the reply is read, so `confirmedPane` follows the bridge's order even when two callers'
        // continuations resume in another order.
        leaseRequests.remove(id)
        if let effect = watchEffects.removeValue(forKey: id), case .ok = message {
            switch effect {
            case .watching(let pane): confirmedPane = pane
            case .notWatching: confirmedPane = nil
            }
        }
        pending.removeValue(forKey: id)?.resume(returning: message)
    }

    private func fail(id: String, error: FlowError) {
        watchEffects.removeValue(forKey: id)
        leaseRequests.remove(id)
        pending.removeValue(forKey: id)?.resume(throwing: error)
    }

    private func failAllPending(_ error: FlowError) {
        watchEffects.removeAll()
        leaseRequests.removeAll()
        let all = pending
        pending.removeAll()
        for (_, continuation) in all { continuation.resume(throwing: error) }
    }

    private func expectOK(_ reply: ServerMessage) throws -> OKMessage {
        guard case .ok(let ok) = reply else { throw FlowError.unexpectedReply }
        return ok
    }

    /// Runs `body` after every earlier `controlled` body has finished (see `controlQueue`). A body that fails does not
    /// hold the next one up, and a request that dies with its socket ends quickly, so the queue always drains. `body`
    /// is formed on this actor and runs on it, in the caller's own task, so it reads actor state directly. The queued
    /// handle is only a signal that ends with this turn: an actor-isolated closure must not be carried into a `Task`
    /// (Swift 6 rejects it as a `sending` violation), and the turn's place in line is taken synchronously here.
    private func controlled<T: Sendable>(_ body: () async throws -> T) async throws -> T {
        let previous = controlQueue
        let (turnEnded, signal) = AsyncStream<Void>.makeStream()
        controlQueue = Task { for await _ in turnEnded {} }
        defer { signal.finish() }
        await previous?.value
        return try await body()
    }

    // MARK: Requests (§4)

    /// Starts watching `pane` (replacing any previous watch); a full frame follows the `ok`. With `zoom` the
    /// bridge zooms the pane on the desktop while this device looks at it and restores the split when it leaves.
    /// `pinnedSocket` (the reconnect restore in `onWelcome`) makes the watch run only if that exact socket is still
    /// current when its turn reaches the front of the queue: a restore delayed in the FIFO across a backoff reconnect
    /// must not send its watch on the replacement socket, which is already restoring the pane itself.
    public func watch(pane: String, zoom: Bool = false, intent: Int, pinnedSocket: Int? = nil) async throws -> WatchResult {
        guard intent >= watchIntent else { throw FlowError.superseded } // a newer watch/stop already decided the pane
        watchIntent = intent
        if fitSize?.pane != pane { fitSize = nil } // drop a fit for the pane we are leaving; keep one already taken for this one
        watchedPane = pane
        watchZoom = zoom
        return try await controlled {
            guard pinnedSocket == nil || pinnedSocket == self.socketSeq else { throw FlowError.superseded }
            let reply: ServerMessage
            do {
                reply = try await self.request(timeout: FlowConnection.leaseRequestTimeout, watchEffect: .watching(pane)) { .watch(id: $0, pane: pane, zoom: zoom) }
            } catch {
                // The bridge refuses a watch (herdr down, unknown pane) before dropping its current one, so a failed
                // switch would leave the previous pane streaming, and zoomed on the desktop, for nobody: release it
                // now. Safe even if this was a timeout on a watch that took hold late, since the bridge only unwatches
                // the pane named (`stale`), not whatever it ended on. Skipped when a newer `watch` is queued behind
                // this one; its outcome decides.
                if let stale = self.confirmedPane, stale != pane, self.watchedPane == pane {
                    _ = try? await self.request(timeout: FlowConnection.leaseRequestTimeout, watchEffect: .notWatching) { .unwatch(id: $0, pane: stale) }
                }
                throw error
            }
            let ok = try self.expectOK(reply)
            return WatchResult(cols: ok.cols ?? 0, rows: ok.rows ?? 0, zoomed: ok.zoomed)
        }
    }

    public func unwatch(pane: String) async throws {
        // Another pane is wanted already: this stale unwatch would be answered `not_watching` by the bridge (which now
        // honours the pane), so there is nothing to do; `stopWatching()` is the way to drop the current pane.
        guard watchedPane == pane || watchedPane == nil else { return }
        if watchedPane == pane {
            watchedPane = nil
            fitSize = nil
        }
        try await controlled {
            _ = try self.expectOK(try await self.request(timeout: FlowConnection.leaseRequestTimeout, watchEffect: .notWatching) { .unwatch(id: $0, pane: pane) })
        }
    }

    /// The UI is looking at no pane: drop whatever pane is watched and forget it, so a reconnect does not restore it.
    /// Unwatches the pane the connection actually watches, which can differ from the one the UI last asked for when a
    /// `watch` was skipped (the pane was switched away before its `watch` went out).
    public func stopWatching(intent: Int) async {
        guard intent >= watchIntent else { return } // a newer watch already re-took a pane; do not undo it
        watchIntent = intent
        guard watchedPane != nil else { return }
        watchedPane = nil
        fitSize = nil
        try? await controlled {
            // Read the pane the bridge actually confirmed inside the turn, after any `watch` queued ahead has settled:
            // a switch that was in flight when the UI left may have taken hold (its pane is now confirmed) or been
            // refused (the previous pane is still confirmed). Unwatch whatever the bridge ended on, not the pane the UI
            // last desired, so a refused switch cannot leave the previous pane streaming with nobody looking at it.
            guard let current = self.confirmedPane else { return }
            _ = try self.expectOK(try await self.request(timeout: FlowConnection.leaseRequestTimeout, watchEffect: .notWatching) { .unwatch(id: $0, pane: current) })
        }
    }

    public func history(pane: String, lines: Int, unwrapped: Bool = false) async throws -> HistoryMessage {
        let reply = try await request(timeout: .seconds(20)) { .history(id: $0, pane: pane, lines: lines, unwrapped: unwrapped) }
        guard case .history(let history) = reply else { throw FlowError.unexpectedReply }
        return history
    }

    public func sendKeys(pane: String, keys: [String]) async throws {
        _ = try expectOK(try await request { .keys(id: $0, pane: pane, keys: keys) })
    }

    /// Open a new terminal on the desktop, typing `command` into it once its shell is up; returns the new pane id.
    public func createPane(label: String?, command: String?) async throws -> String {
        let ok = try expectOK(try await request(timeout: .seconds(15)) { .paneCreate(id: $0, label: label, command: command) })
        guard let pane = ok.pane else { throw FlowError.unexpectedReply }
        return pane
    }

    /// Close a pane on the desktop: its shell and whatever runs in it end.
    public func closePane(_ pane: String) async throws {
        // The bridge leaves the pane (fit + zoom off) before it closes it, each step bounded by herdr's ~10 s timeout,
        // so give the reply the same room as watch/unwatch or the app reports a failure the bridge then carries out.
        _ = try expectOK(try await request(timeout: FlowConnection.leaseRequestTimeout) { .paneClose(id: $0, pane: pane) })
    }

    /// Forward a swipe to the program as `lines` wheel reports (at cell `col`,`row`, 1-based) or arrow keys.
    public func scroll(pane: String, direction: String, lines: Int, mode: String, col: Int, row: Int) async throws {
        _ = try expectOK(try await request { .scroll(id: $0, pane: pane, direction: direction, lines: lines, mode: mode, col: col, row: row) })
    }

    public func sendText(pane: String, text: String) async throws {
        _ = try expectOK(try await request { .text(id: $0, pane: pane, text: text) })
    }

    /// `notify` also arms "tell me when it's done" for this device on the pane.
    public func sendPrompt(pane: String, text: String, notify: Bool = false) async throws {
        _ = try expectOK(try await request { .prompt(id: $0, pane: pane, text: text, notify: notify) })
    }

    /// Arm or disarm the "tell me when it's done" alert; returns the arming now in force.
    public func notifyDone(pane: String, done: Bool) async throws -> Bool {
        let ok = try expectOK(try await request { .notify(id: $0, pane: pane, done: done) })
        return ok.done ?? done
    }

    /// Hands the bridge a Live Activity token: the push-to-start token (`pane == nil`) or an activity's update token.
    public func registerActivity(token: String, pane: String?) async throws {
        _ = try expectOK(try await request { .activityRegister(id: $0, token: token, pane: pane) })
    }

    /// Forget one activity's token, or (`pane == nil`) opt this device out of Live Activities altogether.
    public func unregisterActivity(pane: String?) async throws {
        _ = try expectOK(try await request { .activityUnregister(id: $0, pane: pane) })
    }

    /// The `ok` comes back at once; the outcome arrives later as `.approvalResult`.
    public func approve(pane: String, promptId: String, action: ApprovalAction, feedback: String? = nil, force: Bool = false) async throws {
        _ = try expectOK(try await request {
            .approve(id: $0, pane: pane, promptId: promptId, action: action, feedback: feedback, force: force)
        })
    }

    /// Answer a dialog by option number; the outcome arrives as `approval.result` like an approve.
    public func choose(pane: String, promptId: String, option: Int, label: String) async throws {
        _ = try expectOK(try await request { .choose(id: $0, pane: pane, promptId: promptId, option: option, label: label) })
    }

    /// Returns the pane's zoom state after the change.
    public func zoom(pane: String, mode: ZoomMode = .toggle) async throws -> Bool {
        let ok = try expectOK(try await request { .zoom(id: $0, pane: pane, mode: mode) })
        return ok.zoomed ?? false
    }

    /// Resize the pane's PTY on the desktop to this device's grid (§4 `fit`). Remembered for reconnects.
    public func fit(pane: String, cols: Int, rows: Int, intent: Int) async throws -> WatchResult {
        guard intent >= fitIntent else { throw FlowError.superseded } // a newer fit/release already decided the size
        // Only the pane the UI is viewing is fitted. `viewingPane` is set synchronously by `setViewing`, which runs
        // before the (debounced) fit and before the network `watch`, so — unlike `watchedPane`, which lags behind a
        // slow `setViewing` send — it names the desired pane in time: a fit for a pane switched away is rejected here
        // (no ghost fit lease left behind), while the first fit of a freshly opened pane is accepted.
        guard pane == viewingPane else { throw FlowError.superseded }
        fitIntent = intent
        fitSize = (pane: pane, cols: cols, rows: rows)
        // Serialise fit/release on the same FIFO as watch/unwatch, so their frames reach the bridge in call order: the
        // bridge applies fit/release last-write-wins in arrival order, and two independent `deliver` tasks could
        // otherwise reach it reversed and leave a pane fitted after the user released or switched. Re-check intent and
        // pane inside the turn — a newer fit/release, or a switch away, queued behind this one drops this send.
        return try await controlled {
            guard intent >= self.fitIntent, pane == self.viewingPane else { throw FlowError.superseded }
            let ok = try self.expectOK(try await self.request(timeout: FlowConnection.leaseRequestTimeout, lease: true, requireViewing: pane) { .fit(id: $0, pane: pane, cols: cols, rows: rows, release: false) })
            return WatchResult(cols: ok.cols ?? cols, rows: ok.rows ?? rows)
        }
    }

    /// Give the pane back to herdr's own size.
    public func releaseFit(pane: String, intent: Int) async throws {
        guard intent >= fitIntent else { throw FlowError.superseded } // a newer fit already re-took the size; do not undo it
        fitIntent = intent
        if fitSize?.pane == pane { fitSize = nil } // forget the remembered size only for the pane being released
        try await controlled {
            guard intent >= self.fitIntent else { throw FlowError.superseded } // a newer fit queued behind won the size
            _ = try self.expectOK(try await self.request(timeout: FlowConnection.leaseRequestTimeout, lease: true) { .fit(id: $0, pane: pane, cols: nil, rows: nil, release: true) })
        }
    }

    /// Fire-and-forget; remembered and re-sent after every reconnect. `epoch` is bumped by the UI on every start/stop
    /// of viewing, so an out-of-order stale update (a `setViewing(nil)` for a pane just left, arriving after a fresher
    /// `setViewing(B)`) is dropped rather than left as the remembered value — which would make the bridge push "done"
    /// alerts for the pane actually open and re-send the wrong `viewing` after a reconnect.
    public func setViewing(_ pane: String?, epoch: Int) async {
        guard epoch >= lastViewingEpoch else { return }
        lastViewingEpoch = epoch
        viewingPane = pane
        guard welcomed else { return }
        _ = try? await transmit(.viewing(pane: pane, id: nil))
    }

    public func registerPush(token: String, env: PushEnvironment) async throws {
        _ = try expectOK(try await request { .pushRegister(id: $0, platform: client.platform, token: token, env: env) })
    }

    public func unregisterPush() async throws {
        _ = try expectOK(try await request { .pushUnregister(id: $0) })
    }
}

// The connection's reconnect policy: backoff schedule and the "is this connected socket still trusted on resume"
// rule. The socket path itself (URLSessionWebSocketTask) is exercised on device.
import FlowKit
import XCTest

final class ConnectionPolicyTests: XCTestCase {
    func testBackoffDoublesFromHalfASecondAndCapsAtTen() {
        XCTAssertEqual(FlowConnection.backoff(attempt: 1), 0.5)
        XCTAssertEqual(FlowConnection.backoff(attempt: 2), 1)
        XCTAssertEqual(FlowConnection.backoff(attempt: 3), 2)
        XCTAssertEqual(FlowConnection.backoff(attempt: 5), 8)
        XCTAssertEqual(FlowConnection.backoff(attempt: 6), 10)
        XCTAssertEqual(FlowConnection.backoff(attempt: 40), 10, "the cap holds for any attempt count")
        XCTAssertEqual(FlowConnection.backoff(attempt: 0), 0.5, "a non-positive attempt never yields a shorter wait")
    }

    func testConnectedSocketIsStaleAfterOnePingRoundOfSilence() {
        let now = ContinuousClock.now
        let round = FlowConnection.pingInterval + FlowConnection.pongTimeout
        XCTAssertTrue(FlowConnection.isStale(lastInbound: nil, now: now), "never heard from the bridge")
        XCTAssertFalse(FlowConnection.isStale(lastInbound: now, now: now))
        XCTAssertFalse(FlowConnection.isStale(lastInbound: now - round + .seconds(1), now: now))
        XCTAssertTrue(FlowConnection.isStale(lastInbound: now - round - .seconds(1), now: now))
    }

    func testDeadlinesStayInsideTheBridgeTimers() {
        // The bridge terminates a socket silent for 45 s (protocol §1); the phone must notice a dead one sooner.
        XCTAssertLessThan(FlowConnection.pingInterval + FlowConnection.pongTimeout, .seconds(45))
        // A `hello` the bridge took but never answered is given up well before a whole attempt is; both deadlines stay
        // far under the idle timer. (The bridge's own 5 s hello timer closes with 4408, an ordinary drop, so no
        // ordering against it is needed.)
        XCTAssertLessThan(FlowConnection.welcomeTimeout, FlowConnection.attemptTimeout)
        XCTAssertLessThan(FlowConnection.attemptTimeout, .seconds(45))
    }

    func testLeaseRequestTimeoutIsAGenerousBackstopAboveLivenessDetection() {
        // A watch / unwatch / pane.close reply trails several of the bridge's herdr operations run in series (leaving
        // the old pane's fit and zoom, applying and reading the new pane's zoom and size, the close), each bounded by
        // herdr's ~10 s request timeout, and can queue behind another watch's own serialised work — so its latency is
        // not strictly bounded. The client keeps a generous timeout so a live-but-slow reply resolves in place, and on
        // expiry it drops the socket (a lease-mutation timeout is treated as ambiguous) so the bridge disposes that
        // session and a fresh reconnect re-establishes the watch, rather than leaving a ghost. This just pins the value
        // well above one keep-alive round, so a genuinely dead socket is still caught far sooner by the pong deadline
        // (and by `failIO()` on teardown) than this backstop fires.
        XCTAssertGreaterThanOrEqual(FlowConnection.leaseRequestTimeout, .seconds(40))
        XCTAssertLessThan(FlowConnection.pingInterval + FlowConnection.pongTimeout, FlowConnection.leaseRequestTimeout)
    }
}

// The pairing screen's answer to each camera read (ScanGate): a refused code is not sent again on the next frame.
import FlowKit
import XCTest

final class ScanGateTests: XCTestCase {
    private let codeA = "remotly://pair?u=wss://host.tailnet-example.ts.net:7460&c=ABCD2345&n=host"
    private let codeB = "remotly://pair?u=wss://host.tailnet-example.ts.net:7460&c=KMNP6789&n=host"
    private let foreign = "https://example.com/menu"
    private let t0 = Date(timeIntervalSince1970: 1_000_000)
    private func at(_ ms: Double) -> Date { t0.addingTimeInterval(ms / 1000) }

    func testValidCodeIsSentOnceAndReadsInFlightAreIgnored() throws {
        var g = ScanGate()
        guard case .pair(let payload) = g.scanned(codeA, now: at(0)) else { return XCTFail("expected .pair") }
        XCTAssertEqual(payload.code, "ABCD2345")
        XCTAssertEqual(g.inFlight, codeA)
        XCTAssertEqual(g.scanned(codeA, now: at(30)), .ignore)
        XCTAssertEqual(g.scanned(codeB, now: at(60)), .ignore, "one request at a time, whatever the code")
        XCTAssertEqual(g.scanned(foreign, now: at(90)), .ignore)
    }

    func testRefusedCodeIsNotSentAgainWhileInView() {
        var g = ScanGate()
        _ = g.scanned(codeA, now: at(0))
        g.failed("Wrong or expired pairing code.")
        XCTAssertEqual(g.paused, "Wrong or expired pairing code.")
        XCTAssertNil(g.inFlight)
        // The camera keeps reading the same QR several times a second; the old screen sent each read.
        for ms in [300.0, 600, 900, 1200, 1500, 5000, 60000] {
            XCTAssertEqual(g.scanned(codeA, now: at(ms)), .ignore, "at \(ms) ms")
        }
        XCTAssertEqual(g.paused, "Wrong or expired pairing code.")
    }

    func testDifferentCodeAfterFailureIsSentAtOnceAndEndsThePause() throws {
        var g = ScanGate()
        _ = g.scanned(codeA, now: at(0))
        g.failed("Wrong or expired pairing code.")
        guard case .pair(let payload) = g.scanned(codeB, now: at(500)) else { return XCTFail("expected .pair") }
        XCTAssertEqual(payload.code, "KMNP6789")
        XCTAssertNil(g.paused)
        XCTAssertEqual(g.inFlight, codeB)
    }

    func testResumeLetsTheSameCodeBeScannedAgain() {
        var g = ScanGate()
        _ = g.scanned(codeA, now: at(0))
        g.failed("Could not reach the host.")
        XCTAssertEqual(g.scanned(codeA, now: at(400)), .ignore)
        g.resume()
        XCTAssertNil(g.paused)
        guard case .pair = g.scanned(codeA, now: at(800)) else { return XCTFail("expected .pair") }
    }

    func testForeignQRIsNoticedOncePer2_4sAndNeverSent() {
        var g = ScanGate()
        XCTAssertEqual(g.scanned(foreign, now: at(0)), .notice)
        XCTAssertEqual(g.scanned(foreign, now: at(1000)), .ignore)
        XCTAssertEqual(g.scanned(foreign, now: at(2399)), .ignore)
        XCTAssertEqual(g.scanned(foreign, now: at(2400)), .notice)
        XCTAssertNil(g.inFlight)
        XCTAssertNil(g.paused)
    }

    func testForeignQRWhilePausedIsQuiet() {
        var g = ScanGate()
        _ = g.scanned(codeA, now: at(0))
        g.failed("Wrong or expired pairing code.")
        XCTAssertEqual(g.scanned(foreign, now: at(5000)), .ignore)
        XCTAssertEqual(g.paused, "Wrong or expired pairing code.")
    }

    func testFailedWithNothingInFlightChangesNothing() {
        var g = ScanGate()
        g.failed("Enter the host as host:port")
        XCTAssertNil(g.paused)
        guard case .pair = g.scanned(codeA, now: at(0)) else { return XCTFail("expected .pair") }
    }

    func testSuccessLeavesTheGateIdle() {
        var g = ScanGate()
        _ = g.scanned(codeA, now: at(0))
        g.succeeded()
        XCTAssertNil(g.inFlight)
        XCTAssertNil(g.paused)
    }
}

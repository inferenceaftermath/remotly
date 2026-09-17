// QR payload parsing (shared/protocol/remotly-protocol.md §3) and manual-entry normalisation.
import FlowKit
import XCTest

final class QRPayloadTests: XCTestCase {
    func testParsesPinnedPayload() throws {
        let text = "remotly://pair?u=wss%3A%2F%2F100.101.102.103%3A7460&fp=LPJNul-wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ&c=ABCD-EFGH&n=herdr-linux"
        let p = try XCTUnwrap(QRPayload(string: text))
        XCTAssertEqual(p.origin.absoluteString, "wss://100.101.102.103:7460")
        XCTAssertEqual(p.fingerprint, "LPJNul-wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ")
        XCTAssertEqual(p.code, "ABCDEFGH", "code is normalised: upper-case, no dashes/spaces")
        XCTAssertEqual(p.hostName, "herdr-linux")
        XCTAssertEqual(p.webSocketURL.absoluteString, "wss://100.101.102.103:7460/ws")
        XCTAssertEqual(p.restBaseURL.absoluteString, "https://100.101.102.103:7460")
    }

    func testParsesUnencodedPayloadWithoutFingerprint() throws {
        let text = "remotly://pair?u=wss://host.tailnet-example.ts.net:7460&c=k2m3n4p5&n=example+host+name"
        let p = try XCTUnwrap(QRPayload(string: text))
        XCTAssertNil(p.fingerprint, "no fp → publicly trusted certificate, nothing pinned")
        XCTAssertEqual(p.origin.host(), "host.tailnet-example.ts.net")
        XCTAssertEqual(p.origin.port, 7460)
        XCTAssertEqual(p.code, "K2M3N4P5")
        XCTAssertEqual(p.hostName, "example host name", "URLSearchParams encodes spaces as +")
    }

    func testEmptyFingerprintIsTreatedAsAbsent() throws {
        let p = try XCTUnwrap(QRPayload(string: "remotly://pair?u=wss://h:1&fp=&c=AAAA2222&n=h"))
        XCTAssertNil(p.fingerprint)
    }

    func testRejectsForeignOrIncompletePayloads() {
        XCTAssertNil(QRPayload(string: "https://example.com/pair?u=wss://h:1&c=AAAA2222"))
        XCTAssertNil(QRPayload(string: "remotly://other?u=wss://h:1&c=AAAA2222"))
        XCTAssertNil(QRPayload(string: "remotly://pair?c=AAAA2222"), "u is required")
        XCTAssertNil(QRPayload(string: "remotly://pair?u=wss://h:1"), "c is required")
        XCTAssertNil(QRPayload(string: "remotly://pair?u=wss://h:1&c=A"), "the code is 8 characters of the alphabet")
        XCTAssertNil(QRPayload(string: "remotly://pair?u=wss://h:1&c=AAAA2222&fp=short"), "a fingerprint, when present, is 43 base64url characters")
        XCTAssertNil(QRPayload(string: "remotly://pair?u=ftp://h:1&c=AAAA2222"), "only ws(s)/http(s) origins")
        XCTAssertNil(QRPayload(string: ""))
    }

    func testNormalizeOriginForManualEntry() {
        XCTAssertEqual(QRPayload.normalizeOrigin("100.101.102.103:7460")?.absoluteString, "wss://100.101.102.103:7460")
        XCTAssertEqual(QRPayload.normalizeOrigin("https://host.ts.net:7460/ws")?.absoluteString, "wss://host.ts.net:7460")
        XCTAssertEqual(QRPayload.normalizeOrigin(" wss://host:7460/ ")?.absoluteString, "wss://host:7460")
        XCTAssertEqual(QRPayload.normalizeOrigin("http://10.0.0.2:8080")?.absoluteString, "ws://10.0.0.2:8080")
        XCTAssertNil(QRPayload.normalizeOrigin(""))
        XCTAssertNil(QRPayload.normalizeOrigin("ftp://host:21"))
    }

    func testNormalizeCode() {
        XCTAssertEqual(QRPayload.normalizeCode(" ab cd-ef gh "), "ABCDEFGH")
    }
}

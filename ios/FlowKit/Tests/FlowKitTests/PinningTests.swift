// Fingerprint computation and comparison used for certificate pinning.
import FlowKit
import XCTest

final class PinningTests: XCTestCase {
    func testBase64URLSha256OfKnownBytes() {
        // sha256("hello") = 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
        XCTAssertEqual(CertificateFingerprint.base64URL(sha256Of: Data("hello".utf8)), "LPJNul-wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ")
        // sha256("") — contains characters that differ between base64 and base64url.
        XCTAssertEqual(CertificateFingerprint.base64URL(sha256Of: Data()), "47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU")
    }

    func testBase64URLHasNoPaddingOrUnsafeCharacters() {
        for length in 0..<70 {
            let s = CertificateFingerprint.base64URL(Data(repeating: 0xFB, count: length))
            XCTAssertFalse(s.contains("="), s)
            XCTAssertFalse(s.contains("+"), s)
            XCTAssertFalse(s.contains("/"), s)
        }
    }

    func testMatchesAcceptsBase64AndPaddedForms() {
        let canonical = "47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU"
        XCTAssertTrue(CertificateFingerprint.matches(canonical, expected: canonical))
        XCTAssertTrue(CertificateFingerprint.matches(canonical, expected: "47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU="))
        XCTAssertTrue(CertificateFingerprint.matches(canonical, expected: " 47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU \n"))
        XCTAssertFalse(CertificateFingerprint.matches(canonical, expected: "LPJNul-wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ"))
        XCTAssertFalse(CertificateFingerprint.matches("", expected: ""))
    }

    func testDelegateKeepsOnlyNonEmptyFingerprint() {
        XCTAssertNil(PinningSessionDelegate(fingerprint: "").fingerprint)
        XCTAssertNil(PinningSessionDelegate(fingerprint: nil).fingerprint)
        XCTAssertEqual(PinningSessionDelegate(fingerprint: "abc").fingerprint, "abc")
    }

    func testPairedHostURLs() throws {
        let host = PairedHost(name: "h", url: try XCTUnwrap(URL(string: "wss://100.101.102.103:7460")), fingerprint: "", token: "t", deviceId: "d")
        XCTAssertNil(host.fingerprint)
        XCTAssertFalse(host.isPinned)
        XCTAssertEqual(host.webSocketURL.absoluteString, "wss://100.101.102.103:7460/ws")
        XCTAssertEqual(host.restBaseURL.absoluteString, "https://100.101.102.103:7460")
        let data = try JSONEncoder().encode(host)
        XCTAssertEqual(try JSONDecoder().decode(PairedHost.self, from: data), host)
    }
}

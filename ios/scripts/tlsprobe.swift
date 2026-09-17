// TLS probe with the exact trust behaviour of the Remotly app, runnable on a Mac:
//   swift ios/scripts/tlsprobe.swift https://100.101.102.103:7460/health [expected-fingerprint]
// Prints the server-trust challenge (leaf fingerprint = base64url(SHA-256(leaf DER))), accepts the
// trust like PinningSessionDelegate does, then prints the HTTP result or the URLError with its
// underlying Security/CFNetwork codes. Use it to tell "the pin rejected the cert" apart from
// "Apple's TLS policy rejected the cert" (validity > 825 days, missing serverAuth EKU, …).
import CryptoKit
import Foundation
import Security

final class Probe: NSObject, URLSessionTaskDelegate {
    let expected: String?
    init(expected: String?) { self.expected = expected }

    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        let (d, c) = decide(challenge); completionHandler(d, c)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        let (d, c) = decide(challenge); completionHandler(d, c)
    }

    private func decide(_ challenge: URLAuthenticationChallenge) -> (URLSession.AuthChallengeDisposition, URLCredential?) {
        let method = challenge.protectionSpace.authenticationMethod
        guard method == NSURLAuthenticationMethodServerTrust, let trust = challenge.protectionSpace.serverTrust else {
            print("challenge \(method): default handling")
            return (.performDefaultHandling, nil)
        }
        let chain = (SecTrustCopyCertificateChain(trust) as? [SecCertificate]) ?? []
        print("server trust challenge: \(chain.count) certificate(s) in chain")
        for (i, cert) in chain.enumerated() {
            let der = SecCertificateCopyData(cert) as Data
            let fp = Data(SHA256.hash(data: der)).base64EncodedString()
                .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
            let summary = SecCertificateCopySubjectSummary(cert) as String? ?? "?"
            print("  [\(i)] \(summary)  sha256=\(fp)\(expected.map { $0 == fp ? "  (matches expected)" : "  (expected \($0))" } ?? "")")
        }
        var error: CFError?
        let systemTrusts = SecTrustEvaluateWithError(trust, &error)
        print("  system trust evaluation: \(systemTrusts ? "trusted" : "NOT trusted") \(error.map { "— \($0.localizedDescription)" } ?? "")")
        print("  → accepting trust (.useCredential), as the app does")
        return (.useCredential, URLCredential(trust: trust))
    }
}

let args = CommandLine.arguments
guard args.count >= 2, let url = URL(string: args[1]) else {
    print("usage: swift tlsprobe.swift https://host:port/health [expected-fingerprint]"); exit(2)
}
let probe = Probe(expected: args.count >= 3 ? args[2] : nil)
let config = URLSessionConfiguration.ephemeral
config.timeoutIntervalForRequest = 15
let session = URLSession(configuration: config, delegate: probe, delegateQueue: nil)
let done = DispatchSemaphore(value: 0)
print("GET \(url.absoluteString)")
let task = session.dataTask(with: url) { data, response, error in
    if let error = error as NSError? {
        print("FAILED: \(error.domain) \(error.code) — \(error.localizedDescription)")
        if let underlying = error.userInfo[NSUnderlyingErrorKey] as? NSError {
            print("  underlying: \(underlying.domain) \(underlying.code)")
            if let deeper = underlying.userInfo[NSUnderlyingErrorKey] as? NSError { print("  underlying: \(deeper.domain) \(deeper.code)") }
        }
        if let stream = error.userInfo["_kCFStreamErrorCodeKey"] { print("  kCFStreamErrorCode: \(stream) (SSL errors are -98xx, e.g. -9807 chain invalid, -9813 no root, -9843 hostname mismatch)") }
    } else if let http = response as? HTTPURLResponse {
        print("OK: HTTP \(http.statusCode) \(String(data: data ?? Data(), encoding: .utf8) ?? "")")
    }
    done.signal()
}
task.resume()
_ = done.wait(timeout: .now() + 30)

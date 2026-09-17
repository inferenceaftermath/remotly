// `env` for `push.register`: read `aps-environment` from the embedded provisioning profile when
// present (development → sandbox, production → production); fall back to the build configuration.
import FlowKit
import Foundation

enum PushEnvironmentDetector {
    static var current: PushEnvironment {
        if let env = embeddedProfileEnvironment() { return env }
        #if DEBUG
        return .sandbox
        #else
        return .production
        #endif
    }

    /// The profile is a CMS blob wrapping an XML plist; the plist text is readable as Latin-1 bytes.
    static func embeddedProfileEnvironment() -> PushEnvironment? {
        guard let url = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision"),
              let data = try? Data(contentsOf: url),
              let text = String(data: data, encoding: .isoLatin1) else { return nil }
        return parse(profileText: text)
    }

    static func parse(profileText text: String) -> PushEnvironment? {
        guard let keyRange = text.range(of: "<key>aps-environment</key>") else { return nil }
        let tail = text[keyRange.upperBound...]
        guard let open = tail.range(of: "<string>"), let close = tail.range(of: "</string>"),
              open.upperBound <= close.lowerBound else { return nil }
        let value = tail[open.upperBound..<close.lowerBound].trimmingCharacters(in: .whitespacesAndNewlines)
        switch value {
        case "development": return .sandbox
        case "production": return .production
        default: return nil
        }
    }
}

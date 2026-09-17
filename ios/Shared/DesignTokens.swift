// Design tokens of shared/design/DESIGN.md (§1 colours, §2 fonts, §3 status vocabulary). Compiled into the app and
// the FlowActivity widget extension, so the Lock Screen uses the same colours, font and words as the app. The app's
// `Theme` (Remotly/Views/Theme.swift) builds on this with FlowKit-typed helpers and the shared views.
import SwiftUI
import UIKit

enum DesignTokens {
    // MARK: §1 colours (dark only)

    /// Screen and terminal background: one colour, the terminal is flush.
    static let bg = Color(rgb: 0x0B0C0E)
    /// Cards: host banner, approval card, fields.
    static let panel = Color(rgb: 0x141618)
    /// Key caps, composer, option buttons, segmented control.
    static let panel2 = Color(rgb: 0x1B1E22)
    /// Hairlines and borders.
    static let line = Color(rgb: 0x262A2F)
    /// List row separators.
    static let separator = Color(rgb: 0x20242A)
    /// Status pill background.
    static let pillBg = Color(rgb: 0x191C20)
    /// Option button border, segmented "on" fill.
    static let raised = Color(rgb: 0x2E3238)
    static let fg = Color(rgb: 0xE0E2E5)
    static let fg2 = Color(rgb: 0xB4B9C0)
    static let fg3 = Color(rgb: 0x6E737B)
    /// Pane title, key cap glyphs.
    static let titleFg = Color(rgb: 0xD5D8DD)
    /// Teal: tool name, marked option border, Ctrl armed, viewfinder corners, Approve on the Lock Screen.
    static let accent = Color(rgb: 0x2DD4BF)
    static let accentWash = Color(rgb: 0x2DD4BF).opacity(0.08)
    /// Blue: back chevron, links, send button, Pair button, "+ New terminal", switches on.
    static let interactive = Color(rgb: 0x7AA2F7)
    /// Text on `interactive` and on `accent`.
    static let onInteractive = Color(rgb: 0x0B0C0E)
    static let blocked = Color(rgb: 0xF7768E)
    static let working = Color(rgb: 0xE0AF68)
    static let idle = Color(rgb: 0x7AA2F7)
    static let done = Color(rgb: 0x9ECE6A)
    static let toastBg = Color(rgb: 0xE0E2E5)
    static let toastFg = Color(rgb: 0x0B0C0E)
    /// Terminal text selection.
    static let selection = Color(rgb: 0x7AA2F7).opacity(0.35)

    // MARK: §3 status vocabulary

    /// Colour of a herdr agent status string (`fg3` for unknown / no agent).
    static func statusColor(_ status: String) -> Color {
        switch status {
        case "blocked": return blocked
        case "working": return working
        case "idle": return idle
        case "done": return done
        default: return fg3
        }
    }

    /// The fixed word for a status; nil for unknown / no agent (no pill).
    static func statusWord(_ status: String, isChoice: Bool = false) -> String? {
        switch status {
        case "blocked": return isChoice ? "Has a question" : "Waiting for approval"
        case "working": return "Working"
        case "idle": return "Idle"
        case "done": return "Done"
        default: return nil
        }
    }

    // MARK: §2 fonts

    static let monoRegularName = "JetBrainsMono-Regular"
    static let monoBoldName = "JetBrainsMono-Bold"

    /// JetBrains Mono at `size` points (scales with Dynamic Type like Android's sp); the system monospaced font when the
    /// bundled font is missing (a target without the resource).
    static func mono(_ size: CGFloat, bold: Bool = false) -> Font {
        let name = bold ? monoBoldName : monoRegularName
        if UIFont(name: name, size: size) != nil { return .custom(name, size: size) }
        return .system(size: size, weight: bold ? .bold : .regular, design: .monospaced)
    }

    static func monoUIFont(_ size: CGFloat, bold: Bool = false) -> UIFont {
        UIFont(name: bold ? monoBoldName : monoRegularName, size: size)
            ?? .monospacedSystemFont(ofSize: size, weight: bold ? .bold : .regular)
    }

    /// Elapsed time since `sinceMs` (milliseconds since the epoch) as `mm:ss`, `h:mm:ss` past an hour.
    static func elapsed(sinceMs: Int, now: Date = Date()) -> String {
        let seconds = max(0, Int(now.timeIntervalSince1970) - sinceMs / 1000)
        let h = seconds / 3600
        let m = (seconds % 3600) / 60
        let s = seconds % 60
        return h > 0 ? String(format: "%d:%02d:%02d", h, m, s) : String(format: "%02d:%02d", m, s)
    }
}

extension Color {
    /// `Color(rgb: 0xRRGGBB)` in sRGB.
    init(rgb: UInt32) {
        self.init(.sRGB,
                  red: Double((rgb >> 16) & 0xFF) / 255,
                  green: Double((rgb >> 8) & 0xFF) / 255,
                  blue: Double(rgb & 0xFF) / 255,
                  opacity: 1)
    }
}

extension UIColor {
    /// `UIColor(rgb: 0xRRGGBB)` in sRGB.
    convenience init(rgb: UInt32) {
        self.init(red: CGFloat((rgb >> 16) & 0xFF) / 255,
                  green: CGFloat((rgb >> 8) & 0xFF) / 255,
                  blue: CGFloat(rgb & 0xFF) / 255,
                  alpha: 1)
    }
}

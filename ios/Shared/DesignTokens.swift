// Design tokens of shared/design/DESIGN.md (§1 colours and themes, §2 fonts, §3 status vocabulary). Compiled into the
// app and the FlowActivity widget extension, so the Lock Screen uses the same colours, font and words as the app. The
// app's `Theme` (Remotly/Views/Theme.swift) builds on this with FlowKit-typed helpers and the shared views.
import Observation
import os
import SwiftUI
import UIKit

enum DesignTokens {
    // MARK: §1 colours (the selected theme's)

    /// The selected theme's colours. Reading them through the `ThemeStore` lets SwiftUI redraw every view that used
    /// one when the theme changes (Observation tracks the read).
    static var palette: Palette { ThemeStore.shared.choice.palette }

    /// Screen and terminal background: one colour, the terminal is flush.
    static var bg: Color { Color(rgb: palette.bg) }
    /// Cards: host banner, approval card, fields.
    static var panel: Color { Color(rgb: palette.panel) }
    /// Key caps, composer, option buttons, segmented control.
    static var panel2: Color { Color(rgb: palette.panel2) }
    /// Hairlines and borders.
    static var line: Color { Color(rgb: palette.line) }
    /// List row separators.
    static var separator: Color { Color(rgb: palette.separator) }
    /// Status pill background.
    static var pillBg: Color { Color(rgb: palette.pillBg) }
    /// Option button border, segmented "on" fill.
    static var raised: Color { Color(rgb: palette.raised) }
    static var fg: Color { Color(rgb: palette.fg) }
    static var fg2: Color { Color(rgb: palette.fg2) }
    static var fg3: Color { Color(rgb: palette.fg3) }
    /// Pane title, key cap glyphs.
    static var titleFg: Color { Color(rgb: palette.titleFg) }
    /// Teal: tool name, marked option border, Ctrl armed, viewfinder corners, Approve on the Lock Screen.
    static var accent: Color { Color(rgb: palette.accent) }
    static var accentWash: Color { accent.opacity(0.08) }
    /// Blue: back chevron, links, send button, Pair button, "+ New terminal", switches on.
    static var interactive: Color { Color(rgb: palette.interactive) }
    /// Text on `interactive` and on `accent`.
    static var onInteractive: Color { Color(rgb: palette.onInteractive) }
    static var blocked: Color { Color(rgb: palette.blocked) }
    static var working: Color { Color(rgb: palette.working) }
    static var idle: Color { Color(rgb: palette.idle) }
    static var done: Color { Color(rgb: palette.done) }
    /// Toast fill; the ok variant fills with `done`. `toastFg` is the text on both.
    static var toastBg: Color { Color(rgb: palette.toastBg) }
    static var toastFg: Color { Color(rgb: palette.toastFg) }
    /// Terminal text selection.
    static var selection: Color { interactive.opacity(0.35) }
    /// The system appearance under the theme: light or dark controls, keyboard, menus and status bar.
    static var colorScheme: ColorScheme { palette.isLight ? .light : .dark }

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

// MARK: - Themes (§1)

/// The themes Settings › Appearance offers (DESIGN.md §1). Dark is the default; Light reads best in sunlight.
enum ThemeChoice: String, CaseIterable, Identifiable, Sendable {
    case dark
    case light
    case catppuccinMocha = "catppuccin-mocha"

    var id: Self { self }

    /// The name Settings shows (the same words on Android).
    var title: String {
        switch self {
        case .dark: "Dark"
        case .light: "Light"
        case .catppuccinMocha: "Catppuccin Mocha"
        }
    }

    var palette: Palette {
        switch self {
        case .dark: .dark
        case .light: .light
        case .catppuccinMocha: .catppuccinMocha
        }
    }
}

/// One theme's colours as 0xRRGGBB: every token of DESIGN.md §1, the terminal's ANSI 0–15, and the contrast floor
/// terminal text is lifted to.
struct Palette: Sendable {
    var isLight: Bool
    var bg: UInt32
    var panel: UInt32
    var panel2: UInt32
    var line: UInt32
    var separator: UInt32
    var pillBg: UInt32
    var raised: UInt32
    var fg: UInt32
    var fg2: UInt32
    var fg3: UInt32
    var titleFg: UInt32
    var accent: UInt32
    var interactive: UInt32
    var onInteractive: UInt32
    var blocked: UInt32
    var working: UInt32
    var idle: UInt32
    var done: UInt32
    var toastBg: UInt32
    var toastFg: UInt32
    /// ANSI 0–15; 16–255 are the standard xterm cube and greys in every theme.
    var ansi: [UInt32]
    /// Terminal text below this WCAG contrast with its background is darkened (light background) or lightened (dark
    /// one) until it reaches it; 1 leaves every colour as the program sent it.
    var minimumContrast: Double

    /// The original look (Tokyo Night-derived, matched to the status colours).
    static let dark = Palette(
        isLight: false,
        bg: 0x0B0C0E, panel: 0x141618, panel2: 0x1B1E22, line: 0x262A2F, separator: 0x20242A, pillBg: 0x191C20,
        raised: 0x2E3238, fg: 0xE0E2E5, fg2: 0xB4B9C0, fg3: 0x6E737B, titleFg: 0xD5D8DD, accent: 0x2DD4BF,
        interactive: 0x7AA2F7, onInteractive: 0x0B0C0E, blocked: 0xF7768E, working: 0xE0AF68, idle: 0x7AA2F7,
        done: 0x9ECE6A, toastBg: 0xE0E2E5, toastFg: 0x0B0C0E,
        ansi: [0x1B2230, 0xF7768E, 0x9ECE6A, 0xE0AF68, 0x7AA2F7, 0xBB9AF7, 0x7DCFFF, 0xA9B1D6,
               0x414868, 0xF7768E, 0x9ECE6A, 0xE0AF68, 0x7AA2F7, 0xBB9AF7, 0x7DCFFF, 0xC0CAF5],
        minimumContrast: 1)

    /// White screen, near-black text, every colour at least 4.2 : 1 on its surface, for reading in sunlight. Programs on
    /// the desktop usually pick their colours for a dark background, so terminal text is lifted to 4.5 : 1.
    static let light = Palette(
        isLight: true,
        bg: 0xFFFFFF, panel: 0xF3F4F6, panel2: 0xE9EBEF, line: 0xD0D5DC, separator: 0xE4E7EB, pillBg: 0xF3F4F6,
        raised: 0xC3C9D1, fg: 0x16181D, fg2: 0x424852, fg3: 0x676E79, titleFg: 0x1F2329, accent: 0x0F766E,
        interactive: 0x2563EB, onInteractive: 0xFFFFFF, blocked: 0xC7254E, working: 0xB45309, idle: 0x2563EB,
        done: 0x1A7F37, toastBg: 0x16181D, toastFg: 0xFFFFFF,
        ansi: [0x24292F, 0xC7254E, 0x1A7F37, 0x9A6700, 0x2563EB, 0x8250DF, 0x0E7490, 0x6E7781,
               0x57606A, 0xA40E26, 0x116329, 0x7D4E00, 0x1D4ED8, 0x6639BA, 0x155E75, 0x8C959F],
        minimumContrast: 4.5)

    /// Catppuccin Mocha (catppuccin.com/palette): Base screen, Mantle cards, Surface 0–2 for caps and borders, Text and
    /// Subtext for words; the terminal uses Catppuccin's own Mocha ANSI colours.
    static let catppuccinMocha = Palette(
        isLight: false,
        bg: 0x1E1E2E, panel: 0x181825, panel2: 0x313244, line: 0x45475A, separator: 0x313244, pillBg: 0x181825,
        raised: 0x585B70, fg: 0xCDD6F4, fg2: 0xA6ADC8, fg3: 0x7F849C, titleFg: 0xBAC2DE, accent: 0x94E2D5,
        interactive: 0x89B4FA, onInteractive: 0x11111B, blocked: 0xF38BA8, working: 0xFAB387, idle: 0x89B4FA,
        done: 0xA6E3A1, toastBg: 0xCDD6F4, toastFg: 0x1E1E2E,
        ansi: [0x45475A, 0xF38BA8, 0xA6E3A1, 0xF9E2AF, 0x89B4FA, 0xF5C2E7, 0x94E2D5, 0xBAC2DE,
               0x585B70, 0xF38BA8, 0xA6E3A1, 0xF9E2AF, 0x89B4FA, 0xF5C2E7, 0x94E2D5, 0xA6ADC8],
        minimumContrast: 1)
}

/// The selected theme, kept in UserDefaults (`theme`). Observable, so SwiftUI redraws what read a token when it changes;
/// the value sits behind a lock so the tokens can be read from any context. The widget extension cannot read the app's
/// defaults and always uses Dark: the Live Activity and Dynamic Island keep the dark look (DESIGN.md §4.11).
final class ThemeStore: Observable, Sendable {
    static let shared = ThemeStore()
    static let key = "theme"

    private let registrar = ObservationRegistrar()
    private let state: OSAllocatedUnfairLock<ThemeChoice>

    private init() {
        #if REMOTLY_APP
        let saved = UserDefaults.standard.string(forKey: ThemeStore.key).flatMap(ThemeChoice.init(rawValue:))
        #else
        let saved: ThemeChoice? = nil
        #endif
        state = OSAllocatedUnfairLock(initialState: saved ?? .dark)
    }

    var choice: ThemeChoice {
        registrar.access(self, keyPath: \.choice)
        return state.withLock { $0 }
    }

    /// Switches the theme and remembers it.
    func select(_ choice: ThemeChoice) {
        guard choice != self.choice else { return }
        registrar.withMutation(of: self, keyPath: \.choice) {
            state.withLock { $0 = choice }
        }
        UserDefaults.standard.set(choice.rawValue, forKey: ThemeStore.key)
    }
}

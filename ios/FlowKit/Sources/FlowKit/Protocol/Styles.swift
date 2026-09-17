// Style table entries and colours of the Remotly protocol (shared/protocol/remotly-protocol.md §7).
import Foundation

// MARK: - Styles (§7)

/// Bitmask attributes of a style: 1 bold, 2 dim, 4 italic, 8 underline, 16 inverse, 32 strikethrough, 64 blink.
public struct StyleAttributes: OptionSet, Hashable, Sendable {
    public let rawValue: Int
    public init(rawValue: Int) { self.rawValue = rawValue }

    public static let bold = StyleAttributes(rawValue: 1)
    public static let dim = StyleAttributes(rawValue: 2)
    public static let italic = StyleAttributes(rawValue: 4)
    public static let underline = StyleAttributes(rawValue: 8)
    public static let inverse = StyleAttributes(rawValue: 16)
    public static let strikethrough = StyleAttributes(rawValue: 32)
    public static let blink = StyleAttributes(rawValue: 64)
}

public struct RGB: Hashable, Sendable {
    public var r: UInt8
    public var g: UInt8
    public var b: UInt8
    public init(_ r: UInt8, _ g: UInt8, _ b: UInt8) { self.r = r; self.g = g; self.b = b }
}

/// `fg`/`bg` values: `"d"` (default), `"p<n>"` (palette 0–255) or `"#rrggbb"`.
public enum TerminalColor: Hashable, Sendable {
    case `default`
    case palette(Int)
    case rgb(RGB)

    public init(wire: String) {
        if wire.hasPrefix("p"), let n = Int(wire.dropFirst()), (0...255).contains(n) {
            self = .palette(n)
        } else if wire.hasPrefix("#"), wire.count == 7, let v = UInt32(wire.dropFirst(), radix: 16) {
            self = .rgb(RGB(UInt8((v >> 16) & 0xFF), UInt8((v >> 8) & 0xFF), UInt8(v & 0xFF)))
        } else {
            self = .default
        }
    }

    /// Concrete colour, or nil for the terminal default (the renderer picks its theme colour).
    public var rgb: RGB? {
        switch self {
        case .default: return nil
        case .palette(let n): return TerminalPalette.rgb(n)
        case .rgb(let c): return c
        }
    }
}

/// xterm 256-colour palette. Entries 0–15 use a readable dark-theme ANSI set.
public enum TerminalPalette {
    private static let ansi: [RGB] = [
        // shared/design/DESIGN.md §1 terminal palette (Tokyo Night-derived, matched to the apps' status colours).
        RGB(0x1B, 0x22, 0x30), RGB(0xF7, 0x76, 0x8E), RGB(0x9E, 0xCE, 0x6A), RGB(0xE0, 0xAF, 0x68),
        RGB(0x7A, 0xA2, 0xF7), RGB(0xBB, 0x9A, 0xF7), RGB(0x7D, 0xCF, 0xFF), RGB(0xA9, 0xB1, 0xD6),
        RGB(0x41, 0x48, 0x68), RGB(0xF7, 0x76, 0x8E), RGB(0x9E, 0xCE, 0x6A), RGB(0xE0, 0xAF, 0x68),
        RGB(0x7A, 0xA2, 0xF7), RGB(0xBB, 0x9A, 0xF7), RGB(0x7D, 0xCF, 0xFF), RGB(0xC0, 0xCA, 0xF5),
    ]
    private static let cubeLevels: [UInt8] = [0, 95, 135, 175, 215, 255]

    public static func rgb(_ index: Int) -> RGB {
        switch index {
        case 0..<16:
            return ansi[index]
        case 16..<232:
            let i = index - 16
            return RGB(cubeLevels[i / 36], cubeLevels[(i / 6) % 6], cubeLevels[i % 6])
        case 232..<256:
            let v = UInt8(8 + 10 * (index - 232))
            return RGB(v, v, v)
        default:
            return RGB(0, 0, 0)
        }
    }
}

public struct Style: Codable, Hashable, Sendable {
    public var fg: String
    public var bg: String
    public var a: Int

    public init(fg: String = "d", bg: String = "d", a: Int = 0) {
        self.fg = fg
        self.bg = bg
        self.a = a
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        fg = try c.decodeIfPresent(String.self, forKey: .fg) ?? "d"
        bg = try c.decodeIfPresent(String.self, forKey: .bg) ?? "d"
        a = try c.decodeIfPresent(Int.self, forKey: .a) ?? 0
    }

    /// `styles["0"]` is implicitly the default style.
    public static let `default` = Style()
    public var attributes: StyleAttributes { StyleAttributes(rawValue: a) }
    public var foreground: TerminalColor { TerminalColor(wire: fg) }
    public var background: TerminalColor { TerminalColor(wire: bg) }
}

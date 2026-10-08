// WCAG 2 contrast between terminal colours, and the nudge that keeps text readable on a theme it was not written for:
// a program on the desktop picks its colours for a dark background, so its white or pale text on the Light theme is
// darkened until it reads (shared/design/DESIGN.md §1). The Android twin is `core/terminal/Contrast.kt`.
import Foundation

public enum Contrast {
    /// Relative luminance, 0 for black to 1 for white.
    public static func luminance(_ c: RGB) -> Double {
        func channel(_ v: UInt8) -> Double {
            let s = Double(v) / 255
            return s <= 0.04045 ? s / 12.92 : pow((s + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b)
    }

    /// Contrast ratio of two colours, 1 (the same) to 21 (black on white).
    public static func ratio(_ a: RGB, _ b: RGB) -> Double {
        let la = luminance(a)
        let lb = luminance(b)
        return (max(la, lb) + 0.05) / (min(la, lb) + 0.05)
    }

    /// `fg` itself when it reaches `minimum` against `bg`; otherwise `fg` mixed toward black (on a background lighter
    /// than the middle grey) or white (on a darker one) in tenths until it does, black or white at most. A `minimum` of
    /// 1 or less returns `fg`.
    public static func readable(_ fg: RGB, on bg: RGB, minimum: Double) -> RGB {
        guard minimum > 1, ratio(fg, bg) < minimum else { return fg }
        // 0.179 is the luminance at which black and white contrast equally with the background.
        let target: Double = luminance(bg) > 0.179 ? 0 : 255
        func mix(_ v: UInt8, _ t: Double) -> UInt8 { UInt8((Double(v) * (1 - t) + target * t).rounded()) }
        var candidate = fg
        for step in 1...10 {
            let t = Double(step) / 10
            candidate = RGB(mix(fg.r, t), mix(fg.g, t), mix(fg.b, t))
            if ratio(candidate, bg) >= minimum { return candidate }
        }
        return candidate
    }
}

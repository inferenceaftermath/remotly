// The Remotly mark as a status glyph (shared/design/DESIGN.md §4.12): the icon's chevron in the status colour and the
// teal phone, on the icon's 64-unit grid cropped to x 10–52, y 14–50 (42 × 36 units), scaled to `height`. Compiled
// into the app and the FlowActivity widget extension; shapes only (no Canvas), so Live Activities can draw it.
import SwiftUI

struct StatusMark: View {
    /// Chevron colour = the status colour (§3); `fg3` for a plain shell.
    var chevron: Color
    /// Height in points; the width follows the 42 : 36 crop.
    var height: CGFloat = 14
    /// Shift of the chevron from its resting place, in grid units (toward the phone is positive).
    var chevronOffset: CGFloat = 0
    var chevronOpacity: Double = 1
    /// A second chevron 6 units behind at 35 %: the drawn motion of the Live Activity while working.
    var trail = false

    private var scale: CGFloat { height / 36 }

    var body: some View {
        ZStack(alignment: .topLeading) {
            // Phone: grid x 35, y 14, 17 × 36, radius 5.4; island cut-out x 40.5, y 16.6, 6 × 2.2, radius 1.1.
            RoundedRectangle(cornerRadius: 5.4 * scale, style: .continuous)
                .fill(DesignTokens.accent)
                .frame(width: 17 * scale, height: 36 * scale)
                .offset(x: 25 * scale, y: 0)
            RoundedRectangle(cornerRadius: 1.1 * scale, style: .continuous)
                .fill(DesignTokens.bg)
                .frame(width: 6 * scale, height: 2.2 * scale)
                .offset(x: 30.5 * scale, y: 2.6 * scale)
            if trail {
                ChevronShape()
                    .fill(chevron.opacity(0.35 * chevronOpacity))
                    .frame(width: 17.2 * scale, height: 25 * scale)
                    .offset(x: (0.2 + chevronOffset - 6) * scale, y: 5.5 * scale)
            }
            // Chevron: grid M15.6 19.5 L27.4 32 L15.6 44.5 L10.2 44.5 L22 32 L10.2 19.5 Z.
            ChevronShape()
                .fill(chevron.opacity(chevronOpacity))
                .frame(width: 17.2 * scale, height: 25 * scale)
                .offset(x: (0.2 + chevronOffset) * scale, y: 5.5 * scale)
        }
        .frame(width: 42 * scale, height: 36 * scale, alignment: .topLeading)
        .clipped() // shapes carry no accessibility of their own; callers label the mark with the status word
    }
}

/// The icon's chevron in its own 17.2 × 25 box (grid points relative to x 10.2, y 19.5).
struct ChevronShape: Shape {
    func path(in rect: CGRect) -> Path {
        func point(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
            CGPoint(x: rect.minX + x / 17.2 * rect.width, y: rect.minY + y / 25 * rect.height)
        }
        var path = Path()
        path.move(to: point(5.4, 0))
        path.addLine(to: point(17.2, 12.5))
        path.addLine(to: point(5.4, 25))
        path.addLine(to: point(0, 25))
        path.addLine(to: point(11.8, 12.5))
        path.addLine(to: point(0, 0))
        path.closeSubpath()
        return path
    }
}

/// The working loop of §4.12, shared by the app's animated mark: 1.4 s, ease-in-out from x −3 to +7 units, opaque for
/// two thirds of the way and fading to 0 over the last third. `phase` is 0…1 within the loop.
enum StatusMarkMotion {
    static let period: TimeInterval = 1.4

    static func phase(at date: Date) -> Double {
        date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: period) / period
    }

    static func offset(phase t: Double) -> CGFloat {
        let eased = t < 0.5 ? 2 * t * t : 1 - pow(-2 * t + 2, 2) / 2
        return CGFloat(-3 + 10 * eased)
    }

    static func opacity(phase t: Double) -> Double {
        t < 2.0 / 3.0 ? 1 : max(0, 1 - (t - 2.0 / 3.0) * 3)
    }
}

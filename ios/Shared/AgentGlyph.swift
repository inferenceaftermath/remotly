// The tool glyph of a list row (shared/design/DESIGN.md §4.3, §4.12): which tool runs in the pane, in the tool's own
// colour — Claude's spark, Codex's knot, Gemini's sparkle, pi's π, and the `>_` prompt for a plain shell or a tool
// without a glyph. Geometry on a 24-unit grid, the same numbers as the Android `AgentGlyph`; shapes only (no Canvas),
// so the widget target can draw it too.
import SwiftUI

enum AgentGlyphKind {
    case spark, knot, sparkle, pi, terminal

    /// herdr's agent id → glyph; nil or empty (a plain shell) and tools without a glyph take the terminal prompt.
    static func kind(forAgent agent: String?) -> AgentGlyphKind {
        switch agent?.lowercased() {
        case "claude": return .spark
        case "codex": return .knot
        case "gemini": return .sparkle
        case "pi": return .pi
        default: return .terminal
        }
    }

    /// The tool's colour (§4.12): Claude's terracotta, OpenAI's white (`fg`), Google's blue; `fg2` for π, `fg3` for
    /// the prompt. The status colour stays on the row's status word.
    var tint: Color {
        switch self {
        case .spark: return Color(rgb: 0xD97757)
        case .knot: return DesignTokens.fg
        case .sparkle: return Color(rgb: 0x4285F4)
        case .pi: return DesignTokens.fg2
        case .terminal: return DesignTokens.fg3
        }
    }
}

struct AgentGlyph: View {
    var kind: AgentGlyphKind
    /// Side of the square, in points (16 in list rows).
    var size: CGFloat = 16

    var body: some View {
        let color = kind.tint
        Group {
            switch kind {
            case .spark, .knot, .sparkle:
                AgentGlyphShape(kind: kind).fill(color)
            case .pi, .terminal:
                AgentGlyphShape(kind: kind)
                    .stroke(color, style: StrokeStyle(lineWidth: 2.6 * size / 24, lineCap: .round, lineJoin: .round))
            }
        }
        .frame(width: size, height: size)
    }
}

/// The glyph's path in a 24 × 24 grid scaled to `rect` (filled for the spark, knot and sparkle; stroked 2.6 units wide
/// with round caps and joins for π and the prompt).
struct AgentGlyphShape: Shape {
    var kind: AgentGlyphKind

    func path(in rect: CGRect) -> Path {
        let s = min(rect.width, rect.height) / 24
        func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: rect.minX + x * s, y: rect.minY + y * s) }
        var path = Path()
        switch kind {
        case .spark:
            // Eight round-ended spokes, 3.4 wide, from 0.8 to 11.6 units out (they meet in a solid centre).
            for k in 0..<8 {
                path.addPath(capsule(x: -1.7, y: -11.6, width: 3.4, height: 10.8, angle: Double(k) * 45, in: rect))
            }
        case .knot:
            // Six round-ended bars, 3 wide and 11 long, each lying across a radius 5 units out: the hexagonal knot.
            for k in 0..<6 {
                path.addPath(capsule(x: -5.5, y: -6.5, width: 11, height: 3, angle: Double(k) * 60, in: rect))
            }
        case .sparkle:
            // Four points with sides pulled in toward the centre.
            path.move(to: p(12, 0.8))
            path.addQuadCurve(to: p(23.2, 12), control: p(13.4, 10.6))
            path.addQuadCurve(to: p(12, 23.2), control: p(13.4, 13.4))
            path.addQuadCurve(to: p(0.8, 12), control: p(10.6, 13.4))
            path.addQuadCurve(to: p(12, 0.8), control: p(10.6, 10.6))
            path.closeSubpath()
        case .pi:
            path.move(to: p(4.5, 6.5)); path.addLine(to: p(19.5, 6.5))
            path.move(to: p(8.5, 6.5)); path.addLine(to: p(8.5, 19.5))
            path.move(to: p(15.5, 6.5)); path.addLine(to: p(15.5, 19.5))
        case .terminal:
            path.move(to: p(5, 6.5)); path.addLine(to: p(10.5, 12)); path.addLine(to: p(5, 17.5))
            path.move(to: p(12.5, 17.5)); path.addLine(to: p(19.5, 17.5))
        }
        return path
    }

    /// A capsule given in grid units relative to the glyph's centre, rotated `angle` degrees clockwise about it.
    private func capsule(x: CGFloat, y: CGFloat, width: CGFloat, height: CGFloat, angle: Double, in rect: CGRect) -> Path {
        let s = min(rect.width, rect.height) / 24
        let radius = min(width, height) / 2 * s
        let shape = Path(roundedRect: CGRect(x: x * s, y: y * s, width: width * s, height: height * s), cornerRadius: radius)
        // Rotation about the origin first, then the move to the centre (`rotated(by:)` prepends the rotation).
        let transform = CGAffineTransform(translationX: rect.minX + 12 * s, y: rect.minY + 12 * s).rotated(by: angle * .pi / 180)
        return shape.applying(transform)
    }
}

// A pane's status mark in the app (DESIGN.md §4.12): the chevron in the pane's status colour; while the pane is
// `working` and `animated` is on, it glides toward the phone in the 1.4 s loop. Still with reduced motion.
import FlowKit
import SwiftUI

struct PaneMark: View {
    let pane: Pane
    /// 14 in list rows, 18 in the pane header.
    var height: CGFloat = 14
    /// Rows stay still; the pane header animates.
    var animated = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let color = Theme.color(for: pane)
        let moving = animated && !reduceMotion && pane.hasAgent && pane.agentStatus == .working
        Group {
            if moving {
                TimelineView(.animation) { context in
                    let phase = StatusMarkMotion.phase(at: context.date)
                    StatusMark(chevron: color, height: height,
                               chevronOffset: StatusMarkMotion.offset(phase: phase),
                               chevronOpacity: StatusMarkMotion.opacity(phase: phase))
                }
            } else {
                StatusMark(chevron: color, height: height)
            }
        }
        .frame(width: height * 42 / 36, height: height)
        .accessibilityElement(children: .ignore)
        // The status word; an agent whose status has no word (unknown) is named; "Terminal" only for a plain shell.
        .accessibilityLabel(Theme.word(for: pane) ?? (pane.hasAgent ? Theme.name(for: pane) : "Terminal"))
    }
}

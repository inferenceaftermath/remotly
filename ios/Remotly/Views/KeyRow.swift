// Special keys → `keys` messages (shared/design/DESIGN.md §4.6). Eight caps fill the width, the strip scrolls for
// the rest. Ctrl is sticky for one key: armed, the arrows send `ctrl+<arrow>` and the caps after the arrows become
// the letters that send `ctrl+<x>`.
import FlowKit
import SwiftUI
import UIKit

struct KeyRow: View {
    @Binding var ctrlArmed: Bool
    var send: ([String]) -> Void

    private static let ctrlLetters: [Character] = Array("cdzlaeukrwxbnpfgo[\\")

    var body: some View {
        GeometryReader { geo in
            let capWidth = max(34, (geo.size.width - 20 - 7 * 6) / 8)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) { caps(width: capWidth) }
                    .padding(.horizontal, 10)
                    .padding(.top, 8)
            }
        }
        .frame(height: 42)
        .background(Theme.bg)
        .animation(.easeOut(duration: 0.15), value: ctrlArmed)
    }

    @ViewBuilder
    private func caps(width: CGFloat) -> some View {
        cap("Esc", width) { send([KeyName.esc]) }
        cap("Tab", width) { send([KeyName.tab]) }
        cap("Ctrl", width, armed: ctrlArmed) { ctrlArmed.toggle() }
        cap("↑", width) { arrow(KeyName.up) }
        cap("↓", width) { arrow(KeyName.down) }
        cap("←", width) { arrow(KeyName.left) }
        cap("→", width) { arrow(KeyName.right) }
        if ctrlArmed {
            ForEach(Self.ctrlLetters, id: \.self) { letter in
                cap(String(letter).uppercased(), width) {
                    send([KeyName.ctrl(letter)])
                    ctrlArmed = false
                }
            }
        } else {
            cap("⏎", width) { send([KeyName.enter]) }
            cap("Home", width) { send([KeyName.home]) }
            cap("End", width) { send([KeyName.end]) }
            cap("PgUp", width) { send([KeyName.pageUp]) }
            cap("PgDn", width) { send([KeyName.pageDown]) }
            cap("⇧Tab", width) { send([KeyName.shiftTab]) }
            cap("Del", width) { send([KeyName.delete]) }
            cap("⌫", width) { send([KeyName.backspace]) }
            cap("^C", width) { send([KeyName.ctrl("c")]) }
        }
    }

    private func arrow(_ key: String) {
        if ctrlArmed {
            send(["ctrl+\(key)"])
            ctrlArmed = false
        } else {
            send([key])
        }
    }

    private func cap(_ label: String, _ width: CGFloat, armed: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            // Mono 15; a single glyph (arrows, ⏎, ⌫, the Ctrl letters) 18 (§4.6). The cap keeps its 34 pt height.
            Text(label)
                .font(Theme.mono(label.count == 1 ? 18 : 15))
                .foregroundStyle(armed ? Theme.accent : Theme.titleFg)
                .lineLimit(1)
                .minimumScaleFactor(0.75)
                .frame(width: width, height: 34)
                .background {
                    RoundedRectangle(cornerRadius: 8).fill(Theme.panel2)
                    if armed { RoundedRectangle(cornerRadius: 8).fill(Theme.accentWash) }
                }
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(armed ? Theme.accent : Theme.line, lineWidth: 1))
        }
        .buttonStyle(CapButtonStyle())
        .accessibilityLabel(KeyRow.spokenName(label))
        .accessibilityAddTraits(armed ? [.isSelected] : [])
    }

    private static func spokenName(_ label: String) -> String {
        switch label {
        case "↑": return "Up arrow"
        case "↓": return "Down arrow"
        case "←": return "Left arrow"
        case "→": return "Right arrow"
        case "⏎": return "Enter"
        case "⌫": return "Backspace"
        case "⇧Tab": return "Shift Tab"
        case "^C": return "Control C"
        case "[", "\\": return "Control \(label)"
        default: return label.count == 1 ? "Control \(label)" : label
        }
    }
}

/// Key cap press feedback: the cap dims while held.
struct CapButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.opacity(configuration.isPressed ? 0.55 : 1)
    }
}

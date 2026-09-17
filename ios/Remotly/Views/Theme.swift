// The app's design system (shared/design/DESIGN.md): the tokens from Shared/DesignTokens.swift with FlowKit-typed
// helpers, and the shared views — status pill, connection pill, section label, elapsed time, toast, button styles.
import FlowKit
import SwiftUI
import UIKit

typealias Theme = DesignTokens

extension DesignTokens {
    static func color(for status: AgentStatus) -> Color { statusColor(status.rawValue) }

    static func color(for pane: Pane) -> Color { pane.hasAgent ? color(for: pane.agentStatus) : fg3 }

    /// §3: the fixed word for a pane's status ("Has a question" for a choice dialog); nil for a plain shell.
    static func word(for pane: Pane) -> String? {
        guard pane.hasAgent else { return nil }
        return statusWord(pane.agentStatus.rawValue, isChoice: pane.approval?.isChoice ?? false)
    }

    /// Line 1 of a list row and of the pane header (§4.3, §4.4): the session title = the pane title (the bridge has
    /// removed the agent's status glyph), else the cwd basename, else the pane id.
    static func sessionTitle(for pane: Pane) -> String {
        if !pane.title.isEmpty { return pane.title }
        return cwdBasename(pane.cwd) ?? pane.id
    }

    /// What the row's tool glyph stands for (§4.3): the agent's display name ("Claude Code"), else its id, else
    /// "Terminal" for a plain shell.
    static func toolName(for pane: Pane) -> String {
        if let agent = pane.displayAgent, !agent.isEmpty { return agent }
        if let agent = pane.agent, !agent.isEmpty { return agent }
        return "Terminal"
    }

    /// The short name notices and dialogs use: the agent as herdr names it (`claude`), else the pane title.
    static func name(for pane: Pane) -> String {
        if let agent = pane.agent, !agent.isEmpty { return agent }
        if let agent = pane.displayAgent, !agent.isEmpty { return agent }
        if !pane.title.isEmpty { return pane.title }
        return cwdBasename(pane.cwd) ?? pane.id
    }
}

/// Last path component of a working directory (`/home/u/remotly` → `remotly`); nil when unknown.
func cwdBasename(_ cwd: String?) -> String? {
    guard let cwd, !cwd.isEmpty else { return nil }
    let trimmed = cwd.hasSuffix("/") && cwd.count > 1 ? String(cwd.dropLast()) : cwd
    let last = trimmed.split(separator: "/").last.map(String.init) ?? trimmed
    return last.isEmpty ? trimmed : last
}

// MARK: - Status pill (§4.1)

struct StatusPill: View {
    let color: Color
    let text: String

    var body: some View {
        HStack(spacing: 6) {
            Circle().fill(color).frame(width: 8, height: 8)
            Text(text)
                .font(Theme.mono(12))
                .lineLimit(1)
        }
        .foregroundStyle(color)
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .background(Theme.pillBg, in: Capsule())
        .overlay(Capsule().stroke(Theme.line, lineWidth: 1))
        .accessibilityElement(children: .combine)
    }
}

extension StatusPill {
    /// nil for a pane without an agent (no pill).
    init?(pane: Pane) {
        guard let word = Theme.word(for: pane) else { return nil }
        self.init(color: Theme.color(for: pane), text: word)
    }
}

/// The connection pill of the pane list header (§3: Connected / Connecting… / Reconnecting… / Offline / Not paired).
@MainActor
struct ConnectionPill: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        let (word, color) = state
        StatusPill(color: color, text: word)
    }

    private var state: (String, Color) {
        switch model.connectionState {
        case .connected: return ("Connected", Theme.done)
        case .connecting: return ("Connecting…", Theme.working)
        case .reconnecting: return ("Reconnecting…", Theme.working)
        case .unpaired: return ("Not paired", Theme.blocked)
        case .idle, .stopped: return ("Offline", Theme.blocked)
        }
    }
}

// MARK: - Section label (§2)

struct SectionLabel: View {
    let text: String
    /// `false` inside a `List` section header, which brings its own insets.
    var inset = true
    init(_ text: String, inset: Bool = true) { self.text = text; self.inset = inset }

    var body: some View {
        Text(text.uppercased())
            .font(Theme.mono(12))
            .kerning(12 * 0.12)
            .foregroundStyle(Theme.fg3)
            .textCase(nil)
            .lineLimit(1)
            .padding(.top, inset ? 18 : 0)
            .padding(.bottom, inset ? 6 : 0)
            .padding(.horizontal, inset ? 16 : 0)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - Elapsed time (§4.3)

/// `mm:ss` since a bridge `since` timestamp, ticking every second.
struct ElapsedText: View {
    let sinceMs: Int
    var color: Color = Theme.fg2

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            Text(Theme.elapsed(sinceMs: sinceMs, now: context.date))
                .font(Theme.mono(14))
                .monospacedDigit()
                .foregroundStyle(color)
        }
    }
}

// MARK: - Toast (§4.2)

struct ToastView: View {
    let notice: AppModel.Notice

    var body: some View {
        Text(notice.text)
            .font(Theme.mono(12.5))
            .foregroundStyle(Theme.toastFg)
            .lineLimit(1)
            .truncationMode(.tail)
            .padding(.horizontal, 11)
            .padding(.vertical, 6)
            .background(notice.ok ? Theme.done : Theme.toastBg, in: Capsule())
            .padding(.horizontal, 24)
            .accessibilityAddTraits(.updatesFrequently)
    }
}

/// Shows `AppModel.notice` as the top-centre toast over the content; one component for every screen.
@MainActor
struct ToastHost: ViewModifier {
    @Environment(AppModel.self) private var model

    func body(content: Content) -> some View {
        content
            .overlay(alignment: .top) {
                if let notice = model.notice {
                    ToastView(notice: notice)
                        .padding(.top, 8)
                        .transition(.move(edge: .top).combined(with: .opacity))
                }
            }
            .animation(.easeOut(duration: 0.25), value: model.notice)
    }
}

extension View {
    func toastHost() -> some View { modifier(ToastHost()) }
}

// MARK: - Buttons

/// Option buttons of the approval card and the key-map fallback (§4.5): full width, left-aligned, `panel2` on a
/// `raised` border; the option the desktop marks gets the `accent` border and wash.
struct OptionButtonStyle: ButtonStyle {
    var marked = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 14, weight: .medium))
            .foregroundStyle(Theme.fg)
            .multilineTextAlignment(.leading)
            .padding(.horizontal, 12)
            .padding(.vertical, 9)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background {
                RoundedRectangle(cornerRadius: 10).fill(Theme.panel2)
                if marked { RoundedRectangle(cornerRadius: 10).fill(Theme.accentWash) }
            }
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(marked ? Theme.accent : Theme.raised, lineWidth: 1))
            .opacity(configuration.isPressed ? 0.7 : 1)
            .contentShape(Rectangle())
    }
}

/// Full-width primary action (Pair, Send): `interactive` fill, `onInteractive` text, 40 % when disabled.
struct PrimaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 16, weight: .semibold))
            .foregroundStyle(Theme.onInteractive)
            .frame(maxWidth: .infinity, minHeight: 48)
            .background(Theme.interactive, in: RoundedRectangle(cornerRadius: 14))
            .opacity(isEnabled ? (configuration.isPressed ? 0.8 : 1) : 0.4)
    }
}

/// Quiet text action (`Deny with feedback…`, `Send anyway`, `Retry now`).
struct QuietButtonStyle: ButtonStyle {
    var color: Color = Theme.fg2

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 14))
            .foregroundStyle(color)
            .opacity(configuration.isPressed ? 0.6 : 1)
            .contentShape(Rectangle())
    }
}

/// A card surface: `panel` with a `line` border.
struct CardBackground: ViewModifier {
    var radius: CGFloat = 14

    func body(content: Content) -> some View {
        content
            .background(Theme.panel, in: RoundedRectangle(cornerRadius: radius))
            .overlay(RoundedRectangle(cornerRadius: radius).stroke(Theme.line, lineWidth: 1))
    }
}

extension View {
    func card(radius: CGFloat = 14) -> some View { modifier(CardBackground(radius: radius)) }
}

/// The site's segmented control (§4.8): `panel2` track, `raised` selected segment.
struct SegmentedControl<Value: Hashable>: View {
    @Binding var selection: Value
    let options: [(Value, String)]

    var body: some View {
        HStack(spacing: 0) {
            ForEach(options, id: \.0) { value, label in
                let on = value == selection
                Button {
                    withAnimation(.easeOut(duration: 0.15)) { selection = value }
                } label: {
                    Text(label)
                        .font(.system(size: 14, weight: on ? .semibold : .regular))
                        .foregroundStyle(on ? Theme.fg : Theme.fg2)
                        .frame(maxWidth: .infinity, minHeight: 32)
                        .background(on ? Theme.raised : .clear, in: RoundedRectangle(cornerRadius: 8))
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(on ? [.isSelected] : [])
            }
        }
        .padding(3)
        .background(Theme.panel2, in: RoundedRectangle(cornerRadius: 10))
    }
}

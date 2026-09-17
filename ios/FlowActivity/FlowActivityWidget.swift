// Live Activity UI (shared/design/DESIGN.md §4.11): Lock Screen banner and Dynamic Island for one working agent; the
// status mark (§4.12) and the session title lead, the status word (and the approval detail) follows.
// Content comes only from the push (`FlowActivityAttributes`); the Approve / Deny buttons run `FlowApprovalIntent`
// in the app's process. A tap anywhere else opens the pane in the app (`DeepLink.pane`: the Lock Screen view's
// `widgetURL` and the Dynamic Island's, one per hierarchy as WidgetKit requires). Colours, font and status words are
// the app's (`DesignTokens`, compiled into both targets).
import ActivityKit
import AppIntents
import SwiftUI
import WidgetKit

@main
struct FlowActivityBundle: WidgetBundle {
    var body: some Widget {
        FlowActivityWidget()
    }
}

struct FlowActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: FlowActivityAttributes.self) { context in
            LockScreenView(attributes: context.attributes, state: context.state)
                .padding(14)
                .activityBackgroundTint(DesignTokens.bg.opacity(0.85))
                .activitySystemActionForegroundColor(DesignTokens.fg)
                .widgetURL(DeepLink.pane(context.attributes.pane))
        } dynamicIsland: { context in
            let state = context.state
            let tint = FlowActivityStyle.color(for: state)
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Mark(state: state, height: 20)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    Trailing(state: state, color: DesignTokens.fg)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(FlowActivityStyle.title(context.attributes, state))
                            .font(DesignTokens.mono(14, bold: true))
                            .foregroundStyle(DesignTokens.fg)
                            .lineLimit(1)
                        StatusLine(state: state)
                        if state.isBlocked, let promptId = state.promptId {
                            if state.isChoice { OpenToAnswer() } else { ApprovalButtons(attributes: context.attributes, promptId: promptId) }
                        }
                    }
                }
            } compactLeading: {
                Mark(state: state, height: 14)
            } compactTrailing: {
                Trailing(state: state, color: tint)
                    .frame(maxWidth: 56)
            } minimal: {
                Mark(state: state, height: 14)
            }
            .keylineTint(tint)
            // One link for the island in every presentation: a tap outside the Approve / Deny buttons lands in this pane.
            .widgetURL(DeepLink.pane(context.attributes.pane))
        }
    }
}

private struct LockScreenView: View {
    let attributes: FlowActivityAttributes
    let state: FlowActivityAttributes.ContentState

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("REMOTLY")
                .font(DesignTokens.mono(11))
                .kerning(11 * 0.08)
                .foregroundStyle(DesignTokens.fg3)
            HStack(spacing: 8) {
                Mark(state: state, height: 14)
                Text(FlowActivityStyle.title(attributes, state))
                    .font(DesignTokens.mono(14, bold: true))
                    .foregroundStyle(DesignTokens.fg)
                    .lineLimit(1)
                Spacer(minLength: 8)
                Trailing(state: state, color: DesignTokens.fg)
            }
            StatusLine(state: state)
            if state.isBlocked, let promptId = state.promptId {
                if state.isChoice { OpenToAnswer() } else { ApprovalButtons(attributes: attributes, promptId: promptId) }
            }
        }
    }
}

/// The status mark (DESIGN.md §4.12): chevron in the status colour, with the drawn trail while working (the system runs
/// no custom animation in a Live Activity). Labelled with the status word.
private struct Mark: View {
    let state: FlowActivityAttributes.ContentState
    var height: CGFloat = 14

    var body: some View {
        StatusMark(chevron: FlowActivityStyle.color(for: state), height: height, trail: state.isWorking)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(FlowActivityStyle.word(for: state))
    }
}

/// "<status word> · <detail>": the word in its colour, the one-line detail in `fg2` while blocked. One line, truncated
/// at the end.
private struct StatusLine: View {
    let state: FlowActivityAttributes.ContentState

    var body: some View {
        let tint = FlowActivityStyle.color(for: state)
        var text = Text(FlowActivityStyle.word(for: state)).foregroundStyle(tint)
        if let detail = FlowActivityStyle.detail(for: state) {
            text = text + Text(" · \(detail)").foregroundStyle(DesignTokens.fg2)
        }
        return text
            .font(.system(size: 13))
            .lineLimit(1)
    }
}

/// The elapsed time since the agent started this stretch of work (drawn by the system, no updates needed); "✓" once done.
private struct Trailing: View {
    let state: FlowActivityAttributes.ContentState
    let color: Color

    var body: some View {
        if state.status == "done" {
            Text("✓").font(DesignTokens.mono(14)).foregroundStyle(color)
        } else if state.since > 0 {
            let start = Date(timeIntervalSince1970: TimeInterval(state.since))
            Text(timerInterval: start...start.addingTimeInterval(7 * 24 * 3600), countsDown: false, showsHours: true)
                .font(DesignTokens.mono(14))
                .monospacedDigit()
                .foregroundStyle(color)
                .multilineTextAlignment(.trailing)
        } else {
            Text("")
        }
    }
}

/// A menu (AskUserQuestion, a picker) cannot be answered from the Lock Screen: the card in the app mirrors its options.
private struct OpenToAnswer: View {
    var body: some View {
        Text("Open Remotly to answer")
            .font(.system(size: 13))
            .foregroundStyle(DesignTokens.fg2)
    }
}

private struct ApprovalButtons: View {
    let attributes: FlowActivityAttributes
    let promptId: String

    var body: some View {
        HStack(spacing: 10) {
            Button(intent: FlowApprovalIntent(pane: attributes.pane, promptId: promptId, agent: attributes.agent, host: attributes.host, action: "approve")) {
                Text("Approve")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(DesignTokens.onInteractive)
                    .frame(maxWidth: .infinity, minHeight: 32)
                    .background(DesignTokens.accent, in: RoundedRectangle(cornerRadius: 10))
            }
            Button(intent: FlowApprovalIntent(pane: attributes.pane, promptId: promptId, agent: attributes.agent, host: attributes.host, action: "deny")) {
                Text("Deny")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(DesignTokens.fg)
                    .frame(maxWidth: .infinity, minHeight: 32)
                    .background(Color.white.opacity(0.14), in: RoundedRectangle(cornerRadius: 10))
            }
        }
        .buttonStyle(.plain)
    }
}

enum FlowActivityStyle {
    static func color(for state: FlowActivityAttributes.ContentState) -> Color {
        DesignTokens.statusColor(state.status)
    }

    /// The session title (content state `title`, the pane title with its glyph removed by the bridge); the pane id when
    /// a bridge sends none (the list row falls back the same way; never the agent's name).
    static func title(_ attributes: FlowActivityAttributes, _ state: FlowActivityAttributes.ContentState) -> String {
        let title = state.title.trimmingCharacters(in: .whitespacesAndNewlines)
        return title.isEmpty ? attributes.pane : title
    }

    /// The status word (§3); "Ended" for `unknown` (the pane is gone while the activity dismisses); herdr's raw status,
    /// capitalised, only for a value the vocabulary does not know.
    static func word(for state: FlowActivityAttributes.ContentState) -> String {
        if let word = DesignTokens.statusWord(state.status, isChoice: state.isChoice) { return word }
        return state.status == "unknown" ? "Ended" : state.status.capitalized
    }

    /// One line about the pending approval while blocked (`Bash · npm test`); nil otherwise.
    static func detail(for state: FlowActivityAttributes.ContentState) -> String? {
        guard state.isBlocked else { return nil }
        let detail = (state.detail ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return detail.isEmpty ? nil : detail
    }
}

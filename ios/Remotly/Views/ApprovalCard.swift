// Shown between the terminal and the key row while the watched pane is `blocked` (shared/design/DESIGN.md §4.5):
// the tool and the kind of dialog, the command or file, the agent's summary and question, and its choices as
// buttons in the dialog's own words. Tapping one asks the bridge to move the desktop cursor there and press Enter
// (`choose`), so the same card serves permission prompts, Claude's AskUserQuestion menus and pickers; the choice
// the desktop currently marks is highlighted. Esc is on the key row; "Deny with feedback…" / "Something else…"
// dismiss the dialog and type the reply. Without parsed details (trust dialogs, unknown layouts) the card falls
// back to the agent's key-map actions: Approve / Approve for session / Deny / Interrupt.
import FlowKit
import SwiftUI
import UIKit

// @MainActor: `result`, `inFlight` and `act` touch the main-actor AppModel outside `body`.
@MainActor
struct ApprovalCard: View {
    @Environment(AppModel.self) private var model
    let pane: Pane
    let promptId: String
    @State private var showFeedback = false
    @State private var feedback = ""

    private var result: ApprovalResult? { model.approvalResults[promptId] }
    private var inFlight: Bool { model.approvalInFlight == promptId }
    private var isChoice: Bool { pane.approval?.isChoice ?? false }
    private var sent: Bool { result?.outcome == .sent }
    private var quietTitle: String { isChoice ? "Something else…" : "Deny with feedback…" }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            head
            if let result, sent {
                Text(result.summaryText)
                    .font(.system(size: 14))
                    .foregroundStyle(Theme.fg2)
            } else {
                if let details = pane.approval {
                    parsed(details)
                } else {
                    fallback
                }
                if let result {
                    HStack(alignment: .firstTextBaseline, spacing: 12) {
                        Text(result.summaryText)
                            .font(.system(size: 14))
                            .foregroundStyle(Theme.fg2)
                            .lineLimit(2)
                        Spacer(minLength: 0)
                        if result.outcome == .signatureMismatch, model.lastApprovalAttempt[promptId] != nil {
                            Button("Send anyway") { model.retryForced(pane: pane.id, promptId: promptId) }
                                .buttonStyle(QuietButtonStyle(color: Theme.interactive))
                        }
                    }
                }
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.panel)
        .overlay(alignment: .top) { Rectangle().fill(Theme.line).frame(height: 1) }
        .animation(.easeInOut(duration: 0.2), value: result?.outcome.rawValue)
        .animation(.easeInOut(duration: 0.2), value: inFlight)
        .sheet(isPresented: $showFeedback) { feedbackSheet }
    }

    // MARK: Head row

    private var head: some View {
        HStack(alignment: .firstTextBaseline) {
            if let result, !sent {
                Text("✕ Not sent")
                    .font(Theme.mono(13, bold: true))
                    .foregroundStyle(Theme.blocked)
                Spacer(minLength: 8)
                Text(result.outcome.rawValue.replacingOccurrences(of: "_", with: " "))
                    .font(Theme.mono(13))
                    .foregroundStyle(Theme.fg3)
            } else if sent {
                Text("✓ Answered from your phone")
                    .font(Theme.mono(13, bold: true))
                    .foregroundStyle(Theme.done)
                Spacer(minLength: 8)
                Text("sent")
                    .font(Theme.mono(13))
                    .foregroundStyle(Theme.fg3)
            } else {
                Text(pane.approval?.tool ?? (isChoice ? "Question" : "Approval"))
                    .font(Theme.mono(13, bold: true))
                    .foregroundStyle(Theme.accent)
                    .lineLimit(1)
                Spacer(minLength: 8)
                Text(inFlight ? "sending…" : (pane.approval == nil ? "prompt" : (isChoice ? "question" : "permission")))
                    .font(Theme.mono(13))
                    .foregroundStyle(Theme.fg3)
            }
        }
    }

    // MARK: Parsed dialog

    @ViewBuilder
    private func parsed(_ details: ApprovalDetails) -> some View {
        if let what = details.command ?? details.path {
            Text(what)
                .font(Theme.mono(12.5))
                .foregroundStyle(Theme.fg)
                .lineLimit(6)
                .textSelection(.enabled)
                .padding(.horizontal, 8)
                .padding(.vertical, 6)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Theme.bg, in: RoundedRectangle(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.line, lineWidth: 1))
        }
        if let description = details.description, description != (details.command ?? details.path) {
            Text(description)
                .font(.system(size: 14))
                .foregroundStyle(Theme.fg2)
        }
        if !details.question.isEmpty {
            Text(details.question)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(Theme.fg)
        }
        VStack(spacing: 6) {
            ForEach(Array(details.options.enumerated()), id: \.offset) { index, option in
                let number = index + 1
                let marked = details.selected == number
                Button {
                    model.choose(pane: pane.id, promptId: promptId, option: number, label: option)
                } label: {
                    Text(option).lineLimit(3)
                }
                .buttonStyle(OptionButtonStyle(marked: marked))
                .accessibilityLabel("Option \(number): \(option)\(marked ? ", marked on the desktop" : "")")
            }
        }
        .disabled(inFlight)
        .opacity(inFlight ? 0.6 : 1)
        Button(quietTitle) { showFeedback = true }
            .buttonStyle(QuietButtonStyle())
            .disabled(inFlight)
    }

    // MARK: Nothing parsed

    @ViewBuilder
    private var fallback: some View {
        if let label = pane.stateLabel, !label.isEmpty {
            Text(label)
                .font(.system(size: 14))
                .foregroundStyle(Theme.fg2)
        }
        VStack(spacing: 6) {
            Button("Approve") { act(.approve) }.buttonStyle(OptionButtonStyle(marked: true))
            Button("Approve for session") { act(.approveSession) }.buttonStyle(OptionButtonStyle())
            Button("Deny") { act(.deny) }.buttonStyle(OptionButtonStyle())
            Button("Interrupt") { act(.interrupt) }.buttonStyle(OptionButtonStyle())
        }
        .disabled(inFlight)
        .opacity(inFlight ? 0.6 : 1)
        Button("Deny with feedback…") { showFeedback = true }
            .buttonStyle(QuietButtonStyle())
            .disabled(inFlight)
    }

    // MARK: Feedback sheet

    private var feedbackSheet: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 10) {
                TextField("", text: $feedback, prompt: Text("What should it do instead?").foregroundStyle(Theme.fg3), axis: .vertical)
                    .lineLimit(3...10)
                    .font(.system(size: 15))
                    .foregroundStyle(Theme.fg)
                    .tint(Theme.interactive)
                    .padding(12)
                    .background(Theme.panel, in: RoundedRectangle(cornerRadius: 12))
                    .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.line, lineWidth: 1))
                Text("Esc dismisses the dialog first, then your words are typed to the agent.")
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.fg3)
                Spacer(minLength: 0)
            }
            .padding(16)
            .background(Theme.bg)
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(Theme.bg, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    Text(quietTitle).font(.system(size: 17, weight: .semibold)).foregroundStyle(Theme.fg)
                }
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { showFeedback = false } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Send") {
                        act(.denyFeedback, feedback: feedback)
                        feedback = ""
                        showFeedback = false
                    }
                    .fontWeight(.semibold)
                    .disabled(feedback.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
        .tint(Theme.interactive)
        .presentationDetents([.medium])
        .presentationBackground(Theme.bg)
    }

    private func act(_ action: ApprovalAction, feedback: String? = nil) {
        model.approve(pane: pane.id, promptId: promptId, action: action, feedback: feedback)
    }
}

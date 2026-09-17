// The one-line banner at the top of the pane list while the connection has a problem (shared/design/DESIGN.md §4.3):
// what is wrong, with an action when one helps. Nothing while everything is up; the host facts live in Settings › Host.
import FlowKit
import SwiftUI

/// What is wrong with the connection right now, or nil when everything is up. Same words as Android.
@MainActor
enum ConnectionProblem {
    struct Info {
        var text: String
        var color: Color
        /// "Retry now" (reconnect) or "Forget host and pair again" (unpair); nil when nothing helps but waiting.
        var action: (label: String, run: () -> Void)?
    }

    static func current(_ model: AppModel) -> Info? {
        let retry: (label: String, run: () -> Void) = ("Retry now", { Task { await model.reconnectNow() } })
        switch model.connectionState {
        case .connected:
            return model.herdrUp ? nil : Info(text: "herdr is down on the host · pane actions will fail until it is back", color: Theme.blocked, action: nil)
        case .connecting:
            return Info(text: "Connecting…", color: Theme.working, action: retry)
        case .reconnecting(let attempt):
            return Info(text: "Reconnecting… · attempt \(attempt)", color: Theme.working, action: retry)
        case .unpaired:
            return Info(text: "This phone is no longer paired.", color: Theme.blocked, action: ("Forget host and pair again", { model.forgetHost() }))
        case .idle, .stopped:
            return Info(text: "Offline", color: Theme.blocked, action: retry)
        }
    }
}

struct ConnectionProblemBanner: View {
    let problem: ConnectionProblem.Info

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Circle().fill(problem.color).frame(width: 8, height: 8).offset(y: -1)
                Text(problem.text)
                    .font(Theme.mono(12.5))
                    .foregroundStyle(problem.color)
                    .lineLimit(2)
                Spacer(minLength: 0)
            }
            if let action = problem.action {
                Button(action.label, action: action.run)
                    .buttonStyle(QuietButtonStyle(color: Theme.interactive))
                    .padding(.top, 2)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .card(radius: 14)
        .padding(.horizontal, 16)
        .padding(.top, 14)
    }
}

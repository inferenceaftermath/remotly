import FlowKit
import SwiftUI

@MainActor
struct RootView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        Group {
            if model.host == nil {
                PairingView()
            } else {
                PaneListView()
            }
        }
        // shared/design/DESIGN.md §1: dark only, `interactive` blue for every system control.
        .preferredColorScheme(.dark)
        .tint(Theme.interactive)
        .background(Theme.bg)
        .onChange(of: scenePhase, initial: true) { _, phase in
            model.scenePhaseChanged(phase)
        }
        // A tap on the Live Activity (`remotly://pane?id=…`, DESIGN.md §4.11) lands in that pane, whatever page was open.
        .onOpenURL { url in
            // Unpaired (a leftover activity from a forgotten host): nothing to open; pairing must not land in a pane.
            guard model.host != nil, let pane = DeepLink.paneId(from: url) else { return }
            model.openPane(pane)
        }
    }
}

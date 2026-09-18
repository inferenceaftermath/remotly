import FlowKit
import SwiftUI

@MainActor
struct RootView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        VStack(spacing: 0) {
            if model.isDemo { DemoBanner() }
            Group {
                if model.displayHost == nil {
                    PairingView()
                } else {
                    PaneListView()
                }
            }
            .id(model.isDemo)
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
            guard !model.isDemo, model.host != nil, let pane = DeepLink.paneId(from: url) else { return }
            model.openPane(pane)
        }
    }
}

/// Always visible over sample sessions, including modal screens.
@MainActor
struct DemoBanner: View {
    @Environment(AppModel.self) private var model
    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Demo mode · Sample data").font(.system(size: 15, weight: .semibold)).foregroundStyle(Theme.accent)
                Text("Local simulation · no host connected").font(.system(size: 12)).foregroundStyle(Theme.fg2)
            }
            Spacer(minLength: 0)
            Button("Exit demo") { model.exitDemo() }.font(.system(size: 14, weight: .semibold))
        }
        .padding(.horizontal, 16).padding(.vertical, 8).background(Theme.bg)
    }
}

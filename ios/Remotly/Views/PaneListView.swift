// The home screen (DESIGN.md §4.3): host name and connection pill in the header, a one-line banner only while the
// connection has a problem, blocked panes under "Needs you", then one section per herdr tab; rows are the tool glyph ·
// session title / cwd · status word · elapsed time. A tap opens the pane, a long press opens its menu (Close terminal).
// A round "+" fixed at the bottom-right corner opens the New terminal sheet.
import FlowKit
import SwiftUI
import UIKit

@MainActor
struct PaneListView: View {
    @Environment(AppModel.self) private var model
    @State private var showSettings = false
    @State private var showNewTerminal = false
    /// Row awaiting "Close terminal" confirmation (from its long-press menu).
    @State private var paneToClose: Pane?

    var body: some View {
        @Bindable var model = model
        NavigationStack(path: $model.navigationPath) {
            content
                .background(Theme.bg)
                .toastHost()
                .navigationTitle("")
                .navigationBarTitleDisplayMode(.inline)
                .toolbarBackground(Theme.bg, for: .navigationBar)
                .toolbarBackground(.visible, for: .navigationBar)
                .toolbarRole(.editor) // left-aligns the principal slot
                .toolbar {
                    // Principal slot, not `.topBarLeading`: iOS 26 wraps leading items in a glass circle that
                    // truncates the host name (same fix as the pane view).
                    ToolbarItem(placement: .principal) {
                        HStack(spacing: 8) {
                            Text(model.host?.name ?? "Remotly")
                                .font(Theme.mono(16))
                                .foregroundStyle(Theme.fg)
                                .lineLimit(1)
                                .accessibilityAddTraits(.isHeader)
                            Spacer(minLength: 0)
                            ConnectionPill() // no priority: host name and pill share a narrow slot (same as the pane view)
                        }
                        .frame(maxWidth: .infinity)
                    }
                    ToolbarItem(placement: .topBarTrailing) {
                        Button { showSettings = true } label: {
                            Image(systemName: "gearshape").foregroundStyle(Theme.fg2)
                        }
                        .accessibilityLabel("Settings")
                    }
                }
                .sheet(isPresented: $showNewTerminal) { NewTerminalSheet() }
                .sheet(isPresented: $showSettings) { SettingsView() }
                // The same words as the pane's overflow (§4.4).
                .confirmationDialog("Close \(paneToClose.map { Theme.sessionTitle(for: $0) } ?? "this terminal")?",
                                    isPresented: Binding(get: { paneToClose != nil }, set: { if !$0 { paneToClose = nil } }),
                                    titleVisibility: .visible, presenting: paneToClose) { pane in
                    Button("Close terminal", role: .destructive) {
                        Task { await model.closePane(pane.id, title: Theme.sessionTitle(for: pane)) }
                    }
                    Button("Cancel", role: .cancel) {} // explicit: the iPad popover adds none of its own (Android shows Cancel)
                } message: { _ in
                    Text("Ends the shell on the desktop and anything running in it.")
                }
                // A pane opened from outside (notification tap, Live Activity) must show: close whichever sheet was up.
                .onChange(of: model.navigationPath) { _, path in
                    if !path.isEmpty {
                        showSettings = false
                        showNewTerminal = false
                    }
                }
                .navigationDestination(for: String.self) { paneId in
                    PaneView(paneId: paneId)
                }
                .alert("Error", isPresented: Binding(get: { model.lastError != nil }, set: { if !$0 { model.lastError = nil } })) {
                    Button("OK", role: .cancel) {}
                } message: {
                    Text(model.lastError ?? "")
                }
        }
        .tint(Theme.interactive)
    }

    // MARK: List

    @ViewBuilder
    private var content: some View {
        if let snapshot = model.snapshot {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    if let problem = ConnectionProblem.current(model) {
                        ConnectionProblemBanner(problem: problem)
                    }
                    let blocked = model.blockedPanes
                    if !blocked.isEmpty {
                        SectionLabel("Needs you")
                        ForEach(blocked) { pane in row(pane) }
                    }
                    let multipleWorkspaces = snapshot.workspaces.count > 1
                    ForEach(snapshot.workspaces) { workspace in
                        ForEach(model.tabs(inWorkspace: workspace.id)) { tab in
                            tabSection(tab, label: multipleWorkspaces ? "\(workspace.name) › \(tab.name)" : tab.name)
                        }
                    }
                    // Tabs whose workspace is not in the snapshot still show, under their own name (as on Android).
                    let workspaceIds = Set(snapshot.workspaces.map(\.id))
                    ForEach(snapshot.tabs.filter { !workspaceIds.contains($0.workspaceId) }) { tab in
                        tabSection(tab, label: tab.name)
                    }
                    // Panes whose tab is not in the snapshot (a herdr blip between two snapshots).
                    let knownTabs = Set(snapshot.tabs.map(\.id))
                    let orphans = snapshot.panes
                        .filter { !knownTabs.contains($0.tabId) && !$0.needsYou }
                        .sorted { AppModel.listOrder($0, $1) }
                    if !orphans.isEmpty {
                        SectionLabel("Other")
                        ForEach(orphans) { pane in row(pane) }
                    }
                    if snapshot.panes.isEmpty {
                        Text("No panes open in herdr.")
                            .font(.system(size: 15))
                            .foregroundStyle(Theme.fg2)
                            .frame(maxWidth: .infinity)
                            .padding(.top, 40)
                    }
                }
            }
            // The last row scrolls clear of the New terminal button (its 52 pt, its 16 pt inset and a row's breathing room).
            .contentMargins(.bottom, 92, for: .scrollContent)
            .background(Theme.bg)
            .refreshable { await model.reconnectNow() }
            .overlay(alignment: .bottomTrailing) { newTerminalButton.padding(16) }
        } else {
            waiting
        }
    }

    /// One herdr tab: its label, then its panes in §4.3 order minus those under "Needs you"; nothing when empty.
    @ViewBuilder
    private func tabSection(_ tab: FlowKit.Tab, label: String) -> some View {
        let panes = model.panes(inTab: tab.id).filter { !$0.needsYou }
        if !panes.isEmpty {
            SectionLabel(label)
            ForEach(panes) { pane in row(pane) }
        }
    }

    /// A row: tap opens the pane; the long-press menu closes the terminal after confirmation.
    private func row(_ pane: Pane) -> some View {
        PaneRow(pane: pane, armed: model.isArmed(pane.id), onTap: { model.openPane(pane.id) }, onClose: { paneToClose = pane })
    }

    /// The round "+" (§4.3): a 52 pt `interactive` disc at the bottom-right corner, over the list and fixed while it
    /// scrolls; 40 % and inert while the connection is not up (the banner says why). Same size, place and words as Android.
    private var newTerminalButton: some View {
        let connected = model.connectionState == .connected
        return Button { showNewTerminal = true } label: {
            Image(systemName: "plus")
                .font(.system(size: 22, weight: .semibold))
                .foregroundStyle(Theme.onInteractive)
                .frame(width: 52, height: 52)
                .background(Theme.interactive, in: Circle())
        }
        .buttonStyle(.plain)
        .disabled(!connected)
        .opacity(connected ? 1 : 0.4)
        .accessibilityLabel("New terminal")
    }

    // MARK: Waiting / unpaired (§4.3 states)

    /// No snapshot yet: the header pill already says Connecting… / Offline / Not paired; here only the sentence and the action.
    private var waiting: some View {
        VStack(spacing: 14) {
            Spacer()
            if model.needsRepair {
                Text("This phone is no longer paired.")
                    .font(.system(size: 15))
                    .foregroundStyle(Theme.fg2)
                Button("Forget host and pair again") { model.forgetHost() }
                    .buttonStyle(QuietButtonStyle(color: Theme.interactive))
            } else {
                Text("Waiting for the bridge…")
                    .font(.system(size: 15))
                    .foregroundStyle(Theme.fg2)
                Button("Retry now") { Task { await model.reconnectNow() } }
                    .buttonStyle(QuietButtonStyle(color: Theme.interactive))
            }
            Spacer()
            Spacer()
        }
        .frame(maxWidth: .infinity)
        .background(Theme.bg)
    }
}

// MARK: - Row (§4.3)

/// Two lines: the session title, then "<cwd basename> · <status word>"; the tool glyph leads, the bell and the elapsed
/// time trail. A tap opens the pane; the long press opens the menu.
struct PaneRow: View {
    let pane: Pane
    /// "Tell me when it's done" is armed for this pane (bell).
    var armed = false
    var onTap: () -> Void
    /// The long-press menu's one item (§4.3): close the terminal (the caller confirms first).
    var onClose: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            Rectangle().fill(Theme.separator).frame(height: 1)
            HStack(spacing: 10) {
                // Which tool runs here, in the tool's own colour (§4.12); its label names the tool, line 2 has the status.
                AgentGlyph(kind: .kind(forAgent: pane.agent))
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(Theme.toolName(for: pane))
                VStack(alignment: .leading, spacing: 2) {
                    Text(Theme.sessionTitle(for: pane))
                        .font(Theme.mono(15, bold: true))
                        .foregroundStyle(Theme.fg)
                        .lineLimit(1)
                        .truncationMode(.tail)
                    if let detail {
                        detail
                            .lineLimit(1)
                            .truncationMode(.tail)
                    }
                }
                Spacer(minLength: 8)
                if armed {
                    Image(systemName: "bell.fill")
                        .font(.system(size: 11))
                        .foregroundStyle(Theme.fg3)
                        .accessibilityLabel("Notifies when done")
                }
                if let since = pane.since, pane.agentStatus == .working || pane.agentStatus == .blocked {
                    ElapsedText(sinceMs: since)
                }
            }
            .padding(.vertical, 12)
            .contentShape(Rectangle())
            // Not a `Button` (it would also fire on release after the long press): a tap gesture, and the system
            // context menu for the long press (its own lift, haptic and dismissal).
            .onTapGesture(perform: onTap)
            .contextMenu {
                Button("Close terminal", role: .destructive, action: onClose)
            }
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isButton)
            .accessibilityHint(pane.isBlocked ? "Opens the pane to answer" : "Opens the pane")
            .accessibilityAction(.default, onTap)
            .accessibilityAction(named: "Close terminal", onClose)
            .padding(.horizontal, 16)
        }
    }

    /// Line 2, mono 13: the cwd's basename in `fg3` (only when it is not line 1), then the status word in the status
    /// colour, dotted; nil for a plain shell without a known cwd.
    private var detail: Text? {
        var pieces: [Text] = []
        if let dir = cwdBasename(pane.cwd), dir != Theme.sessionTitle(for: pane) {
            pieces.append(Text(dir).foregroundStyle(Theme.fg3))
        }
        if let word = Theme.word(for: pane) {
            pieces.append(Text(word).foregroundStyle(Theme.color(for: pane)))
        }
        guard var text = pieces.first else { return nil }
        for piece in pieces.dropFirst() {
            text = text + Text(" · ").foregroundStyle(Theme.fg3) + piece
        }
        return text.font(Theme.mono(13))
    }
}

/// The pane view's overflow action: ends the shell on the desktop (after confirmation).
struct CloseTerminalButton: View {
    let action: () -> Void

    var body: some View {
        Button(role: .destructive, action: action) { Label("Close terminal", systemImage: "xmark.rectangle") }
    }
}

// MARK: - New terminal (§4.10)

/// Name + command for a fresh terminal on the desktop; quick picks start the coding agents.
@MainActor
private struct NewTerminalSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var label = ""
    @State private var command = ""
    @State private var busy = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    FieldLabel("Name (optional)")
                    SheetField(placeholder: "Name (optional)", text: $label, promptExample: "")
                    FieldLabel("Command to run (optional)")
                    SheetField(placeholder: "Command to run (optional)", text: $command, mono: true, promptExample: "claude")
                    HStack(spacing: 8) {
                        ForEach(["claude", "codex", "pi"], id: \.self) { pick in
                            Button(pick) {
                                command = pick
                                if label.isEmpty { label = pick }
                            }
                            .buttonStyle(ChipButtonStyle())
                        }
                    }
                    .padding(.top, 4)
                    Text("Opens a new herdr tab on the desktop and runs the command once the shell is ready.")
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.fg3)
                        .padding(.top, 4)
                    Button(busy ? "Creating…" : "Create") { create() }
                        .buttonStyle(PrimaryButtonStyle())
                        .disabled(busy)
                        .padding(.top, 10)
                }
                .padding(16)
            }
            .background(Theme.bg)
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(Theme.bg, for: .navigationBar)
            .toolbarBackground(.visible, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    Text("New terminal").font(.system(size: 17, weight: .semibold)).foregroundStyle(Theme.fg)
                }
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(busy) }
            }
        }
        .tint(Theme.interactive)
        .presentationBackground(Theme.bg)
    }

    private func create() {
        busy = true
        Task {
            let pane = await model.createPane(label: label.isEmpty ? nil : label, command: command.isEmpty ? nil : command)
            busy = false
            if pane != nil { dismiss() }
        }
    }
}

/// The caption above a field whose placeholder is an example rather than its name (§4.10).
struct FieldLabel: View {
    let text: String
    init(_ text: String) { self.text = text }

    var body: some View {
        Text(text)
            .font(.system(size: 13))
            .foregroundStyle(Theme.fg2)
            .padding(.top, 4)
    }
}

/// A text field drawn as a `panel` card (§4.8 / §4.10).
struct SheetField: View {
    let placeholder: String
    @Binding var text: String
    var mono = false
    var capitals = false
    var keyboard: UIKeyboardType = .default
    var promptExample: String? = nil

    var body: some View {
        TextField("", text: $text, prompt: Text(promptExample ?? placeholder).foregroundStyle(Theme.fg3))
            .font(mono ? Theme.mono(15) : .system(size: 15))
            .foregroundStyle(Theme.fg)
            .tint(Theme.interactive)
            .keyboardType(keyboard)
            .textInputAutocapitalization(capitals ? .characters : .never)
            .autocorrectionDisabled()
            .padding(12)
            .background(Theme.panel, in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.line, lineWidth: 1))
            .accessibilityLabel(placeholder)
    }
}

/// Quick-pick chip: `panel2` with a `line` border.
struct ChipButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(Theme.mono(13))
            .foregroundStyle(Theme.fg)
            .padding(.horizontal, 12)
            .padding(.vertical, 7)
            .background(Theme.panel2, in: Capsule())
            .overlay(Capsule().stroke(Theme.line, lineWidth: 1))
            .opacity(configuration.isPressed ? 0.7 : 1)
    }
}

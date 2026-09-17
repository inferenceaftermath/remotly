// The terminal screen (shared/design/DESIGN.md §4.4–§4.7): title block and status mark in the header, the terminal
// flush on `bg`, the approval card while the pane is blocked, the key row and the composer.
import FlowKit
import PhotosUI
import SwiftUI
import UIKit

// @MainActor: `pane`, `send()` and the bindings touch the main-actor AppModel outside `body`.
@MainActor
struct PaneView: View {
    let paneId: String
    @Environment(AppModel.self) private var model
    @AppStorage("terminalFontSize") private var fontSize: Double = 0
    @AppStorage("fitPaneToDevice") private var fitToDevice = true
    @AppStorage("zoomOnDesktop") private var zoomOnDesktop = true
    @State private var draft = ""
    @State private var rawMode = false
    /// Photos waiting in the composer; their host paths go out with the next message.
    @State private var attachments: [Attachment] = []
    @State private var pickerItems: [PhotosPickerItem] = []
    @State private var showPhotoPicker = false
    @State private var showCamera = false
    @State private var ctrlArmed = false
    @State private var confirmClose = false
    /// Point size the terminal is drawing with (reported by the view; 0 until it has laid out).
    @State private var fontSizeInUse: Double = 0
    @FocusState private var composerFocused: Bool

    private var pane: Pane? { model.pane(paneId) }
    /// Per pane: swipes scroll the phone's own history (default) or are forwarded to the program as wheel/arrow steps.
    private var scrollMode: Binding<ScrollMode> {
        Binding(get: { model.scrollMode(for: paneId) }, set: { model.setScrollMode($0, for: paneId) })
    }
    /// "Tell me when it's done" for this pane.
    private var notifyDone: Binding<Bool> {
        Binding(get: { model.isArmed(paneId) }, set: { on in Task { await model.setNotifyDone(paneId, on) } })
    }

    var body: some View {
        GeometryReader { geo in
            VStack(spacing: 0) {
                terminal
                if let pane, pane.isBlocked, let promptId = pane.promptId {
                    // The card takes its natural height up to 55 % of the screen; a longer dialog (six-line command, many
                    // options, large text) scrolls inside it so the key row and composer stay reachable (same cap on Android).
                    ViewThatFits(in: .vertical) {
                        ApprovalCard(pane: pane, promptId: promptId)
                        ScrollView(.vertical) { ApprovalCard(pane: pane, promptId: promptId) }
                    }
                    .frame(maxHeight: geo.size.height * 0.55)
                }
                KeyRow(ctrlArmed: $ctrlArmed) { keys in model.sendKeys(keys) }
                composer
            }
        }
        .background(Theme.bg)
        .toastHost()
        .navigationTitle("")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarRole(.editor) // back chevron without the list's title next to it
        .toolbarBackground(Theme.bg, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .toolbar {
            // The title block and the mark live in the principal slot, not `.topBarLeading`: iOS 26 draws a glass
            // circle around leading items and squeezes a two-line title into it. The editor role left-aligns the slot.
            ToolbarItem(placement: .principal) { header }
            ToolbarItemGroup(placement: .topBarTrailing) {
                textSizeButtons
                overflowMenu
            }
        }
        .onAppear { model.startViewing(paneId, zoom: zoomOnDesktop) }
        .onDisappear { model.stopViewing(paneId) }
        .confirmationDialog("Close \(pane.map { Theme.sessionTitle(for: $0) } ?? paneId)?", isPresented: $confirmClose, titleVisibility: .visible) {
            Button("Close terminal", role: .destructive) { Task { await model.closePane(paneId) } }
            Button("Cancel", role: .cancel) {} // explicit: the iPad popover adds none of its own (Android shows Cancel)
        } message: {
            Text("Ends the shell on the desktop and anything running in it.")
        }
        .onChange(of: fitToDevice) { _, on in
            if !on { model.releaseFit() }
        }
        .onChange(of: draft) { old, new in
            // Ctrl armed: the one character just typed goes out at once as `ctrl+<key>` and disarms; the draft is left
            // as it was (same on Android).
            guard ctrlArmed, new.count == old.count + 1, new.hasPrefix(old), let key = new.last else { return }
            model.sendKeys([KeyName.ctrl(key)])
            ctrlArmed = false
            draft = old
        }
        .onChange(of: zoomOnDesktop) { _, on in model.setZoomWhileViewing(on) }
    }

    // MARK: Header (§4.4)

    /// Title left, status mark (or connection / fitting pill) right, filling the space between the back chevron
    /// and the trailing buttons. No layout priority on either side: when the slot is narrow (a long connection word,
    /// large text) the stack offers each half and both truncate, instead of the pill pushing the title out.
    private var header: some View {
        HStack(spacing: 8) {
            titleBlock
            Spacer(minLength: 0)
            statusIndicator
        }
        .frame(maxWidth: .infinity)
    }

    /// A− / A+ as one toolbar item (one glass capsule on iOS 26, less width than two items): one point each way.
    private var textSizeButtons: some View {
        HStack(spacing: 0) {
            Button { adjustFontSize(by: -1) } label: {
                Image(systemName: "textformat.size.smaller")
                    .foregroundStyle(Theme.fg2)
                    .frame(minWidth: 32, minHeight: 32)
            }
            .accessibilityLabel("Smaller text")
            Button { adjustFontSize(by: 1) } label: {
                Image(systemName: "textformat.size.larger")
                    .foregroundStyle(Theme.fg2)
                    .frame(minWidth: 32, minHeight: 32)
            }
            .accessibilityLabel("Larger text")
        }
    }

    /// The session title (§4.4, the same as the list row's line 1); one line, nothing under it.
    private var titleBlock: some View {
        Text(titleText)
            .font(Theme.mono(15))
            .foregroundStyle(Theme.titleFg)
            .lineLimit(1)
            .truncationMode(.tail)
            .accessibilityAddTraits(.isHeader)
    }

    private var titleText: String {
        guard let pane else { return paneId }
        return Theme.sessionTitle(for: pane)
    }

    /// The connection word while the bridge is not connected (there is no banner on this screen), "Fitting…" while a
    /// fit is in progress (§3), else the pane's status mark, animated while working (§4.12).
    @ViewBuilder
    private var statusIndicator: some View {
        if model.connectionState != .connected {
            ConnectionPill()
        } else if model.fitting {
            StatusPill(color: Theme.working, text: "Fitting…")
        } else if let pane {
            PaneMark(pane: pane, height: 18, animated: true)
        }
    }

    /// Same items and order as Android (§4.4). Text size has no item here: A− / A+ in the header are its only control.
    private var overflowMenu: some View {
        Menu {
            Button {
                UIPasteboard.general.string = (model.history ?? model.grid).plainText()
                model.showNotice("copied")
            } label: {
                Label("Copy screen", systemImage: "doc.on.doc")
            }
            Toggle(isOn: $rawMode) { Label("Raw text mode", systemImage: "terminal") }
            if pane?.hasAgent == true {
                Toggle(isOn: notifyDone) { Label("Tell me when it's done", systemImage: "bell") }
            }
            Picker("Swiping up and down", selection: scrollMode) {
                ForEach(ScrollMode.allCases) { mode in
                    Text(mode.label).tag(mode)
                }
            }
            .pickerStyle(.inline)
            Divider()
            CloseTerminalButton { confirmClose = true }
        } label: {
            Image(systemName: "ellipsis.circle").foregroundStyle(Theme.fg2)
        }
        .accessibilityLabel("More")
    }

    /// One point up or down from the size actually in use (default: the phone's body text size), persisted.
    private func adjustFontSize(by delta: Double) {
        let current = fontSizeInUse > 0 ? fontSizeInUse : (fontSize > 0 ? fontSize : Double(TerminalMetrics.fitDefaultSize))
        fontSize = min(32, max(5, current + delta))
    }

    // MARK: Terminal

    private var terminal: some View {
        TerminalView(grid: model.history ?? model.grid, fontSize: $fontSize, isHistory: model.history != nil,
                     fitMode: fitToDevice,
                     forwardScroll: model.effectiveScrollMode(for: paneId) != .scrollback,
                     onDeviceGrid: { cols, rows in if fitToDevice { model.fitPane(cols: cols, rows: rows) } },
                     onPullTop: { model.loadHistory(lines: 300) },
                     onNearTop: { model.loadMoreHistory() },
                     onPullBottom: { model.jumpToLive() },
                     onScrollLines: { direction, lines, col, row in model.scroll(direction: direction, lines: lines, col: col, row: row) },
                     onEffectiveFontSize: { fontSizeInUse = $0 })
            .background(Theme.bg)
            .overlay {
                if model.history == nil, model.grid.pane == nil {
                    Text("Waiting for the first frame…")
                        .font(.system(size: 15))
                        .foregroundStyle(Theme.fg2)
                        .allowsHitTesting(false)
                }
            }
            .overlay(alignment: .bottomTrailing) {
                if model.history != nil {
                    // Pulling past the bottom also returns to live; this is the visible cue that the screen is frozen.
                    Button { model.jumpToLive() } label: {
                        Text("Live ↓")
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(Theme.onInteractive)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 6)
                            .background(Theme.interactive, in: Capsule())
                    }
                    .buttonStyle(.plain)
                    .padding(12)
                    .accessibilityLabel("Back to live")
                }
            }
            .overlay(alignment: .bottom) {
                if model.isLoadingHistory {
                    ProgressView().tint(Theme.fg2).padding(.bottom, 48)
                }
            }
            .overlay(alignment: .top) {
                if model.noScrollbackHint { noScrollbackBanner }
            }
    }

    /// A pull for scrollback found nothing above the screen in herdr (the program draws its own screen, or the shell is fresh).
    private var noScrollbackBanner: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Nothing older here: herdr holds no scrollback for this pane. If a full-screen program is running, swipes can go to it as mouse-wheel steps.")
                .font(.system(size: 14))
                .foregroundStyle(Theme.fg)
            Button("Use mouse wheel") {
                model.setScrollMode(.wheel, for: paneId)
                model.dismissNoScrollbackHint()
            }
            .buttonStyle(QuietButtonStyle(color: Theme.interactive))
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .card(radius: 10)
        .padding(.horizontal, 16)
        .padding(.top, 8)
        .contentShape(Rectangle())
        .onTapGesture { model.dismissNoScrollbackHint() }
        .transition(.move(edge: .top).combined(with: .opacity))
    }

    // MARK: Composer (§4.7)

    /// Text or photos (or both) go out together: the uploaded photos' host paths are appended to the text,
    /// space-separated, so the agent reads the files. Send waits until every photo is stored on the host.
    private var canSend: Bool {
        (!draft.isEmpty || attachments.contains { $0.path != nil }) && attachments.allSatisfy { $0.path != nil }
    }

    private var placeholder: String {
        if ctrlArmed { return "Ctrl + one key…" }
        return rawMode ? "Type raw text…" : "Message the agent…"
    }

    private var composer: some View {
        VStack(spacing: 6) {
            if !attachments.isEmpty {
                AttachmentChips(attachments: attachments, onRemove: { a in attachments.removeAll { $0.id == a.id } }, onRetry: { upload($0) })
            }
            composerRow
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(Theme.panel2, in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(Theme.line, lineWidth: 1))
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(Theme.bg)
        .photosPicker(isPresented: $showPhotoPicker, selection: $pickerItems, maxSelectionCount: 4, matching: .images)
        .onChange(of: pickerItems) { _, items in
            guard !items.isEmpty else { return }
            pickerItems = []
            Task { await addPhotos(items) }
        }
        .fullScreenCover(isPresented: $showCamera) {
            CameraPicker { image in
                showCamera = false
                if let image { add(ImagePrep.attachment(from: image)) }
            }
            .ignoresSafeArea()
        }
    }

    private var composerRow: some View {
        HStack(alignment: .bottom, spacing: 8) {
            Menu {
                if UIImagePickerController.isSourceTypeAvailable(.camera) {
                    Button { showCamera = true } label: { Label("Take photo", systemImage: "camera") }
                }
                Button { showPhotoPicker = true } label: { Label("Choose photos", systemImage: "photo.on.rectangle") }
            } label: {
                Text("+")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(Theme.titleFg)
                    .frame(width: 24, height: 24)
                    .background(Theme.line, in: Circle())
            }
            .disabled(model.host == nil || attachments.count >= 8)
            .padding(.bottom, 2)
            .accessibilityLabel("Attach a photo")
            TextField("", text: $draft, prompt: Text(placeholder).foregroundStyle(Theme.fg3), axis: .vertical)
                .lineLimit(1...6)
                .font(.system(size: 15))
                .foregroundStyle(Theme.fg)
                .tint(Theme.interactive)
                .autocorrectionDisabled(rawMode)
                .textInputAutocapitalization(rawMode ? .never : .sentences)
                .focused($composerFocused)
                .padding(.vertical, 4)
            // Closure literal rather than `action: send`: a bare main-actor method reference would be a
            // function conversion that drops the global actor, which Swift 6 may reject.
            Button { send() } label: {
                Image(systemName: "arrow.up")
                    .font(.system(size: 14, weight: .bold))
                    .foregroundStyle(Theme.onInteractive)
                    .frame(width: 28, height: 28)
                    .background(Theme.interactive, in: Circle())
            }
            .buttonStyle(.plain)
            .disabled(!canSend)
            .opacity(canSend ? 1 : 0.4)
            .accessibilityLabel(rawMode ? "Send raw text" : "Send message")
        }
    }

    private func send() {
        guard canSend else { return }
        let paths = attachments.compactMap(\.path)
        let text = ([draft].filter { !$0.isEmpty } + paths).joined(separator: " ")
        guard !text.isEmpty else { return }
        if rawMode { model.sendText(text) } else { model.sendPrompt(text) }
        draft = ""
        attachments.removeAll()
    }

    private func addPhotos(_ items: [PhotosPickerItem]) async {
        for item in items {
            guard let data = try? await item.loadTransferable(type: Data.self) else { continue }
            add(ImagePrep.attachment(from: data))
        }
    }

    private func add(_ attachment: Attachment?) {
        guard let attachment else {
            model.showNotice("could not read that photo")
            return
        }
        attachments.append(attachment)
        upload(attachment)
    }

    /// Straight to the bridge, so the send itself is instant; the chip shows progress and failures (tap to retry).
    private func upload(_ attachment: Attachment) {
        guard let host = model.host else {
            attachment.state = .failed("Not paired")
            return
        }
        attachment.state = .uploading
        Task {
            do {
                let result = try await UploadClient(host: host).upload(attachment.jpeg)
                attachment.state = .uploaded(path: result.path)
            } catch {
                attachment.state = .failed(error.localizedDescription)
            }
        }
    }
}

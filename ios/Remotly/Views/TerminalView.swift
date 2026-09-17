// SwiftUI wrapper: a UIScrollView (horizontal pan when cols exceed the width, vertical for tall
// grids / scrollback) hosting TerminalGridUIView. A font size of 0 means the default: the phone's body
// text size in fit mode, otherwise "fit cols to the width" (7–14 pt). The A− / A+ toolbar buttons
// persist an explicit size (no pinch: it was fiddly). The view reports the size it actually uses.
//
// herdr's live screen is usually taller than the phone (a fit keeps herdr's row count), so the view is
// a window over it that follows the last row with content. Vertical swipes either drive the phone's own
// scrollback (pull past the top of the live screen to load history, keep pulling near the top for more,
// pull past the bottom to return to live) or, in forwarding mode, move that window first and, at its
// top or bottom edge, are turned into wheel/arrow steps for the program on the desktop.
//
// Long press selects the word under the finger (keep holding and move to extend); afterwards either
// end can be dragged, a tap clears (and dismisses the keyboard), and the system edit menu offers
// Copy / Select All.
import FlowKit
import SwiftUI
import UIKit

@MainActor
struct TerminalView: UIViewRepresentable {
    var grid: TerminalGrid
    @Binding var fontSize: Double
    var isHistory: Bool
    /// Fit mode: the desktop pane follows this device, so a font size of 0 means the default size (not "fit cols to width").
    var fitMode: Bool = false
    /// Vertical swipes move the window over the live screen and, at its edges, go to the program (`onScrollLines`).
    var forwardScroll: Bool = false
    /// Columns × rows the view can show at the current font (changes on rotation, keyboard, font size).
    var onDeviceGrid: ((Int, Int) -> Void)? = nil
    /// Live mode: the user pulled past the top → load scrollback.
    var onPullTop: (() -> Void)? = nil
    /// History mode: near the top → load more (the model throttles).
    var onNearTop: (() -> Void)? = nil
    /// History mode: the user pulled past the bottom → back to live.
    var onPullBottom: (() -> Void)? = nil
    /// Forwarding mode: `lines` steps in "up"/"down" at the touched cell (1-based col, row).
    var onScrollLines: ((String, Int, Int, Int) -> Void)? = nil
    /// The point size actually drawn (differs from `fontSize` while that is 0); the A− / A+ buttons step from it.
    var onEffectiveFontSize: ((Double) -> Void)? = nil

    final class Coordinator {
        var wasHistory = false
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> TerminalScrollView { TerminalScrollView() }

    func updateUIView(_ view: TerminalScrollView, context: Context) {
        view.onEffectiveFontSize = onEffectiveFontSize
        view.onDeviceGrid = onDeviceGrid
        view.onPullTop = onPullTop
        view.onNearTop = onNearTop
        view.onPullBottom = onPullBottom
        view.onScrollLines = onScrollLines
        view.fitMode = fitMode
        view.forwardScroll = forwardScroll
        view.isHistory = isHistory
        view.userFontSize = CGFloat(fontSize)
        let switched = context.coordinator.wasHistory != isHistory
        context.coordinator.wasHistory = isHistory
        // Both directions land at the bottom: the newest history lines, or the live prompt.
        view.setGrid(grid, scroll: switched ? .bottom : .none)
    }
}

final class TerminalScrollView: UIScrollView, UIScrollViewDelegate, UIGestureRecognizerDelegate {
    enum ScrollTarget { case none, top, bottom }

    let content = TerminalGridUIView()
    var onEffectiveFontSize: ((Double) -> Void)?
    private var reportedFontSize: CGFloat = 0
    var onPullTop: (() -> Void)?
    var onNearTop: (() -> Void)?
    var onPullBottom: (() -> Void)?
    var onScrollLines: ((String, Int, Int, Int) -> Void)?
    /// 0 → fit to width.
    var userFontSize: CGFloat = 0 {
        didSet { if userFontSize != oldValue { relayout() } }
    }
    var fitMode = false {
        didSet { if fitMode != oldValue { relayout() } }
    }
    var isHistory = false
    var forwardScroll = false {
        didSet {
            guard forwardScroll != oldValue else { return }
            forwardPan.isEnabled = forwardScroll
            // Forwarding: the window over the live screen stops dead at its edges (no rubber band); what a swipe cannot
            // spend there goes to the program. Scrollback mode keeps the bounce as the pull-to-history affordance.
            alwaysBounceVertical = !forwardScroll
            bounces = !forwardScroll
            forwardAccumulated = 0
            pendingSteps = 0
            edgeInertia = 0
            cancelInertia()
            if !forwardScroll { content.endSlide() }
            stickToBottom = true
            relayout()
        }
    }
    var onDeviceGrid: ((Int, Int) -> Void)?
    private var lastDeviceGrid = (cols: 0, rows: 0)
    private var pendingScroll: ScrollTarget = .none
    /// Offset to add once the grid has grown at the top (older history arrived): keeps the visible lines in place.
    private var pendingOffsetDelta: CGFloat = 0
    /// One pull-past-the-edge event per bounce.
    private var pullLatched = false
    /// Live mode: the user is at (or below) the bottom, so new rows and size changes keep the prompt in view.
    private var stickToBottom = true
    private let forwardPan = UIPanGestureRecognizer()
    private var forwardAccumulated: CGFloat = 0
    private var forwardLastY: CGFloat = 0
    private var pendingSteps = 0 // > 0 down, < 0 up
    /// Forwarding: speed (points/ms, signed like contentOffset.y) a fling will have left when the window reaches the
    /// edge it is heading for; handed to the program as wheel steps once the deceleration ends there.
    private var edgeInertia: CGFloat = 0
    private var forwardReleasePoint = CGPoint.zero
    private var pendingCell = (col: 1, row: 1)
    private var flushScheduled = false
    /// Emulated inertia after a fling in forwarding mode (the desktop program has none): lines/s left, fraction carried, lines sent.
    private var inertiaTask: Task<Void, Never>?
    private var inertiaSpeed: CGFloat = 0
    private var inertiaDirection: CGFloat = 1
    private var inertiaCarry: CGFloat = 0
    private var inertiaSent = 0
    private var inertiaPoint = CGPoint.zero
    /// When a swipe or inertia step last went to the program; a frame within `slideWindow` of it may slide.
    private var lastForwardedScrollAt: CFTimeInterval = 0
    private var lastShiftFrameAt: CFTimeInterval = 0
    private let slideWindow: CFTimeInterval = 1.2
    private let longPress = UILongPressGestureRecognizer()
    private let selectionPan = UIPanGestureRecognizer()
    private let tap = UITapGestureRecognizer()
    private lazy var editMenu = UIEditMenuInteraction(delegate: self)
    /// 0 = not dragging a selection end, 1 = moving the anchor, 2 = moving the focus.
    private var draggingEnd = 0

    override init(frame: CGRect) {
        super.init(frame: frame)
        configure()
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        configure()
    }

    private func configure() {
        addSubview(content)
        backgroundColor = TerminalTheme.background
        alwaysBounceVertical = true // the live screen fits the view; the bounce is the pull-to-scrollback affordance
        alwaysBounceHorizontal = false
        showsHorizontalScrollIndicator = true
        showsVerticalScrollIndicator = true
        contentInsetAdjustmentBehavior = .never
        keyboardDismissMode = .interactive
        delegate = self
        forwardPan.addTarget(self, action: #selector(handleForwardPan(_:)))
        forwardPan.delegate = self
        forwardPan.isEnabled = false
        addGestureRecognizer(forwardPan)
        longPress.addTarget(self, action: #selector(handleLongPress(_:)))
        addGestureRecognizer(longPress)
        selectionPan.addTarget(self, action: #selector(handleSelectionPan(_:)))
        // Must be our delegate, or gestureRecognizerShouldBegin is never consulted and selectionPan claims
        // every swipe (default begin = true). Both the scroll pan and forwardPan require(toFail: selectionPan),
        // so an ungated selectionPan silently blocks all scrolling — scrollback, wheel and arrows alike.
        selectionPan.delegate = self
        addGestureRecognizer(selectionPan)
        tap.addTarget(self, action: #selector(handleTap(_:)))
        addGestureRecognizer(tap)
        // A still finger becomes a selection, a moving one a scroll: the pans wait for the long press to
        // fail (it fails as soon as the finger moves), and for a grab of a selection end to be ruled out.
        panGestureRecognizer.require(toFail: longPress)
        panGestureRecognizer.require(toFail: selectionPan)
        forwardPan.require(toFail: longPress)
        forwardPan.require(toFail: selectionPan)
        addInteraction(editMenu)
    }

    func setGrid(_ grid: TerminalGrid, scroll: ScrollTarget) {
        let old = content.grid
        let oldRows = old.rows
        if scroll != .none || grid.rows != oldRows || grid.cols != old.cols { clearSelection() } // different cells underneath
        // A frame that is the previous screen scrolled by whole rows, arriving while the user is scrolling the
        // program: glide it into place. The slide lasts about as long as the gap between such frames, so a
        // steady scroll becomes continuous motion and a lone frame settles within 150 ms.
        if forwardScroll, !isHistory, scroll == .none, CACurrentMediaTime() - lastForwardedScrollAt < slideWindow,
           let shift = RowShift.detect(from: old, to: grid) {
            let now = CACurrentMediaTime()
            let since = now - lastShiftFrameAt
            lastShiftFrameAt = now
            content.beginSlide(shift, from: old, duration: min(0.15, max(0.05, since)))
        }
        content.update(grid: grid)
        if scroll != .none {
            pendingScroll = scroll
            if scroll == .bottom { stickToBottom = true }
        } else if isHistory, oldRows > 0, grid.rows > oldRows {
            pendingOffsetDelta += CGFloat(grid.rows - oldRows) * content.metrics.lineHeight
        }
        relayout()
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        relayout()
    }

    private func relayout() {
        let available = bounds.width - adjustedContentInset.left - adjustedContentInset.right
        let effective = userFontSize > 0 ? userFontSize : (fitMode ? TerminalMetrics.fitDefaultSize : TerminalMetrics.fittingSize(cols: content.grid.cols, width: available))
        if content.metrics.size != effective { content.metrics = TerminalMetrics(size: effective) }
        if reportedFontSize != effective {
            reportedFontSize = effective
            Task { @MainActor [weak self] in self?.onEffectiveFontSize?(Double(effective)) } // after SwiftUI's update, not during it
        }
        reportDeviceGrid(availableWidth: available)
        let gridSize = content.gridSize
        // Live: the view scrolls over herdr's taller screen down to the last row with content (blank rows below are not
        // scrollable); in forwarding mode a swipe moves this window first and goes to the program at its edges. History: every line.
        let height = isHistory ? max(gridSize.height, bounds.height) : max(min(gridSize.height, contentBottom), bounds.height)
        let size = CGSize(width: max(gridSize.width, bounds.width), height: height)
        if contentSize != size { contentSize = size }
        applyPendingScroll()
        if !isHistory, stickToBottom, !isTracking, !isDragging, !isDecelerating, contentOffset.y != liveBottomY {
            setContentOffset(CGPoint(x: contentOffset.x, y: liveBottomY), animated: false) // live screen taller than the view: follow the prompt
        }
        positionContent()
    }

    /// The grid view is viewport-sized and pinned to the visible area; it draws the rows under `contentOffset`.
    private func positionContent() {
        let frame = CGRect(origin: contentOffset, size: bounds.size)
        if content.frame != frame { content.frame = frame }
        content.origin = contentOffset
    }

    /// Whether the window over the live screen cannot move further that way, so a swipe there is for the program.
    private func atEdge(towardBottom: Bool) -> Bool {
        towardBottom ? contentOffset.y >= maxOffsetY - 0.5 : contentOffset.y <= 0.5
    }

    /// Height of the rows up to and including the last one with anything on it.
    private var contentBottom: CGFloat {
        CGFloat((content.grid.lastContentRow ?? -1) + 1) * content.metrics.lineHeight
    }

    /// Where "the bottom" is: in history the last line; live, the last row with content. herdr's grid is
    /// taller than this view, so a fresh shell (prompt on row 1, 60 blank rows below) must show its top,
    /// while Claude Code (status bar on the last row) shows its bottom.
    private var liveBottomY: CGFloat {
        guard !isHistory else { return maxOffsetY }
        return min(maxOffsetY, max(0, contentBottom - bounds.height))
    }

    private func reportDeviceGrid(availableWidth: CGFloat) {
        let availableHeight = bounds.height - adjustedContentInset.top - adjustedContentInset.bottom
        guard availableWidth > 0, availableHeight > 0, content.metrics.cellWidth > 0, content.metrics.lineHeight > 0 else { return }
        let grid = (cols: Int(availableWidth / content.metrics.cellWidth), rows: Int(availableHeight / content.metrics.lineHeight))
        guard grid.cols > 0, grid.rows > 0, grid != lastDeviceGrid else { return }
        lastDeviceGrid = grid
        onDeviceGrid?(grid.cols, grid.rows)
    }

    private var maxOffsetY: CGFloat { max(0, contentSize.height - bounds.height) }

    private func applyPendingScroll() {
        guard bounds.height > 0 else { return }
        if pendingOffsetDelta != 0 {
            let y = min(maxOffsetY, max(0, contentOffset.y + pendingOffsetDelta))
            pendingOffsetDelta = 0
            setContentOffset(CGPoint(x: contentOffset.x, y: y), animated: false)
        }
        guard pendingScroll != .none else { return }
        switch pendingScroll {
        case .top:
            setContentOffset(.zero, animated: false)
        case .bottom:
            setContentOffset(CGPoint(x: 0, y: liveBottomY), animated: false)
        case .none:
            break
        }
        pendingScroll = .none
        pullLatched = false
    }

    // MARK: Scrollback gestures

    func scrollViewWillBeginDragging(_ scrollView: UIScrollView) {
        clearSelection()
        edgeInertia = 0
    }

    func scrollViewDidScroll(_ scrollView: UIScrollView) {
        positionContent()
        // Only the user's own scrolling (a drag or its deceleration) decides whether the window keeps following the
        // bottom; programmatic offsets (the pin itself, history growth) do not.
        guard isTracking || isDragging || isDecelerating else { return }
        let y = contentOffset.y
        let line = content.metrics.lineHeight
        guard line > 0 else { return }
        if !isHistory { stickToBottom = y >= liveBottomY - line / 2 }
        guard !forwardScroll else { return }
        if y >= 0, y <= maxOffsetY { pullLatched = false }
        if y < -line * 2 {
            guard !pullLatched else { return }
            pullLatched = true
            if isHistory { onNearTop?() } else { onPullTop?() }
        } else if isHistory {
            if y >= 0, y < line * 6 { onNearTop?() }
            if y > maxOffsetY + line * 3, !pullLatched {
                pullLatched = true
                onPullBottom?()
            }
        }
    }

    func scrollViewWillEndDragging(_ scrollView: UIScrollView, withVelocity velocity: CGPoint, targetContentOffset: UnsafeMutablePointer<CGPoint>) {
        edgeInertia = 0
        guard forwardScroll, !isHistory, velocity.y != 0 else { return }
        // UIScrollView slows by `decelerationRate` per millisecond, so a fling of v points/ms travels v / (1 - rate) points
        // and has v - d * (1 - rate) left after d points. Whatever is left when the window reaches the edge it is heading
        // for continues as wheel steps (scrollViewDidEndDecelerating). Released against the edge: handleForwardPan does it.
        let toEdge = velocity.y > 0 ? maxOffsetY - contentOffset.y : contentOffset.y
        guard toEdge > 0 else { return }
        let left = abs(velocity.y) - toEdge * (1 - decelerationRate.rawValue)
        if left > 0 { edgeInertia = velocity.y > 0 ? left : -left }
    }

    func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) {
        let v = edgeInertia
        edgeInertia = 0
        let line = content.metrics.lineHeight
        guard v != 0, line > 0, forwardScroll, !isHistory, atEdge(towardBottom: v > 0) else { return }
        // contentOffset.y growing = content moving up = wheel down (positive steps); points/ms → points/s.
        startInertia(linesPerSecond: v * 1000 / line, at: forwardReleasePoint)
    }

    // MARK: Forwarding (wheel / arrows to the program)

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool {
        true // our pan reads vertical movement while the scroll view keeps horizontal panning
    }

    @objc private func handleForwardPan(_ gesture: UIPanGestureRecognizer) {
        let line = content.metrics.lineHeight
        guard line > 0 else { return }
        switch gesture.state {
        case .began:
            cancelInertia() // the finger grabbed the content
            edgeInertia = 0
            forwardAccumulated = 0
            forwardLastY = gesture.translation(in: self).y
        case .changed:
            let y = gesture.translation(in: self).y
            let dy = forwardLastY - y // finger up → content should move up → wheel down
            forwardLastY = y
            // The scroll view (the window over the live screen) moves first; only against its edge is the swipe for the program.
            guard dy != 0, atEdge(towardBottom: dy > 0) else {
                forwardAccumulated = 0
                return
            }
            forwardAccumulated += dy
            let steps = Int(forwardAccumulated / line)
            if steps != 0 {
                forwardAccumulated -= CGFloat(steps) * line
                queueSteps(steps, at: gesture.location(in: self))
            }
        case .ended:
            // Finger up (velocity < 0) → content moves up → wheel down (positive steps). Released against an edge the
            // fling is the program's; otherwise the scroll view decelerates and hands over what is left at the edge.
            forwardReleasePoint = gesture.location(in: self)
            let vy = gesture.velocity(in: self).y
            if vy != 0, atEdge(towardBottom: vy < 0) { startInertia(linesPerSecond: -vy / line, at: forwardReleasePoint) }
        default:
            break
        }
    }

    /// The desktop program has no inertia of its own, so a fling keeps sending wheel steps at a decaying
    /// rate (about 0.6 s, at most a screenful) instead of dumping one burst at the finger's release.
    private func startInertia(linesPerSecond: CGFloat, at point: CGPoint) {
        cancelInertia()
        let speed = min(abs(linesPerSecond), 120)
        guard speed >= 8 else { return }
        inertiaSpeed = speed
        inertiaDirection = linesPerSecond < 0 ? -1 : 1
        inertiaCarry = 0
        inertiaSent = 0
        inertiaPoint = point
        lastForwardedScrollAt = CACurrentMediaTime()
        inertiaTask = Task { @MainActor [weak self] in
            while true {
                guard let self, !Task.isCancelled, self.forwardScroll, self.inertiaSpeed >= 6, self.inertiaSent < 40 else { return }
                try? await Task.sleep(for: .milliseconds(40))
                guard !Task.isCancelled else { return }
                self.inertiaCarry += self.inertiaSpeed * 0.04
                let n = Int(self.inertiaCarry)
                if n > 0 {
                    self.inertiaCarry -= CGFloat(n)
                    self.inertiaSent += n
                    self.queueSteps(Int(self.inertiaDirection) * n, at: self.inertiaPoint)
                }
                self.inertiaSpeed *= 0.82
            }
        }
    }

    private func cancelInertia() {
        inertiaTask?.cancel()
        inertiaTask = nil
        inertiaSpeed = 0
    }

    /// Coalesce steps so a fast swipe is a few `scroll` requests, not one per touch sample.
    private func queueSteps(_ steps: Int, at point: CGPoint) {
        pendingSteps += steps
        // `content.origin` is the grid point under the view's top-left (the window's offset over the live screen), so the cell is the real one on the desktop.
        pendingCell = (col: max(0, Int((point.x - contentOffset.x + content.origin.x) / content.metrics.cellWidth)) + 1,
                       row: max(0, Int((point.y - contentOffset.y + content.origin.y) / content.metrics.lineHeight)) + 1)
        guard !flushScheduled else { return }
        flushScheduled = true
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(40))
            self?.flushSteps()
        }
    }

    private func flushSteps() {
        flushScheduled = false
        let steps = pendingSteps
        pendingSteps = 0
        guard steps != 0 else { return }
        lastForwardedScrollAt = CACurrentMediaTime()
        onScrollLines?(steps > 0 ? "down" : "up", min(50, abs(steps)), pendingCell.col, pendingCell.row)
    }

    // MARK: Selection

    override func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        // The forwarding pan (wheel / arrow steps) sits on top of the scroll view. When the live screen fits the
        // view there is nothing to scroll, so UIScrollView's own gestureRecognizerShouldBegin (super) answers
        // false for every recognizer it is asked about, including ours, and the swipe never begins. Answer for
        // our pan here. (Regression since the selection change added this override; before that the default let
        // forwardPan begin and wheel mode worked.)
        if gestureRecognizer === forwardPan { return forwardScroll }
        guard gestureRecognizer === selectionPan else { return super.gestureRecognizerShouldBegin(gestureRecognizer) }
        // Only a touch starting on one of the selection's ends drags it; otherwise fail fast so the scroll pan runs.
        guard let selection = content.selection else { return false }
        let point = selectionPan.location(in: content)
        let radius = max(content.metrics.lineHeight * 1.5, 22)
        func near(_ p: GridPosition) -> Bool {
            let c = content.cellCenter(p)
            return abs(c.x - point.x) <= radius && abs(c.y - point.y) <= radius
        }
        if near(selection.focus) { draggingEnd = 2 } else if near(selection.anchor) { draggingEnd = 1 } else { return false }
        return true
    }

    @objc private func handleLongPress(_ gesture: UILongPressGestureRecognizer) {
        let point = gesture.location(in: content)
        switch gesture.state {
        case .began:
            guard let cell = content.cell(at: point), let word = content.grid.wordRange(at: cell) else { return }
            editMenu.dismissMenu()
            content.selection = (anchor: word.lowerBound, focus: word.upperBound)
            draggingEnd = 2
            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        case .changed:
            guard draggingEnd != 0, let cell = content.cell(at: point) else { return }
            moveSelectionEnd(to: cell)
        case .ended, .cancelled, .failed:
            guard draggingEnd != 0 else { return }
            draggingEnd = 0
            presentSelectionMenu()
        default:
            break
        }
    }

    @objc private func handleSelectionPan(_ gesture: UIPanGestureRecognizer) {
        switch gesture.state {
        case .began:
            editMenu.dismissMenu()
        case .changed:
            if let cell = content.cell(at: gesture.location(in: content)) { moveSelectionEnd(to: cell) }
        case .ended, .cancelled, .failed:
            draggingEnd = 0
            presentSelectionMenu()
        default:
            break
        }
    }

    /// A tap on the terminal clears any selection and puts the keyboard away (the composer loses focus).
    @objc private func handleTap(_ gesture: UITapGestureRecognizer) {
        clearSelection()
        window?.endEditing(true)
    }

    private func moveSelectionEnd(to cell: GridPosition) {
        guard let s = content.selection else { return }
        content.selection = draggingEnd == 1 ? (anchor: cell, focus: s.focus) : (anchor: s.anchor, focus: cell)
    }

    private func clearSelection() {
        guard content.selection != nil else { return }
        editMenu.dismissMenu()
        content.selection = nil
    }

    private func presentSelectionMenu() {
        guard let rect = content.selectionRect() else { return }
        let visible = convert(rect, from: content).intersection(bounds)
        let anchor = visible.isNull ? convert(rect, from: content) : visible
        editMenu.presentEditMenu(with: UIEditMenuConfiguration(identifier: nil, sourcePoint: CGPoint(x: anchor.midX, y: anchor.minY)))
    }

    private func copySelection() {
        defer { clearSelection() }
        guard let text = content.selectionText, !text.isEmpty else { return }
        UIPasteboard.general.string = text
        UINotificationFeedbackGenerator().notificationOccurred(.success)
    }

    private func selectAll() {
        let grid = content.grid
        guard grid.rows > 0, grid.cols > 0 else { return }
        content.selection = (anchor: GridPosition(row: 0, col: 0), focus: GridPosition(row: grid.rows - 1, col: grid.cols - 1))
        presentSelectionMenu()
    }

    func editMenuInteraction(_ interaction: UIEditMenuInteraction, menuFor configuration: UIEditMenuConfiguration, suggestedActions: [UIMenuElement]) -> UIMenu? {
        let copy = UIAction(title: "Copy", image: UIImage(systemName: "doc.on.doc")) { [weak self] _ in
            MainActor.assumeIsolated { self?.copySelection() }
        }
        let all = UIAction(title: "Select All", image: UIImage(systemName: "selection.pin.in.out")) { [weak self] _ in
            MainActor.assumeIsolated { self?.selectAll() }
        }
        return UIMenu(children: [copy, all])
    }

    func editMenuInteraction(_ interaction: UIEditMenuInteraction, targetRectFor configuration: UIEditMenuConfiguration) -> CGRect {
        guard let rect = content.selectionRect() else { return .null }
        return convert(rect, from: content)
    }

}

// UIEditMenuInteractionDelegate is not main-actor-annotated in the SDK; UIKit always calls it on the
// main thread, so the conformance is declared @preconcurrency (Swift 6 strict concurrency).
extension TerminalScrollView: @preconcurrency UIEditMenuInteractionDelegate {}

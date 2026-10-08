// SwiftUI wrapper: a UIScrollView (horizontal pan when cols exceed the width, vertical for tall
// grids / scrollback) hosting TerminalGridUIView. A font size of 0 means the default: the phone's body
// text size in fit mode, otherwise "fit cols to the width" (7–14 pt). The A− / A+ toolbar buttons
// persist an explicit size (no pinch: it was fiddly). The view reports the size it actually uses.
//
// One continuous column: the pane's history (the bridge's scrollback copy, wrapped to the live grid's
// columns) on top, herdr's live screen below it, the live screen updating while the user reads above.
// The live screen is usually taller than the phone (a fit keeps herdr's row count); the view follows its
// last row with content until the user scrolls up, then keeps what is on screen in place as lines are
// added below it or dropped above it, until "Live ↓" (or a scroll back down) returns to following. In
// forwarding mode the history is hidden: swipes move the window over the live screen first and, at its
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
    /// The pane's history rows, shown above the live grid unless swipes go to the program.
    var history = WrappedHistory()
    var historyStyles = HistoryStyles()
    /// The theme to draw in; passed from the parent's body, so a theme change reaches `updateUIView`.
    var theme: ThemeChoice
    @Binding var fontSize: Double
    /// Fit mode: the desktop pane follows this device, so a font size of 0 means the default size (not "fit cols to width").
    var fitMode: Bool = false
    /// Vertical swipes move the window over the live screen and, at its edges, go to the program (`onScrollLines`).
    var forwardScroll: Bool = false
    /// The pane is on the alternate screen (a full-screen program): its scrolling adds no history, so it is not followed.
    var altScreen: Bool = false
    /// The pane screen's handle on this view ("Live ↓", Copy screen).
    var control: TerminalControl? = nil
    /// Columns × rows the view can show at the current font (changes on rotation, keyboard, font size).
    var onDeviceGrid: ((Int, Int) -> Void)? = nil
    /// The user pulled past the top (of the history, or of the live screen when there is none).
    var onPullTop: (() -> Void)? = nil
    /// Whether the view is scrolled up from the live bottom by more than about a row.
    var onScrolledUp: ((Bool) -> Void)? = nil
    /// Forwarding mode: `lines` steps in "up"/"down" at the touched cell (1-based col, row).
    var onScrollLines: ((String, Int, Int, Int) -> Void)? = nil
    /// The point size actually drawn (differs from `fontSize` while that is 0); the A− / A+ buttons step from it.
    var onEffectiveFontSize: ((Double) -> Void)? = nil

    func makeUIView(context: Context) -> TerminalScrollView { TerminalScrollView() }

    func updateUIView(_ view: TerminalScrollView, context: Context) {
        view.theme = TerminalTheme.of(theme)
        control?.view = view
        view.onEffectiveFontSize = onEffectiveFontSize
        view.onDeviceGrid = onDeviceGrid
        view.onPullTop = onPullTop
        view.onScrolledUp = onScrolledUp
        view.onScrollLines = onScrollLines
        view.fitMode = fitMode
        view.forwardScroll = forwardScroll
        view.altScreen = altScreen
        view.userFontSize = CGFloat(fontSize)
        view.setContent(grid: grid, history: history, styles: historyStyles)
    }
}

/// The pane screen's handle on its terminal view: back to the live bottom, and the text on screen.
@MainActor
final class TerminalControl {
    fileprivate weak var view: TerminalScrollView?

    nonisolated init() {}

    /// Scrolls (animated) to the live bottom and follows it again.
    func scrollToLive() { view?.scrollToLive() }

    /// The rows on screen now (history and/or live), one per line, trailing blanks trimmed.
    func visibleText() -> String { view?.content.visibleText() ?? "" }
}

final class TerminalScrollView: UIScrollView, UIScrollViewDelegate, UIGestureRecognizerDelegate {
    let content = TerminalGridUIView()
    var theme: TerminalTheme {
        get { content.theme }
        set {
            content.theme = newValue
            backgroundColor = newValue.background
        }
    }
    var onEffectiveFontSize: ((Double) -> Void)?
    private var reportedFontSize: CGFloat = 0
    var onPullTop: (() -> Void)?
    var onScrolledUp: ((Bool) -> Void)?
    private var reportedScrolledUp = false
    var onScrollLines: ((String, Int, Int, Int) -> Void)?
    /// 0 → fit to width.
    var userFontSize: CGFloat = 0 {
        didSet { if userFontSize != oldValue { relayout() } }
    }
    var fitMode = false {
        didSet { if fitMode != oldValue { relayout() } }
    }
    var forwardScroll = false {
        didSet {
            guard forwardScroll != oldValue else { return }
            forwardPan.isEnabled = forwardScroll
            // Forwarding: the window over the live screen stops dead at its edges (no rubber band); what a swipe cannot
            // spend there goes to the program. Scrollback mode keeps the bounce (a pull past the top with no history
            // says why there is none).
            alwaysBounceVertical = !forwardScroll
            bounces = !forwardScroll
            forwardAccumulated = 0
            pendingSteps = 0
            edgeInertia = 0
            cancelInertia()
            if !forwardScroll { content.endSlide() }
            stickToBottom = true
            showHistory() // hidden while swipes go to the program
            relayout()
        }
    }
    var onDeviceGrid: ((Int, Int) -> Void)?
    private var lastDeviceGrid = (cols: 0, rows: 0)
    /// The model's history rows, as last handed over (shown only outside forwarding mode).
    private var history = WrappedHistory()
    private let noHistory = WrappedHistory()
    /// Where the top of the view goes once the content size is updated: the rows on screen stay put while history
    /// rows are added below them or dropped above them.
    private var pendingTop: CGFloat?
    /// One pull-past-the-top event per bounce.
    private var pullLatched = false
    /// The user is at (or below) the live bottom, so new rows and size changes keep the prompt in view.
    private var stickToBottom = true
    /// "Live ↓" is scrolling to the bottom; following resumes when it lands (a frame meanwhile does not cut it short).
    private var animatingToLive = false
    /// The live row (in rows, fractional) the top of the view stays on after following text up the live screen, until
    /// the lines that left the screen arrive as history; negative while that text is on such lines. Nil otherwise.
    private var liveAnchor: CGFloat?
    /// See `TerminalView.altScreen`.
    var altScreen = false
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
        backgroundColor = content.theme.background
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

    func setContent(grid: TerminalGrid, history newHistory: WrappedHistory, styles: HistoryStyles) {
        let old = content.grid
        if grid.rows != old.rows || grid.cols != old.cols { clearSelection() } // different cells underneath
        // A frame that is the previous screen scrolled by whole rows, arriving while the user is scrolling the
        // program: glide it into place. The slide lasts about as long as the gap between such frames, so a
        // steady scroll becomes continuous motion and a lone frame settles within 150 ms.
        if forwardScroll, CACurrentMediaTime() - lastForwardedScrollAt < slideWindow,
           let shift = RowShift.detect(from: old, to: grid) {
            let now = CACurrentMediaTime()
            let since = now - lastShiftFrameAt
            lastShiftFrameAt = now
            content.beginSlide(shift, from: old, duration: min(0.15, max(0.05, since)))
        }
        history = newHistory // what `showHistory` brings in below; `followScrolledText` reads only its `answering`
        if !forwardScroll { followScrolledText(from: old, to: grid) }
        content.update(grid: grid)
        content.historyStyles = styles
        showHistory()
        relayout()
    }

    /// The live screen scrolled (output): text the user is reading on its rows, or has selected there, moved up with it.
    /// Scrolled up with the top of the view on those rows, the view moves up as far, so the text stays where it was; the
    /// lines that left the screen arrive as history a moment later and go in above it (`showHistory`). Only the rows that
    /// moved count (an agent's input box and status line below them stay put). A selection on moved rows moves with its
    /// text (off the screen's top: it is let go). Not on the alternate screen, which adds no history, nor while an answer
    /// to a `scrollback` request is arriving: its lines are older output, so the text moves with the screen then. As on
    /// Android.
    private func followScrolledText(from old: TerminalGrid, to grid: TerminalGrid) {
        guard !altScreen, !history.answering else { return }
        let line = content.metrics.lineHeight
        let h = content.history.rowCount
        let y = pendingTop ?? contentOffset.y
        let onLive = !stickToBottom && line > 0 && (liveAnchor != nil || Int(floor(y / line)) >= h)
        let selected = content.selection.map { $0.anchor.row >= h || $0.focus.row >= h } ?? false
        guard onLive || selected, let detected = RowShift.detect(from: old, to: grid), detected.shift > 0 else { return }
        let shift = detected.shift
        if onLive {
            let at = liveAnchor ?? (y / line - CGFloat(h))
            if at < CGFloat(detected.movingRows) {
                liveAnchor = at - CGFloat(shift)
                pendingTop = (CGFloat(h) + at - CGFloat(shift)) * line
            }
        }
        if let selection = content.selection {
            func moves(_ p: GridPosition) -> Bool { p.row >= h && p.row - h < detected.movingRows }
            func moved(_ p: GridPosition) -> GridPosition { moves(p) ? GridPosition(row: p.row - shift, col: p.col) : p }
            let anchor = moved(selection.anchor)
            let focus = moved(selection.focus)
            if (moves(selection.anchor) && anchor.row < h) || (moves(selection.focus) && focus.row < h) {
                clearSelection()
            } else {
                content.selection = (anchor: anchor, focus: focus)
            }
        }
    }

    /// Puts the history (none while swipes go to the program) above the live grid. Scrolled up, what is on screen stays
    /// put: lines appended go in below it (the offset stays), rows of lines dropped at the front come off above it (the
    /// offset drops by their height), a re-wrap keeps the line at the top of the view there, and new lines (a reset)
    /// only clamp the offset; with the top of the view on the live rows, the same live row stays at the top. At the
    /// bottom the view keeps following it (`relayout`).
    private func showHistory() {
        let new = forwardScroll ? noHistory : history
        let old = content.history
        guard new.revision != old.revision || new.generation != old.generation else { return }
        let line = content.metrics.lineHeight
        let oldCount = old.rowCount
        let continued = new.generation == old.generation && !old.isEmpty
        let sameWidth = new.cols == old.cols
        // Rows that came off the front: those of the lines numbered below the new first line.
        let droppedRows = continued && sameWidth && new.firstLine > old.firstLine ? (old.firstRow(ofLine: new.firstLine) ?? oldCount) : 0
        // where the view's top is to be: a frame may have just moved it (`followScrolledText`)
        let y = pendingTop ?? contentOffset.y
        if !stickToBottom, line > 0, !new.answering, let anchor = liveAnchor {
            // The text followed up the live screen: the lines that left it are in now, just above the same live row (or
            // among them, for text that left the screen too, where it then stays).
            pendingTop = (CGFloat(new.rowCount) + anchor) * line
        } else if !stickToBottom, line > 0, Int(floor(y / line)) >= oldCount {
            // On the live rows: the same live row stays at the top (the lines appended are the ones that left the
            // screen; a new copy, a reset, keeps the live row too).
            pendingTop = y + CGFloat(new.rowCount - oldCount) * line
        } else if !stickToBottom, line > 0, continued {
            let topRow = Int(floor(y / line))
            if let at = old.line(atRow: max(0, topRow)) {
                if at.line < new.firstLine {
                    pendingTop = 0 // the line at the top was dropped: the oldest one held is the nearest
                } else if let first = new.firstRow(ofLine: at.line) {
                    // Re-wrapped: the row holding the same part of the line (its first cell's place in the line at the
                    // new width), the same distance into that row.
                    let row = sameWidth ? at.rowInLine : at.rowInLine * old.cols / max(1, new.cols)
                    let rowInLine = min(row, max(0, new.rowCount(ofLine: at.line) - 1))
                    let within = y - CGFloat(topRow) * line
                    pendingTop = CGFloat(first + rowInLine) * line + within
                }
            }
        }
        liveAnchor = nil
        // A selection keeps to its text: history rows move up by the rows dropped, live rows by the change above them.
        if let selection = content.selection {
            if continued && sameWidth {
                let newCount = new.rowCount
                func moved(_ p: GridPosition) -> GridPosition {
                    GridPosition(row: p.row < oldCount ? p.row - droppedRows : p.row + newCount - oldCount, col: p.col)
                }
                let anchor = moved(selection.anchor)
                let focus = moved(selection.focus)
                if anchor.row < 0 || focus.row < 0 { clearSelection() } else { content.selection = (anchor: anchor, focus: focus) }
            } else {
                clearSelection()
            }
        }
        content.setHistory(new)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        relayout()
    }

    private func relayout() {
        let available = bounds.width - adjustedContentInset.left - adjustedContentInset.right
        let effective = userFontSize > 0 ? userFontSize : (fitMode ? TerminalMetrics.fitDefaultSize : TerminalMetrics.fittingSize(cols: content.grid.cols, width: available))
        if content.metrics.size != effective {
            // A new text size (A−/A+, fit, a rotation in fit-to-width) changes the row height, not the rows: scrolled up,
            // the same row (and the same part of it) stays at the top of the view.
            let oldLine = content.metrics.lineHeight
            content.metrics = TerminalMetrics(size: effective)
            let newLine = content.metrics.lineHeight
            if !stickToBottom, oldLine > 0, newLine > 0 { pendingTop = (pendingTop ?? contentOffset.y) / oldLine * newLine }
        }
        if reportedFontSize != effective {
            reportedFontSize = effective
            Task { @MainActor [weak self] in self?.onEffectiveFontSize?(Double(effective)) } // after SwiftUI's update, not during it
        }
        reportDeviceGrid(availableWidth: available)
        let gridSize = content.gridSize
        // The history rows, then herdr's taller live screen down to its last row with content (blank rows below are not
        // scrollable); in forwarding mode (no history) a swipe moves this window first and goes to the program at its edges.
        let height = max(content.liveTop + min(gridSize.height, contentBottom), bounds.height)
        let size = CGSize(width: max(gridSize.width, bounds.width), height: height)
        if contentSize != size { contentSize = size }
        let userScrolling = isTracking || isDragging || isDecelerating
        if let top = pendingTop, bounds.height > 0 {
            pendingTop = nil
            if !stickToBottom { setContentOffset(CGPoint(x: contentOffset.x, y: min(maxOffsetY, max(0, top))), animated: false) }
        } else if !stickToBottom, !userScrolling, !animatingToLive, contentOffset.y > maxOffsetY {
            setContentOffset(CGPoint(x: contentOffset.x, y: maxOffsetY), animated: false) // the content got shorter (a reset)
        }
        // Left at the live bottom by the above (a shorter history, a kept place that is now the bottom): follow it from
        // here, as Android does by judging "at the bottom" afresh on every change.
        if !stickToBottom, !userScrolling, !animatingToLive, contentOffset.y >= liveBottomY - 0.5 { stickToBottom = true }
        if stickToBottom, !userScrolling, !animatingToLive, contentOffset.y != liveBottomY {
            setContentOffset(CGPoint(x: contentOffset.x, y: liveBottomY), animated: false) // live screen taller than the view: follow the prompt
        }
        positionContent()
    }

    /// The grid view is viewport-sized and pinned to the visible area; it draws the rows under `contentOffset`.
    private func positionContent() {
        let frame = CGRect(origin: contentOffset, size: bounds.size)
        if content.frame != frame { content.frame = frame }
        content.origin = contentOffset
        reportScrolledUp()
    }

    /// "Live ↓" shows while the view is more than about a row above the live bottom (never in forwarding mode).
    private func reportScrolledUp() {
        let line = content.metrics.lineHeight
        let up = !forwardScroll && !stickToBottom && line > 0 && liveBottomY - contentOffset.y > line
        guard up != reportedScrolledUp else { return }
        reportedScrolledUp = up
        Task { @MainActor [weak self] in self?.onScrolledUp?(up) } // after SwiftUI's update, not during it
    }

    /// Back to the live bottom (animated), following it from then on.
    func scrollToLive() {
        stickToBottom = true
        pendingTop = nil
        liveAnchor = nil
        reportScrolledUp()
        let target = CGPoint(x: contentOffset.x, y: liveBottomY)
        guard abs(contentOffset.y - target.y) > 0.5 else { return }
        animatingToLive = true
        setContentOffset(target, animated: true)
    }

    func scrollViewDidEndScrollingAnimation(_ scrollView: UIScrollView) {
        guard animatingToLive else { return }
        animatingToLive = false
        relayout() // the bottom may have moved while the animation ran
    }

    /// Whether the window over the live screen cannot move further that way, so a swipe there is for the program.
    private func atEdge(towardBottom: Bool) -> Bool {
        towardBottom ? contentOffset.y >= maxOffsetY - 0.5 : contentOffset.y <= 0.5
    }

    /// Height of the live rows up to and including the last one with anything on it.
    private var contentBottom: CGFloat {
        CGFloat((content.grid.lastContentRow ?? -1) + 1) * content.metrics.lineHeight
    }

    /// Where "the bottom" is: the live screen's last row with content. herdr's grid is taller than this view, so a
    /// fresh shell (prompt on row 1, 60 blank rows below) shows its top (under the history, if any), while Claude
    /// Code (status bar on the last row) shows its bottom.
    private var liveBottomY: CGFloat {
        min(maxOffsetY, max(0, content.liveTop + contentBottom - bounds.height))
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

    // MARK: Scrollback gestures

    func scrollViewWillBeginDragging(_ scrollView: UIScrollView) {
        liveAnchor = nil // the finger decides where the view is now
        clearSelection()
        edgeInertia = 0
        animatingToLive = false // the finger took over from "Live ↓"
    }

    func scrollViewDidScroll(_ scrollView: UIScrollView) {
        // Only the user's own scrolling (a drag or its deceleration) decides whether the window keeps following the
        // bottom; programmatic offsets (the pin itself, keeping the rows on screen in place) do not.
        let line = content.metrics.lineHeight
        if isTracking || isDragging || isDecelerating, line > 0 {
            let y = contentOffset.y
            stickToBottom = y >= liveBottomY - line / 2
            if !forwardScroll {
                if y >= 0 { pullLatched = false }
                if y < -line * 2, !pullLatched {
                    pullLatched = true
                    onPullTop?() // the model says why when the pane holds no history
                }
            }
        }
        positionContent()
    }

    func scrollViewWillEndDragging(_ scrollView: UIScrollView, withVelocity velocity: CGPoint, targetContentOffset: UnsafeMutablePointer<CGPoint>) {
        edgeInertia = 0
        guard forwardScroll, velocity.y != 0 else { return }
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
        guard v != 0, line > 0, forwardScroll, atEdge(towardBottom: v > 0) else { return }
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
            guard let cell = content.cell(at: point), let word = content.wordRange(at: cell) else { return }
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
        let rows = content.totalRows
        let cols = content.grid.cols
        guard rows > 0, cols > 0 else { return }
        content.selection = (anchor: GridPosition(row: 0, col: 0), focus: GridPosition(row: rows - 1, col: cols - 1))
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
